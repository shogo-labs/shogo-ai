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
