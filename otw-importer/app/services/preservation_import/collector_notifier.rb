require "json"
require "net/http"
require "uri"

module PreservationImport
  class CollectorNotifier
    def initialize(package_id:, run_id: nil)
      @package_id = package_id
      @run_id = run_id
      @base_url = ENV["COLLECTOR_CALLBACK_URL"].presence
      @token = ENV["COLLECTOR_API_TOKEN"].presence
    end

    def enabled?
      @base_url.present?
    end

    def mark(status, error: nil)
      return true unless enabled?

      uri = URI.join(@base_url.end_with?("/") ? @base_url : "#{@base_url}/", "api/exports/by-package/#{@package_id}/import-status")
      request = Net::HTTP::Patch.new(uri)
      request["Content-Type"] = "application/json"
      request["Authorization"] = "Bearer #{@token}" if @token
      request.body = {
        status: status,
        error: error,
        otwImportRunId: @run_id&.to_s
      }.compact.to_json
      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https", open_timeout: 5, read_timeout: 10) do |http|
        http.request(request)
      end
      return true if response.is_a?(Net::HTTPSuccess)

      Rails.logger.warn("Collector import-status callback returned HTTP #{response.code} for package #{@package_id}")
      false
    rescue StandardError => e
      Rails.logger.warn("Collector import-status callback failed for package #{@package_id}: #{e.class}: #{e.message}")
      false
    end
  end
end
