module PreservationImport
  class Runner
    TAG_SETTERS = {
      "Rating" => :rating_string=,
      "ArchiveWarning" => :archive_warning_strings=,
      "Category" => :category_strings=,
      "Fandom" => :fandom_strings=,
      "Relationship" => :relationship_strings=,
      "Character" => :character_strings=,
      "Freeform" => :freeform_strings=
    }.freeze

    TAG_ALIASES = {
      "ArchiveWarning" => {
        "Creator Chose Not To Use Archive Warnings" => ArchiveConfig.WARNING_DEFAULT_TAG_NAME
      }
    }.freeze

    def initialize(package_path:, archivist_login:, dry_run: false)
      @reader = PackageReader.new(package_path)
      @archivist = User.find_by!(login: archivist_login)
      @dry_run = dry_run
    end

    def call
      existing_run = PreservationImportRun.find_by(package_id: @reader.manifest.fetch("packageId"))
      return existing_run if existing_run&.status == "completed" && existing_run.works_failed.zero?
      verify_previous_package!

      @run = existing_run || PreservationImportRun.create!(
        package_id: @reader.manifest.fetch("packageId"),
        package_path: @reader.path.to_s,
        status: "running"
      )
      @run.update!(status: "running", works_failed: 0, error_message: nil, completed_at: nil) if existing_run
      @notifier = CollectorNotifier.new(package_id: @reader.manifest.fetch("packageId"), run_id: @run.id)
      @notifier.mark("importing") unless @dry_run
      load_package_indexes
      @source = PreservationSource.find_or_create_by!(key: @reader.manifest.dig("source", "key")) do |source|
        source.origin = @reader.manifest.dig("source", "origin")
      end
      import_authors
      @reader.each_record("works.jsonl") { |record| import_work_safely(record) }
      import_series
      final_status = @dry_run ? "verified" : (@run.works_failed.zero? ? "completed" : "partial")
      @run.update!(status: final_status, completed_at: Time.current)
      unless @dry_run
        if final_status == "completed"
          @notifier&.mark("imported")
        else
          @notifier&.mark("failed", error: "#{@run.works_failed} works failed to import")
        end
      end
      @run
    rescue StandardError => e
      @run&.update!(status: "failed", error_message: "#{e.class}: #{e.message}", completed_at: Time.current)
      @notifier&.mark("failed", error: "#{e.class}: #{e.message}") unless @dry_run
      raise
    end

    private

    def verify_previous_package!
      previous_id = @reader.manifest["previousPackageId"]
      return if previous_id.blank?
      return if PreservationImportRun.exists?(package_id: previous_id, status: "completed")

      raise InvalidPackage, "Previous package #{previous_id} has not been imported successfully"
    end

    def load_package_indexes
      @authors = @reader.records_by("authors.jsonl", "sourceAuthorId")
      @tags = @reader.records_by("tags.jsonl", "sourceTagId")
      @chapters_by_work = @reader.each_record("chapters.jsonl").group_by { |row| row.fetch("sourceWorkId") }
      @work_authors = @reader.each_record("work-authors.jsonl").group_by { |row| row.fetch("sourceWorkId") }
      @work_tags = @reader.each_record("work-tags.jsonl").group_by { |row| row.fetch("sourceWorkId") }
      @series_works = @reader.each_record("series-works.jsonl").group_by { |row| row.fetch("sourceSeriesId") }
    end

    def import_authors
      @author_identities = {}
      @authors.each_value do |row|
        identity = PreservationAuthorIdentity.find_or_initialize_by(
          preservation_source: @source,
          source_author_id: row.fetch("sourceAuthorId")
        )
        identity.assign_attributes(
          display_name: row.fetch("name"),
          profile_url: row["profileUrl"],
          anonymous: row.fetch("anonymous"),
          orphaned: row.fetch("orphaned")
        )
        identity.save! unless @dry_run
        @author_identities[row.fetch("sourceAuthorId")] = identity
      end
    end

    def import_work_safely(row)
      ActiveRecord::Base.transaction(requires_new: true) { import_work(row) }
    rescue StandardError => e
      @run.increment!(:works_failed)
      Rails.logger.error("Preservation import failed for work #{row['sourceWorkId']}: #{e.class}: #{e.message}")
    end

    def import_work(row)
      source_work_id = row.fetch("sourceWorkId")
      link = PreservationWorkLink.find_by(preservation_source: @source, source_work_id: source_work_id)

      if link&.imported_hash == row.fetch("contentHash")
        @run.increment!(:works_skipped)
        return
      end

      raise InvalidPackage, "Cannot hide unknown work #{source_work_id}" if row.fetch("operation") == "hide" && link.nil?
      if row.fetch("operation") == "hide"
        link.work.update!(hidden_by_admin: true) unless @dry_run
        link.update!(imported_hash: row.fetch("contentHash"), last_imported_at: Time.current) unless @dry_run
        @run.increment!(:works_updated)
        return
      end

      creating = link.nil?
      work = link&.work || Work.new
      apply_work_attributes(work, row)
      apply_tags(work, source_work_id)
      chapter_rows = Array(@chapters_by_work[source_work_id]).sort_by { |chapter| chapter.fetch("position") }
      raise InvalidPackage, "Work #{source_work_id} has no chapters" if chapter_rows.empty?

      if creating
        build_new_chapters(work, chapter_rows)
        add_archival_creatorships(work)
      else
        reconcile_chapters(link, work, chapter_rows)
      end

      validate_only!(work) if @dry_run
      unless @dry_run
        work.save!
        link ||= PreservationWorkLink.create!(
          preservation_source: @source,
          work: work,
          source_work_id: source_work_id,
          source_url: row.fetch("sourceUrl"),
          imported_hash: row.fetch("contentHash"),
          source_updated_at: row["updatedAt"],
          last_imported_at: Time.current
        )
        link.update!(
          source_url: row.fetch("sourceUrl"), imported_hash: row.fetch("contentHash"),
          source_updated_at: row["updatedAt"], last_imported_at: Time.current
        ) unless creating
        create_chapter_links(link, chapter_rows)
        reconcile_source_authors(link, source_work_id)
      end
      @run.increment!(creating ? :works_created : :works_updated)
    end

    def apply_work_attributes(work, row)
      work.assign_attributes(
        title: row.fetch("title"), summary: row.fetch("summaryHtml"), notes: row.fetch("notesHtml"),
        endnotes: row.fetch("endNotesHtml"), complete: row.fetch("complete"),
        restricted: true, posted: true, imported_from_url: row.fetch("sourceUrl"),
        expected_number_of_chapters: row["expectedChapters"], word_count: row["words"],
        revised_at: row["updatedAt"]
      )
      work.language = Language.find_by(short: row.fetch("languageCode")) || Language.default
    end

    def apply_tags(work, source_work_id)
      grouped = Array(@work_tags[source_work_id])
        .sort_by { |relation| relation.fetch("position") }
        .map { |relation| @tags.fetch(relation.fetch("sourceTagId")) }
        .group_by { |tag| tag.fetch("type") }
      grouped["Rating"] ||= [{ "name" => ArchiveConfig.RATING_DEFAULT_TAG_NAME }]
      grouped["ArchiveWarning"] ||= [{ "name" => ArchiveConfig.WARNING_DEFAULT_TAG_NAME }]
      grouped["Fandom"] ||= [{ "name" => ArchiveConfig.FANDOM_NO_TAG_NAME }]
      TAG_SETTERS.each do |type, setter|
        names = Array(grouped[type]).map { |tag| tag.fetch("name") }
        names.map! { |name| TAG_ALIASES.fetch(type, {}).fetch(name, name) }
        work.public_send(setter, names)
      end
    end

    def chapter_attributes(row)
      {
        position: row.fetch("position"), title: row.fetch("title"), summary: row.fetch("summaryHtml"),
        notes: row.fetch("notesHtml"), content: row.fetch("contentHtml"), endnotes: row.fetch("endNotesHtml"),
        published_at: row["publishedAt"], word_count: row["wordCount"], posted: true
      }
    end

    def build_new_chapters(work, chapter_rows)
      chapter_rows.each { |row| work.chapters.build(chapter_attributes(row)) }
    end

    def add_archival_creatorships(work)
      pseud = @archivist.default_pseud
      work.creatorships.build(pseud: pseud)
      work.chapters.each { |chapter| chapter.creatorships.build(pseud: pseud) }
    end

    def reconcile_chapters(link, work, chapter_rows)
      wanted_ids = chapter_rows.map { |row| row.fetch("sourceChapterId") }
      link.preservation_chapter_links.where.not(source_chapter_id: wanted_ids).find_each do |chapter_link|
        chapter_link.chapter.destroy! unless @dry_run
      end
      pseud = @archivist.default_pseud
      chapter_rows.each do |row|
        chapter_link = link.preservation_chapter_links.find_by(source_chapter_id: row.fetch("sourceChapterId"))
        next if chapter_link&.imported_hash == row.fetch("contentHash")
        chapter = chapter_link&.chapter || work.chapters.build
        chapter.assign_attributes(chapter_attributes(row))
        chapter.creatorships.build(pseud: pseud) if chapter.creatorships.empty?
        chapter.save! unless @dry_run
      end
    end

    def create_chapter_links(link, chapter_rows)
      chapter_rows.each do |row|
        chapter = link.work.chapters.find_by!(position: row.fetch("position"))
        chapter_link = link.preservation_chapter_links.find_or_initialize_by(source_chapter_id: row.fetch("sourceChapterId"))
        chapter_link.update!(chapter: chapter, imported_hash: row.fetch("contentHash"))
      end
    end

    def reconcile_source_authors(link, source_work_id)
      link.preservation_work_authors.delete_all
      Array(@work_authors[source_work_id]).sort_by { |row| row.fetch("position") }.each do |row|
        link.preservation_work_authors.create!(
          preservation_author_identity: @author_identities.fetch(row.fetch("sourceAuthorId")),
          position: row.fetch("position")
        )
      end
      Rails.cache.delete(["byline_data", link.work.cache_key])
    end

    def import_series
      @reader.each_record("series.jsonl") do |row|
        ActiveRecord::Base.transaction(requires_new: true) do
          source_series_id = row.fetch("sourceSeriesId")
          relations = Array(@series_works[source_series_id]).sort_by { |relation| relation.fetch("position") }
          raise InvalidPackage, "Series #{source_series_id} has no works in the package" if relations.empty?

          link = PreservationSeriesLink.find_by(preservation_source: @source, source_series_id: source_series_id)
          series = link&.series || Series.new
          series.assign_attributes(
            title: row.fetch("name"), summary: row.fetch("summaryHtml"),
            complete: row["complete"] || false
          )
          if series.creatorships.empty?
            series.creatorships.build(pseud: @archivist.default_pseud, approved: true)
          end
          if @dry_run
            raise InvalidPackage, series.errors.full_messages.join("; ") unless series.valid?
            raise ActiveRecord::Rollback
          end

          series.save!
          link ||= PreservationSeriesLink.create!(
            preservation_source: @source, series: series,
            source_series_id: source_series_id, source_url: row.fetch("sourceUrl")
          )
          link.update!(source_url: row.fetch("sourceUrl"))

          desired_work_ids = relations.map do |relation|
            work_link = PreservationWorkLink.find_by!(
              preservation_source: @source,
              source_work_id: relation.fetch("sourceWorkId")
            )
            serial_work = series.serial_works.find_or_initialize_by(work: work_link.work)
            serial_work.position = relation.fetch("position")
            serial_work.save!
            work_link.work_id
          end
          series.serial_works.where.not(work_id: desired_work_ids).destroy_all
        end
      end
    end

    def validate_only!(work)
      work.valid?
      errors = work.errors.full_messages + work.chapters.flat_map { |chapter| chapter.valid? ? [] : chapter.errors.full_messages }
      raise InvalidPackage, errors.join("; ") if errors.any?
      raise ActiveRecord::Rollback
    end
  end
end
