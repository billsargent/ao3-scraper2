require "spec_helper"

RSpec.describe PreservationImport::PackageReader do
  let(:package_path) { Rails.root.join("tmp", "preservation-package-spec") }
  let(:fixture_path) { Pathname.new(ENV.fetch("PRESERVATION_FIXTURE_PACKAGE")) }

  before do
    FileUtils.rm_rf(package_path)
    FileUtils.cp_r(fixture_path, package_path)
  end

  after { FileUtils.rm_rf(package_path) }

  it "validates and streams a TypeScript-generated package" do
    reader = described_class.new(package_path)
    expect(reader.manifest.fetch("formatVersion")).to eq(1)
    expect(reader.each_record("works.jsonl").first.fetch("sourceWorkId")).to eq("12345")
  end

  it "rejects modified package contents" do
    File.open(package_path.join("works.jsonl"), "a") { |file| file.puts("{}") }
    expect { described_class.new(package_path) }.to raise_error(PreservationImport::InvalidPackage, /Checksum mismatch/)
  end
end
