#!/usr/bin/env ruby
# Waits for an already-uploaded build to finish processing in App Store
# Connect, then attaches it to the TestFlight groups.
#
# Every fact about the build comes from the IPA itself — its bundle id, its
# CFBundleVersion — never from GITHUB_RUN_NUMBER. Polling a build number that
# was never uploaded is indistinguishable from "Apple is slow", which is how
# four releases died at a 2 hour timeout claiming "Build 982 was not found"
# (SHO-282). A wrong app record or a build that landed somewhere else now fails
# fast, naming the app it queried and the builds that do exist.

require_relative "lib/app-store-connect"
require_relative "lib/ios-app"

key_id = required_env("ASC_KEY_ID")
issuer_id = required_env("ASC_ISSUER_ID")
private_key = required_env("ASC_PRIVATE_KEY")
configured_app_id = ENV["ASC_APP_ID"].to_s
bundle_id = ENV["TESTFLIGHT_BUNDLE_ID"].to_s
bundle_id = "ai.shogo.app" if bundle_id.empty?
expected_build_number = required_env("TESTFLIGHT_BUILD_NUMBER")
group_ids = required_env("TESTFLIGHT_GROUP_IDS").split(",").map(&:strip).reject(&:empty?)
poll_interval = Integer(ENV.fetch("TESTFLIGHT_POLL_INTERVAL_SECONDS", "30"))
timeout_seconds = Integer(ENV.fetch("TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS", "1800"))
grace_seconds = Integer(ENV.fetch("TESTFLIGHT_GRACE_SECONDS", "900"))
ipa_path = ENV["TESTFLIGHT_IPA_PATH"].to_s

info = nil
if !ipa_path.empty? && File.file?(ipa_path)
  info = IosApp.read_ipa(ipa_path)
  puts "IPA #{ipa_path}"
  puts "  CFBundleIdentifier:          #{info.bundle_id}"
  puts "  CFBundleShortVersionString:  #{info.short_version}"
  puts "  CFBundleVersion:             #{info.build_number}"
else
  puts "No IPA available (TESTFLIGHT_IPA_PATH is #{ipa_path.empty? ? 'unset' : ipa_path}); trusting TESTFLIGHT_BUILD_NUMBER."
end

release = IosApp.release(info, expected_build_number: expected_build_number, fallback_bundle_id: bundle_id)
build_number = release.build_number
bundle_id = release.bundle_id
short_version = release.short_version

if release.mismatch?
  puts "::warning::The IPA's CFBundleVersion is #{info.build_number} but the workflow expected " \
       "#{expected_build_number}. App Store Connect is queried with the IPA's value."
end

summary_lines = [
  "**Bundle id:** `#{bundle_id}`",
  "**Marketing version:** `#{short_version || 'unknown'}`",
  "**Build (from the IPA):** `#{build_number}`",
]
summary_lines << "**Build (expected by the workflow):** `#{expected_build_number}`" if release.mismatch?

begin
  client = AppStoreConnectClient.new(user_agent: "shogo-ios-testflight-distributor") do
    app_store_connect_token(key_id, issuer_id, private_key)
  end

  app, warnings = resolve_app_for_bundle(client, bundle_id, configured_app_id)
  warnings.each { |warning| puts "::warning::#{warning}" }
  puts "Distributing build #{build_number} to #{app.name} (#{app.bundle_id}, id #{app.id})."
  summary_lines << "**App:** #{app.name} (`#{app.id}`)"

  build = wait_for_build(
    client,
    app,
    build_number,
    poll_interval: poll_interval,
    timeout_seconds: timeout_seconds,
    grace_seconds: grace_seconds,
  )

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

  summary_lines << "**Processing:** `VALID`"
  summary_lines << "**Groups:** #{group_ids.join(', ')}"
rescue ReleaseConfigError => error
  puts "::error::#{error.message}"
  summary_lines << "**Result:** failed — #{error.message.lines.first.strip}"
  write_summary(summary_lines, "TestFlight distribution")
  exit 1
end

write_summary(summary_lines, "TestFlight distribution")
