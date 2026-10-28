#!/usr/bin/env ruby
# Submits an already-uploaded, processed build for App Store review:
#   1. find the build by build number (waits until it is VALID)
#   2. find or create the editable App Store version for APP_VERSION
#   3. attach the build and fill any empty "What's New" text
#   4. create (or reuse) a review submission and submit it
#
# Safe to re-run: a version already waiting for or in review with this build
# exits successfully, and a draft submission left by a failed run is reused.
# The API key must have the App Manager (or Admin) role.

require_relative "lib/app-store-connect"

EDITABLE_STATES = %w[
  PREPARE_FOR_SUBMISSION
  DEVELOPER_REJECTED
  REJECTED
  METADATA_REJECTED
  INVALID_BINARY
].freeze
SUBMITTED_STATES = %w[WAITING_FOR_REVIEW IN_REVIEW PENDING_APPLE_RELEASE PENDING_DEVELOPER_RELEASE].freeze
OPEN_SUBMISSION_STATES = %w[READY_FOR_REVIEW].freeze
ACTIVE_SUBMISSION_STATES = %w[WAITING_FOR_REVIEW IN_REVIEW UNRESOLVED_ISSUES].freeze
WHATS_NEW_LIMIT = 4000

key_id = required_env("ASC_KEY_ID")
issuer_id = required_env("ASC_ISSUER_ID")
private_key = required_env("ASC_PRIVATE_KEY")
app_id = required_env("ASC_APP_ID")
build_number = required_env("APP_STORE_BUILD_NUMBER")
version_string = required_env("APP_VERSION")
whats_new = ENV.fetch("APP_STORE_WHATS_NEW", "").strip
whats_new = "Bug fixes and improvements." if whats_new.empty?
whats_new = whats_new[0, WHATS_NEW_LIMIT]
poll_interval = Integer(ENV.fetch("APP_STORE_POLL_INTERVAL_SECONDS", "30"))
timeout_seconds = Integer(ENV.fetch("APP_STORE_PROCESSING_TIMEOUT_SECONDS", "1800"))

client = AppStoreConnectClient.new(user_agent: "shogo-ios-app-store-review") do
  app_store_connect_token(key_id, issuer_id, private_key)
end

def version_state(version)
  attrs = version.fetch("attributes", {})
  (attrs["appVersionState"] || attrs["appStoreState"]).to_s
end

def summary(lines)
  return unless ENV["GITHUB_STEP_SUMMARY"]

  File.open(ENV["GITHUB_STEP_SUMMARY"], "a") do |file|
    file.puts "## App Store review"
    file.puts
    lines.each { |line| file.puts "- #{line}" }
  end
end

begin
  # 1. Build ------------------------------------------------------------------
  deadline = Time.now + timeout_seconds
  build = nil
  loop do
    query = URI.encode_www_form(
      [["filter[app]", app_id], ["filter[version]", build_number], ["limit", "10"]],
    )
    build = client.get("/v1/builds?#{query}").fetch("data", []).first
    state = build&.dig("attributes", "processingState").to_s
    puts "Build #{build_number} processing state: #{state.empty? ? "not found yet" : state}"
    break if state == "VALID"
    abort "::error::Build #{build_number} has processing state #{state}; it cannot be submitted." if %w[FAILED INVALID].include?(state)
    abort "::error::Timed out waiting for build #{build_number} to become VALID." if Time.now >= deadline

    sleep poll_interval
  end
  build_id = build.fetch("id")

  # 2. App Store version ------------------------------------------------------
  versions = client
    .get("/v1/apps/#{app_id}/appStoreVersions?filter[platform]=IOS&limit=50")
    .fetch("data", [])

  same = versions.find { |v| v.dig("attributes", "versionString") == version_string }
  if same && SUBMITTED_STATES.include?(version_state(same))
    attached = client.get("/v1/appStoreVersions/#{same.fetch("id")}/build").dig("data", "id")
    if attached == build_id
      puts "Version #{version_string} is already #{version_state(same)} with build #{build_number}; nothing to do."
      summary(["**Version:** #{version_string}", "**Build:** #{build_number}", "**State:** #{version_state(same)} (already submitted)"])
      exit 0
    end
    abort "::error::Version #{version_string} is already #{version_state(same)} with a different build. " \
          "Remove it from review in App Store Connect, or release under a new version number."
  end
  if same && !EDITABLE_STATES.include?(version_state(same))
    abort "::error::Version #{version_string} already exists in state #{version_state(same)}. Bump the version to release again."
  end

  version = same || versions.find { |v| EDITABLE_STATES.include?(version_state(v)) }
  if version.nil?
    in_review = versions.find { |v| SUBMITTED_STATES.include?(version_state(v)) }
    if in_review
      abort "::error::Version #{in_review.dig("attributes", "versionString")} is #{version_state(in_review)}. " \
            "Apple allows one version in review at a time; release or withdraw it, then re-run this job."
    end
    version = client.post(
      "/v1/appStoreVersions",
      {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: version_string },
          relationships: { app: { data: { type: "apps", id: app_id } } },
        },
      },
    ).fetch("data")
    puts "Created App Store version #{version_string}."
  elsif version.dig("attributes", "versionString") != version_string
    old = version.dig("attributes", "versionString")
    version = client.patch(
      "/v1/appStoreVersions/#{version.fetch("id")}",
      { data: { type: "appStoreVersions", id: version.fetch("id"), attributes: { versionString: version_string } } },
    ).fetch("data")
    puts "Renamed editable App Store version #{old} to #{version_string}."
  else
    puts "Using existing App Store version #{version_string} (#{version_state(version)})."
  end
  version_id = version.fetch("id")

  # 3. Build + release notes --------------------------------------------------
  client.patch(
    "/v1/appStoreVersions/#{version_id}/relationships/build",
    { data: { type: "builds", id: build_id } },
  )
  puts "Attached build #{build_number} to version #{version_string}."

  localizations = client
    .get("/v1/appStoreVersions/#{version_id}/appStoreVersionLocalizations?limit=50")
    .fetch("data", [])
  localizations.each do |loc|
    next unless loc.dig("attributes", "whatsNew").to_s.strip.empty?

    client.patch(
      "/v1/appStoreVersionLocalizations/#{loc.fetch("id")}",
      { data: { type: "appStoreVersionLocalizations", id: loc.fetch("id"), attributes: { whatsNew: whats_new } } },
    )
    puts "Set What's New for #{loc.dig("attributes", "locale")}."
  end

  # 4. Review submission ------------------------------------------------------
  submissions = client
    .get("/v1/reviewSubmissions?filter[app]=#{app_id}&filter[platform]=IOS&limit=20")
    .fetch("data", [])
  active = submissions.find { |s| ACTIVE_SUBMISSION_STATES.include?(s.dig("attributes", "state")) }
  if active
    abort "::error::Review submission #{active.fetch("id")} is #{active.dig("attributes", "state")}. " \
          "Resolve it in App Store Connect, then re-run this job."
  end

  submission = submissions.find { |s| OPEN_SUBMISSION_STATES.include?(s.dig("attributes", "state")) }
  submission ||= client.post(
    "/v1/reviewSubmissions",
    {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: app_id } } },
      },
    },
  ).fetch("data")
  submission_id = submission.fetch("id")

  items = client.get("/v1/reviewSubmissions/#{submission_id}/items?include=appStoreVersion&limit=50").fetch("data", [])
  unless items.any? { |item| item.dig("relationships", "appStoreVersion", "data", "id") == version_id }
    client.post(
      "/v1/reviewSubmissionItems",
      {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: submission_id } },
            appStoreVersion: { data: { type: "appStoreVersions", id: version_id } },
          },
        },
      },
    )
  end

  result = client.patch(
    "/v1/reviewSubmissions/#{submission_id}",
    { data: { type: "reviewSubmissions", id: submission_id, attributes: { submitted: true } } },
  ).fetch("data")
  state = result.dig("attributes", "state")
  puts "Submitted version #{version_string} (build #{build_number}) for App Store review: #{state}."
  summary([
    "**Version:** #{version_string}",
    "**Build:** #{build_number}",
    "**Submission:** `#{submission_id}` → #{state}",
  ])
rescue AppStoreConnectError => e
  if e.status == 403
    abort "::error::App Store Connect refused the request (HTTP 403). The ASC_KEY_ID API key needs the " \
          "App Manager or Admin role to submit for review. #{e.body}"
  end
  abort "::error::#{e.message}"
end
