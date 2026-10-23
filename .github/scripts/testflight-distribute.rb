#!/usr/bin/env ruby

require_relative "lib/app-store-connect"

key_id = required_env("ASC_KEY_ID")
issuer_id = required_env("ASC_ISSUER_ID")
private_key = required_env("ASC_PRIVATE_KEY")
app_id = required_env("ASC_APP_ID")
build_number = required_env("TESTFLIGHT_BUILD_NUMBER")
group_ids = required_env("TESTFLIGHT_GROUP_IDS").split(",").map(&:strip).reject(&:empty?)
poll_interval = Integer(ENV.fetch("TESTFLIGHT_POLL_INTERVAL_SECONDS", "30"))
timeout_seconds = Integer(ENV.fetch("TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS", "1800"))

client = AppStoreConnectClient.new(user_agent: "shogo-ios-testflight-distributor") { app_store_connect_token(key_id, issuer_id, private_key) }
deadline = Time.now + timeout_seconds
build = nil

puts "Waiting for App Store Connect to finish processing build #{build_number}..."
loop do
  # /v1/apps/{id}/builds rejects sort and filter parameters; /v1/builds
  # supports filtering by app and build number directly.
  query = URI.encode_www_form(
    [["filter[app]", app_id], ["filter[version]", build_number], ["limit", "10"]],
  )
  build = client.get("/v1/builds?#{query}").fetch("data", []).first

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
