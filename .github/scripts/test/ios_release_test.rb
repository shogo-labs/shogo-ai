#!/usr/bin/env ruby
# Unit tests for the iOS release scripts (SHO-282).
#
#   ruby .github/scripts/test/ios_release_test.rb
#
# They cover the part that was silently wrong: the identity the pipeline polls
# App Store Connect for, and what it reports when that identity is missing.

require "minitest/autorun"

require_relative "../lib/app-store-connect"
require_relative "../lib/ios-app"

class FakeClient
  attr_reader :paths

  def initialize(&responder)
    @responder = responder
    @paths = []
  end

  def get(path)
    @paths << path
    @responder.call(path)
  end
end

def app_payload(id: "111", bundle_id: "ai.shogo.app", name: "shogo")
  {
    "data" => [
      { "id" => id, "type" => "apps", "attributes" => { "name" => name, "bundleId" => bundle_id } },
    ],
  }
end

def builds_payload(versions)
  {
    "data" => versions.map do |attributes|
      { "id" => "b#{attributes['version']}", "type" => "builds", "attributes" => attributes }
    end,
  }
end

class IpaIdentityTest < Minitest::Test
  PLIST = <<~XML
    <?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0">
    <dict>
      <key>CFBundleIdentifier</key><string>ai.shogo.app</string>
      <key>CFBundleVersion</key><string>983</string>
      <key>CFBundleShortVersionString</key><string>2.4.9</string>
      <key>UILaunchStoryboardName</key><string>LaunchScreen</string>
      <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
      <key>NSCameraUsageDescription</key><string>Take photos</string>
      <key>LSRequiresIPhoneOS</key><true/>
    </dict>
    </plist>
  XML

  def test_reads_the_build_identity_from_the_plist
    info = IosApp.parse_info_plist(PLIST)

    assert_equal "ai.shogo.app", info.bundle_id
    assert_equal "983", info.build_number
    assert_equal "2.4.9", info.short_version
  end

  def test_the_ipa_build_number_wins_over_the_workflow_guess
    info = IosApp::Info.new("ai.shogo.app", "983", "2.4.9")

    release = IosApp.release(info, expected_build_number: "982")

    assert_equal "983", release.build_number
    assert release.mismatch?
  end

  def test_no_mismatch_when_the_workflow_guess_matches_the_ipa
    info = IosApp::Info.new("ai.shogo.app", "982", "2.4.9")

    release = IosApp.release(info, expected_build_number: "982")

    refute release.mismatch?
  end

  def test_falls_back_to_the_expected_build_when_no_ipa_is_available
    release = IosApp.release(nil, expected_build_number: "982")

    assert_equal "982", release.build_number
    assert_equal "ai.shogo.app", release.bundle_id
    assert_nil release.short_version
  end
end

class AppResolutionTest < Minitest::Test
  def test_resolves_the_app_by_bundle_id
    client = FakeClient.new do |path|
      if path.start_with?("/v1/apps?")
        app_payload(id: "111")
      elsif path == "/v1/apps/111"
        { "data" => { "id" => "111", "attributes" => { "name" => "shogo", "bundleId" => "ai.shogo.app" } } }
      else
        raise "unexpected #{path}"
      end
    end

    app, warnings = resolve_app_for_bundle(client, "ai.shogo.app", "111")

    assert_equal "111", app.id
    assert_equal "ai.shogo.app", app.bundle_id
    assert_empty warnings
  end

  def test_reports_a_stale_asc_app_id_and_uses_the_app_that_owns_the_bundle
    client = FakeClient.new do |path|
      if path.start_with?("/v1/apps?")
        app_payload(id: "222")
      elsif path == "/v1/apps/999"
        { "data" => { "id" => "999", "attributes" => { "name" => "shogo mac", "bundleId" => "ai.shogo.mac" } } }
      else
        raise "unexpected #{path}"
      end
    end

    app, warnings = resolve_app_for_bundle(client, "ai.shogo.app", "999")

    assert_equal "222", app.id
    assert_equal 1, warnings.length
    assert_includes warnings.first, "ASC_APP_ID is 999"
    assert_includes warnings.first, "shogo mac (ai.shogo.mac, id 999)"
  end

  def test_fails_loudly_when_no_app_has_the_bundle_id
    client = FakeClient.new do |path|
      if path.start_with?("/v1/apps?")
        { "data" => [] }
      elsif path == "/v1/apps/999"
        { "data" => { "id" => "999", "attributes" => { "name" => "other", "bundleId" => "com.other" } } }
      else
        raise "unexpected #{path}"
      end
    end

    error = assert_raises(ReleaseConfigError) do
      resolve_app_for_bundle(client, "ai.shogo.app", "999")
    end
    assert_includes error.message, "No App Store Connect app record has bundle id ai.shogo.app"
    assert_includes error.message, "other (com.other, id 999)"
  end
end

class WaitForBuildTest < Minitest::Test
  APP = AppStoreApp.new("111", "ai.shogo.app", "shogo")

  def client_for(build_responses, recent = [])
    responses = build_responses.dup
    lambda_client = FakeClient.new do |path|
      if path.start_with?("/v1/builds?filter%5Bapp%5D=111&filter%5Bversion%5D")
        responses.shift || builds_payload([])
      elsif path.start_with?("/v1/builds?")
        builds_payload(recent)
      else
        raise "unexpected #{path}"
      end
    end
    lambda_client
  end

  def test_returns_the_build_once_it_is_valid
    client = client_for([builds_payload([{ "version" => "982", "processingState" => "PROCESSING" }]),
                         builds_payload([{ "version" => "982", "processingState" => "VALID" }])])

    build = wait_for_build(client, APP, "982", poll_interval: 0, timeout_seconds: 5, grace_seconds: 0)

    assert_equal "b982", build.fetch("id")
  end

  def test_fails_when_the_app_record_has_no_builds_at_all
    client = client_for([], [])

    error = assert_raises(ReleaseConfigError) do
      wait_for_build(client, APP, "982", poll_interval: 0, timeout_seconds: 5, grace_seconds: 0)
    end
    assert_includes error.message, "has no builds at all"
    assert_includes error.message, "the upload did not land in this app record"
  end

  def test_fails_when_the_app_only_has_older_builds
    client = client_for([], [{ "version" => "955", "processingState" => "VALID", "uploadedDate" => "2026-10-01T00:00:00Z" }])

    error = assert_raises(ReleaseConfigError) do
      wait_for_build(client, APP, "982", poll_interval: 0, timeout_seconds: 5, grace_seconds: 0)
    end
    assert_includes error.message, "newest build is 955"
    assert_includes error.message, "different app record or team"
  end

  def test_keeps_waiting_while_the_app_has_newer_builds
    client = client_for([], [{ "version" => "984", "processingState" => "VALID" }])

    error = assert_raises(ReleaseConfigError) do
      wait_for_build(client, APP, "982", poll_interval: 0, timeout_seconds: 0.2, grace_seconds: 0)
    end
    assert_includes error.message, "Timed out"
    assert_includes error.message, "build 984"
  end

  def test_fails_immediately_when_apple_rejected_the_build
    client = client_for([builds_payload([{ "version" => "982", "processingState" => "INVALID" }])])

    error = assert_raises(ReleaseConfigError) do
      wait_for_build(client, APP, "982", poll_interval: 0, timeout_seconds: 60, grace_seconds: 0)
    end
    assert_includes error.message, "processing state INVALID"
  end
end
