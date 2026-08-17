require "digest"
require "json"
require "pathname"

module PreservationImport
  class InvalidPackage < StandardError; end

  class PackageReader
    DATA_FILES = %w[
      authors.jsonl work-authors.jsonl works.jsonl chapters.jsonl tags.jsonl
      work-tags.jsonl series.jsonl series-works.jsonl observations.jsonl
    ].freeze
    CHECKSUM_FILES = ["manifest.json", *DATA_FILES].freeze
    MANIFEST_COUNT_KEYS = {
      "authors.jsonl" => "authors", "work-authors.jsonl" => "workAuthors",
      "works.jsonl" => "works", "chapters.jsonl" => "chapters",
      "tags.jsonl" => "tags", "work-tags.jsonl" => "workTags",
      "series.jsonl" => "series", "series-works.jsonl" => "seriesWorks",
      "observations.jsonl" => "observations"
    }.freeze

    attr_reader :path, :manifest

    def initialize(path)
      @path = Pathname.new(path).expand_path
      raise InvalidPackage, "Package directory does not exist: #{@path}" unless @path.directory?

      verify_checksums!
      @manifest = JSON.parse(read("manifest.json"))
      validate_manifest!
      validate_record_counts!
    end

    def each_record(file_name)
      raise InvalidPackage, "Unknown package file #{file_name}" unless DATA_FILES.include?(file_name)
      return enum_for(__method__, file_name) unless block_given?

      File.foreach(@path.join(file_name)).with_index(1) do |line, line_number|
        next if line.strip.empty?
        begin
          yield JSON.parse(line)
        rescue JSON::ParserError => e
          raise InvalidPackage, "#{file_name}:#{line_number}: #{e.message}"
        end
      end
    end

    def records_by(file_name, key)
      each_record(file_name).index_by { |record| record.fetch(key) }
    end

    private

    def read(file_name)
      @path.join(file_name).read(encoding: "UTF-8")
    end

    def validate_manifest!
      raise InvalidPackage, "Unsupported package format" unless manifest["format"] == "ao3-offsite-transfer"
      raise InvalidPackage, "Unsupported format version #{manifest['formatVersion']}" unless manifest["formatVersion"] == 1
      raise InvalidPackage, "Missing package ID" if manifest["packageId"].blank?
      raise InvalidPackage, "Missing source" if manifest.dig("source", "key").blank? || manifest.dig("source", "origin").blank?
      if manifest["packageType"] == "snapshot" && manifest["previousPackageId"].present?
        raise InvalidPackage, "Snapshot packages cannot have a predecessor"
      end
      if manifest["packageType"] == "incremental" && manifest["previousPackageId"].blank?
        raise InvalidPackage, "Incremental packages require a predecessor"
      end
    end

    def validate_record_counts!
      declared = manifest.fetch("records") { raise InvalidPackage, "Missing record counts" }
      MANIFEST_COUNT_KEYS.each do |file_name, count_key|
        actual = File.foreach(@path.join(file_name)).count { |line| line.present? }
        expected = declared[count_key]
        raise InvalidPackage, "Missing record count #{count_key}" unless expected.is_a?(Integer)
        raise InvalidPackage, "Record count mismatch for #{file_name}: expected #{expected}, found #{actual}" unless expected == actual
      end
    end

    def verify_checksums!
      checksum_path = @path.join("checksums.sha256")
      raise InvalidPackage, "Missing checksums.sha256" unless checksum_path.file?

      expected = {}
      checksum_path.each_line do |line|
        match = line.strip.match(/\A([a-f0-9]{64})  ([a-z0-9.-]+)\z/)
        raise InvalidPackage, "Invalid checksum line: #{line.inspect}" unless match
        expected[match[2]] = match[1]
      end

      CHECKSUM_FILES.each do |file_name|
        file_path = @path.join(file_name)
        raise InvalidPackage, "Missing #{file_name}" unless file_path.file?
        raise InvalidPackage, "Missing checksum for #{file_name}" unless expected[file_name]
        actual = Digest::SHA256.file(file_path).hexdigest
        raise InvalidPackage, "Checksum mismatch for #{file_name}" unless ActiveSupport::SecurityUtils.secure_compare(expected[file_name], actual)
      end
    end
  end
end
