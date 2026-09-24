#!/usr/bin/env ruby

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
  def initialize(token)
    @token = token
  end

  def get(path)
    request(Net::HTTP::Get, path)
  end

  def post(path, body)
    request(Net::HTTP::Post, path, body)
  end

  private

  def request(request_class, path, body = nil)
    uri = URI("#{BASE_URL}#{path}")
    request = request_class.new(uri)
    request["Authorization"] = "Bearer #{@token}"
    request["Content-Type"] = "application/json"
    request["Accept"] = "application/json"
    request["User-Agent"] = "shogo-ios-testflight-distributor"
    request.body = JSON.generate(body) if body

    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true) do |http|
      http.request(request)
    end
    parsed_body = response.body.to_s.empty? ? {} : JSON.parse(response.body)
    return parsed_body if response.is_a?(Net::HTTPSuccess)

    raise AppStoreConnectError.new(response.code.to_i, JSON.generate(parsed_body))
  end
end

key_id = required_env("ASC_KEY_ID")
issuer_id = required_env("ASC_ISSUER_ID")
private_key = required_env("ASC_PRIVATE_KEY")
app_id = required_env("ASC_APP_ID")
build_number = required_env("TESTFLIGHT_BUILD_NUMBER")
group_ids = required_env("TESTFLIGHT_GROUP_IDS").split(",").map(&:strip).reject(&:empty?)
poll_interval = Integer(ENV.fetch("TESTFLIGHT_POLL_INTERVAL_SECONDS", "30"))
timeout_seconds = Integer(ENV.fetch("TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS", "1800"))

token = app_store_connect_token(key_id, issuer_id, private_key)
client = AppStoreConnectClient.new(token)
deadline = Time.now + timeout_seconds
build = nil

puts "Waiting for App Store Connect to finish processing build #{build_number}..."
loop do
  query = URI.encode_www_form(
    [["sort", "-uploadedDate"], ["limit", "50"]],
  )
  response = client.get("/v1/apps/#{app_id}/builds?#{query}")
  build = response.fetch("data", []).find do |candidate|
    candidate.dig("attributes", "version").to_s == build_number
  end

  if build.nil?
    abort "::error::Build #{build_number} was not found in App Store Connect." if Time.now >= deadline
    sleep poll_interval
    next
  end

  state = build.dig("attributes", "processingState").to_s
  puts "Build #{build_number} processing state: #{state}"
  break if state == "VALID"

  if %w[FAILED INVALID].include?(state)
    abort "::error::App Store Connect rejected build #{build_number} with processing state #{state}."
  end

  abort "::error::Timed out waiting for build #{build_number} to finish processing." if Time.now >= deadline
  sleep poll_interval
end

build_id = build.fetch("id")
existing_groups = client
  .get("/v1/builds/#{build_id}/betaGroups?limit=200")
  .fetch("data", [])
  .map { |group| group.fetch("id") }

group_ids.each do |group_id|
  if existing_groups.include?(group_id)
    puts "Build #{build_number} is already assigned to TestFlight group #{group_id}."
    next
  end

  client.post(
    "/v1/betaGroups/#{group_id}/relationships/builds",
    { data: [{ type: "builds", id: build_id }] },
  )
  puts "Assigned build #{build_number} to TestFlight group #{group_id}."
end

if ENV["GITHUB_STEP_SUMMARY"]
  File.open(ENV["GITHUB_STEP_SUMMARY"], "a") do |summary|
    summary.puts "## TestFlight distribution"
    summary.puts
    summary.puts "- **Build:** `#{build_number}`"
    summary.puts "- **Processing:** `VALID`"
    summary.puts "- **Groups:** #{group_ids.join(", ")}"
  end
end
