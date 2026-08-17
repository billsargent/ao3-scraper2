require "spec_helper"

RSpec.describe PreservationImport::Runner do
  let!(:archivist) { create(:user) }
  let(:package_path) { Pathname.new(ENV.fetch("PRESERVATION_FIXTURE_PACKAGE")) }
  let(:update_package_path) { Pathname.new(ENV.fetch("PRESERVATION_UPDATE_FIXTURE_PACKAGE")) }

  before do
    allow(ArchiveConfig).to receive(:RATING_DEFAULT_TAG_NAME).and_return("Not Rated")
    allow(ArchiveConfig).to receive(:WARNING_DEFAULT_TAG_NAME).and_return("Choose Not To Use Archive Warnings")
    allow(ArchiveConfig).to receive(:FANDOM_NO_TAG_NAME).and_return("No Fandom")
  end

  it "imports a package into native work and chapter records" do
    run = described_class.new(package_path: package_path, archivist_login: archivist.login).call
    link = PreservationWorkLink.find_by!(source_work_id: "12345")

    expect(run.status).to eq("completed")
    expect(run.works_created).to eq(1)
    expect(link.work.title).to eq("Example Work")
    expect(link.work.chapters.count).to eq(1)
    expect(link.work.chapters.first.content).to include("local import test chapter")
    expect(link.preservation_author_identities.pluck(:display_name)).to eq(["ExampleAuthor"])
    expect(link.work.fandoms.pluck(:name)).to include("Example Fandom")
    series_link = PreservationSeriesLink.find_by!(source_series_id: "series:100")
    expect(series_link.series.title).to eq("Example Series")
    expect(series_link.series.works_in_order.pluck(:id)).to eq([link.work.id])
  end

  it "is idempotent for a completed package" do
    first = described_class.new(package_path: package_path, archivist_login: archivist.login).call
    second = described_class.new(package_path: package_path, archivist_login: archivist.login).call

    expect(second.id).to eq(first.id)
    expect(PreservationWorkLink.where(source_work_id: "12345").count).to eq(1)
    expect(Work.where(imported_from_url: "https://archiveofourown.org/works/12345").count).to eq(1)
  end

  it "rejects an incremental package when its predecessor has not been imported" do
    expect {
      described_class.new(package_path: update_package_path, archivist_login: archivist.login).call
    }.to raise_error(PreservationImport::InvalidPackage, /Previous package/)
  end

  it "reconciles a changed work, new chapter, tags, and series without duplication" do
    described_class.new(package_path: package_path, archivist_login: archivist.login).call
    update_run = described_class.new(package_path: update_package_path, archivist_login: archivist.login).call
    link = PreservationWorkLink.find_by!(source_work_id: "12345")

    expect(update_run.works_updated).to eq(1)
    expect(link.work.reload.title).to eq("Example Work Updated")
    expect(link.work.chapters.order(:position).pluck(:position)).to eq([1, 2])
    expect(link.work.chapters.first.content).to include("updated in the second package")
    expect(link.work.freeforms.pluck(:name)).to include("Incremental Update Test")
    expect(PreservationChapterLink.where(preservation_work_link: link).count).to eq(2)
    expect(PreservationSeriesLink.find_by!(source_series_id: "series:100").series.title).to eq("Example Series Updated")
    expect(PreservationWorkLink.where(source_work_id: "12345").count).to eq(1)
  end
end
