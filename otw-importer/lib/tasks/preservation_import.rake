namespace :preservation do
  desc "Verify or import an AO3 off-site transfer package"
  task import: :environment do
    package = ENV.fetch("PACKAGE")
    archivist = ENV.fetch("ARCHIVIST")
    dry_run = ActiveModel::Type::Boolean.new.cast(ENV.fetch("DRY_RUN", "false"))

    run = PreservationImport::Runner.new(
      package_path: package,
      archivist_login: archivist,
      dry_run: dry_run
    ).call
    puts({ package_id: run.package_id, status: run.status, created: run.works_created,
           updated: run.works_updated, skipped: run.works_skipped, failed: run.works_failed }.to_json)
  end
end
