require "spec_helper"

RSpec.describe PreservationImport::CollectorNotifier do
  around do |example|
    old_url = ENV["COLLECTOR_CALLBACK_URL"]
    old_token = ENV["COLLECTOR_API_TOKEN"]
    example.run
  ensure
    ENV["COLLECTOR_CALLBACK_URL"] = old_url
    ENV["COLLECTOR_API_TOKEN"] = old_token
  end

  it "is a no-op when the callback URL is not configured" do
    ENV.delete("COLLECTOR_CALLBACK_URL")
    expect(described_class.new(package_id: "package-1").mark("imported")).to be(true)
  end

  it "reports package import status with authentication and run identity" do
    ENV["COLLECTOR_CALLBACK_URL"] = "https://collector.example/"
    ENV["COLLECTOR_API_TOKEN"] = "secret-token"
    request = stub_request(:patch, "https://collector.example/api/exports/by-package/package-1/import-status")
      .with(
        headers: { "Authorization" => "Bearer secret-token", "Content-Type" => "application/json" },
        body: { status: "imported", otwImportRunId: "42" }.to_json
      ).to_return(status: 200, body: '{"updated":true}')

    expect(described_class.new(package_id: "package-1", run_id: 42).mark("imported")).to be(true)
    expect(request).to have_been_requested.once
  end
end
