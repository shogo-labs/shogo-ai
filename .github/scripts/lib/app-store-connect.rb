# Shared App Store Connect API client for the iOS release scripts.

require "base64"
require "json"
require "net/http"
require "openssl"
require "uri"

BASE_URL = "https://api.appstoreconnect.apple.com".freeze

class AppStoreConnectError < StandardError
  attr_reader :status, :body

  def initialize(status, body)
    @status = status
    @body = body
    super("App Store Connect API returned HTTP #{status}: #{body}")
  end
end

def required_env(name)
  value = ENV[name].to_s
  abort "::error::Missing required environment variable #{name}" if value.empty?
  value
end

def base64url(value)
  Base64.urlsafe_encode64(value, padding: false)
end

def integer_to_bytes(value)
  hex = value.to_i.to_s(16)
  hex = "0#{hex}" if hex.length.odd?
  bytes = [hex].pack("H*")
  abort "::error::Invalid ES256 signature component" if bytes.length > 32
  bytes.rjust(32, "\0")
end

def app_store_connect_token(key_id, issuer_id, private_key_pem)
  header = { alg: "ES256", kid: key_id, typ: "JWT" }
  now = Time.now.to_i
  payload = {
    iss: issuer_id,
    iat: now,
    exp: now + 900,
    aud: "appstoreconnect-v1",
  }
  encoded_header = base64url(JSON.generate(header))
  encoded_payload = base64url(JSON.generate(payload))
  signing_input = "#{encoded_header}.#{encoded_payload}"

  key = OpenSSL::PKey::EC.new(private_key_pem)
  der_signature = key.dsa_sign_asn1(
    OpenSSL::Digest::SHA256.digest(signing_input),
  )
  signature = OpenSSL::ASN1.decode(der_signature).value
  raw_signature = integer_to_bytes(signature[0].value) + integer_to_bytes(signature[1].value)

  "#{signing_input}.#{base64url(raw_signature)}"
end

class AppStoreConnectClient
  # Tokens live 15 minutes but processing can take longer, so mint a fresh
  # one shortly before the current token expires.
  TOKEN_REFRESH_SECONDS = 600

  def initialize(user_agent: "shogo-ios-ci", &token_factory)
    @user_agent = user_agent
    @token_factory = token_factory
    @token = nil
    @token_minted_at = nil
  end

  def get(path)
    request(Net::HTTP::Get, path)
  end

  def post(path, body)
    request(Net::HTTP::Post, path, body)
  end

  def patch(path, body)
    request(Net::HTTP::Patch, path, body)
  end

  private

  def token
    if @token.nil? || Time.now - @token_minted_at > TOKEN_REFRESH_SECONDS
      @token = @token_factory.call
      @token_minted_at = Time.now
    end
    @token
  end

  def request(request_class, path, body = nil)
    uri = URI("#{BASE_URL}#{path}")
    request = request_class.new(uri)
    request["Authorization"] = "Bearer #{token}"
    request["Content-Type"] = "application/json"
    request["Accept"] = "application/json"
    request["User-Agent"] = @user_agent
    request.body = JSON.generate(body) if body

    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) do |http|
      http.request(request)
    end
    parsed_body = response.body.to_s.empty? ? {} : JSON.parse(response.body)
    return parsed_body if response.is_a?(Net::HTTPSuccess)

    raise AppStoreConnectError.new(response.code.to_i, JSON.generate(parsed_body))
  end
end

# Raised when the release configuration cannot possibly succeed (wrong app
# record, a build number that was never uploaded, ...). The message is written
# to be the whole story a human needs in the job log — no "not found" dead ends.
class ReleaseConfigError < StandardError; end

AppStoreApp = Struct.new(:id, :bundle_id, :name)

# Appends a section to the GitHub job summary when running in Actions.
def write_summary(lines, heading)
  path = ENV["GITHUB_STEP_SUMMARY"].to_s
  return if path.empty?

  File.open(path, "a") do |file|
    file.puts "## #{heading}"
    file.puts
    lines.each { |line| file.puts "- #{line}" }
  end
end

# Resolves the app record that owns +bundle_id+, treating the bundle id — not
# the ASC_APP_ID secret — as the source of truth. A stale or mistyped
# ASC_APP_ID filters every build query to zero rows, which is invisible at the
# call site: the upload succeeds, the poll never matches, and the job dies two
# hours later claiming the build "was not found" (SHO-282). Returns the app plus
# human-readable warnings about a disagreeing ASC_APP_ID.
def resolve_app_for_bundle(client, bundle_id, configured_id = nil)
  warnings = []
  matches = client
    .get("/v1/apps?#{URI.encode_www_form([["filter[bundleId]", bundle_id], ["limit", "10"]])}")
    .fetch("data", [])

  configured = configured_id.to_s.strip
  described_configured = nil
  unless configured.empty?
    begin
      item = client.get("/v1/apps/#{configured}").fetch("data", nil)
      described_configured = describe_app(item) if item
    rescue AppStoreConnectError => error
      warnings << "ASC_APP_ID #{configured} could not be read by this API key (HTTP #{error.status}): #{error.body}"
    end
  end

  if matches.empty?
    detail = described_configured ? " ASC_APP_ID #{configured} is #{described_configured}." : ""
    raise ReleaseConfigError,
          "No App Store Connect app record has bundle id #{bundle_id} for this API key.#{detail} " \
          "Check that the app exists in the API key's team and that the IPA was built with the right bundle id."
  end

  app = app_from_api(matches.first)
  if !configured.empty? && configured != app.id
    warnings << "ASC_APP_ID is #{configured}#{described_configured ? " (#{described_configured})" : ''} but bundle id " \
                "#{bundle_id} belongs to #{app.name} (#{app.id}). Using #{app.id}."
  end
  return app, warnings
end

def describe_app(item)
  return nil if item.nil?

  attributes = item.fetch("attributes", {})
  "#{attributes['name']} (#{attributes['bundleId']}, id #{item['id']})"
end

def app_from_api(item)
  attributes = item.fetch("attributes", {})
  AppStoreApp.new(item.fetch("id"), attributes["bundleId"].to_s, attributes["name"].to_s)
end

def find_build(client, app_id, build_number)
  query = URI.encode_www_form(
    [["filter[app]", app_id], ["filter[version]", build_number.to_s], ["limit", "10"]],
  )
  client.get("/v1/builds?#{query}").fetch("data", []).first
end

# Newest builds of one app record. Used only for diagnostics, so it asks for the
# fewest fields App Store Connect will return.
def recent_builds(client, app_id, limit = 10)
  query = URI.encode_www_form(
    [
      ["filter[app]", app_id],
      ["sort", "-uploadedDate"],
      ["limit", limit.to_s],
      ["fields[builds]", "version,processingState,uploadedDate"],
    ],
  )
  client.get("/v1/builds?#{query}").fetch("data", [])
end

def describe_build(build)
  attributes = build.fetch("attributes", {})
  "build #{attributes['version']} — #{attributes['processingState'] || 'unknown state'} " \
    "(uploaded #{attributes['uploadedDate'] || 'unknown'})"
end

def describe_builds(builds)
  return "  (none — this app record has no builds)" if builds.empty?

  builds.map { |build| "  #{describe_build(build)}" }.join("\n")
end

# Waits until +build_number+ exists on +app+ and has finished processing.
# Fails with the actual state of App Store Connect instead of a bare "not
# found": the app it queried, and the builds that do exist there.
def wait_for_build(client, app, build_number, options = {})
  poll_interval = options.fetch(:poll_interval, 30)
  timeout_seconds = options.fetch(:timeout_seconds, 1800)
  grace_seconds = options.fetch(:grace_seconds, 900)
  started_at = Time.now
  deadline = started_at + timeout_seconds
  announced_missing = false

  loop do
    build = find_build(client, app.id, build_number)
    if build
      state = build.dig("attributes", "processingState").to_s
      puts "Build #{build_number} processing state: #{state.empty? ? 'unknown' : state}"
      return build if state == "VALID"
      if %w[FAILED INVALID].include?(state)
        raise ReleaseConfigError,
              "App Store Connect rejected build #{build_number} of #{app.name} with processing state #{state}. " \
              "Apple's reason is in the account's email and in App Store Connect."
      end
      if Time.now >= deadline
        raise ReleaseConfigError,
              "Timed out after #{timeout_seconds}s waiting for build #{build_number} to finish processing " \
              "(state #{state})."
      end
    else
      elapsed = Time.now - started_at
      if Time.now >= deadline
        raise ReleaseConfigError,
              "Timed out after #{timeout_seconds}s: App Store Connect has no build #{build_number} for " \
              "#{app.name} (#{app.bundle_id}, id #{app.id}). Builds that do exist:\n#{describe_builds(recent_builds(client, app.id))}"
      end

      if elapsed >= grace_seconds
        builds = recent_builds(client, app.id)
        unless announced_missing
          announced_missing = true
          puts "App Store Connect has no build #{build_number} for #{app.name} (#{app.bundle_id}, id #{app.id}) " \
               "after #{(elapsed / 60).round} min. Existing builds:"
          puts describe_builds(builds)
        end
        if builds.empty?
          raise ReleaseConfigError,
                "#{app.name} (#{app.bundle_id}, id #{app.id}) has no builds at all after #{(elapsed / 60).round} min, " \
                "so the upload did not land in this app record. Either the ASC API key's team is not the team the " \
                "IPA was uploaded to, or ASC_APP_ID points at the wrong app."
        end
        newest = builds.map { |item| item.dig("attributes", "version") }.compact.map(&:to_i).max
        if newest && newest < build_number.to_i
          raise ReleaseConfigError,
                "#{app.name} (#{app.bundle_id}, id #{app.id}) newest build is #{newest}, but this run uploaded " \
                "#{build_number}. The binary went to a different app record or team than the API key can see — " \
                "ASC_APP_ID / the ASC API key and the altool account must belong to the same team."
        end
      end
    end

    sleep poll_interval
  end
end
