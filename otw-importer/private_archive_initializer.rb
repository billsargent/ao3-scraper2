# Copy to config/initializers/private_archive.rb.
# This profile is intended only for a private, offline preservation instance.
if ENV["OTW_PRIVATE_MODE"] == "true"
  Rails.application.config.action_mailer.perform_deliveries = false

  class PrivateArchiveHeaders
    def initialize(app)
      @app = app
    end

    def call(env)
      status, headers, body = @app.call(env)
      headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet"
      headers["Cache-Control"] = "private, no-store" if env["PATH_INFO"]&.start_with?("/works/")
      [status, headers, body]
    end
  end

  Rails.application.config.middleware.insert_before(0, PrivateArchiveHeaders)
end
