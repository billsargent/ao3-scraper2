require "spec_helper"

RSpec.describe "Collector package to OTW Archive" do
  let!(:archivist) { create(:user) }
  let(:package_path) { Pathname.new(ENV.fetch("PRESERVATION_E2E_PACKAGE")) }

  it "imports the MariaDB-exported package as native OTW records" do
    reader = PreservationImport::PackageReader.new(package_path)
    source_work = reader.each_record("works.jsonl").first
    source_chapters = reader.each_record("chapters.jsonl").to_a

    run = PreservationImport::Runner.new(
      package_path: package_path,
      archivist_login: archivist.login
    ).call
    link = PreservationWorkLink.find_by!(source_work_id: source_work.fetch("sourceWorkId"))

    expect(run.status).to eq("completed")
    expect(link.work.title).to eq(source_work.fetch("title"))
    expect(link.work.chapters.order(:position).count).to eq(source_chapters.count)
    expect(link.work.chapters.order(:position).pluck(:content)).to all(be_present)
    expect(link.preservation_author_identities).to be_present
    expect(link.work.tags).to be_present
  end
end
