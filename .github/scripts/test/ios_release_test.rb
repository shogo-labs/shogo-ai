#!/usr/bin/env ruby
# Unit tests for the iOS release scripts (SHO-282).
#
#   ruby .github/scripts/test/ios_release_test.rb
#
# They cover the part that was silently wrong: the identity the pipeline polls
# App Store Connect for, and what it reports when that identity is missing.

require "minitest/autorun"
require "fileutils"
require "yaml"
require "open3"
require "tmpdir"

require_relative "../lib/app-store-connect"
require_relative "../lib/ios-app"

SCRIPTS = File.expand_path("..", __dir__)
REPO = File.expand_path("../..", SCRIPTS)

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

class DistributeScriptTest < Minitest::Test
  # End to end: a real .ipa, a stub App Store Connect, and a workflow that
  # guessed the wrong build number. The IPA must win and both groups must end up
  # assigned — the whole release path, not just the helpers.
  def test_assigns_the_ipas_build_to_the_configured_groups
    skip "needs plutil (macOS runner)" unless system("command -v plutil > /dev/null 2>&1")

    Dir.mktmpdir("distribute-e2e") do |dir|
      ipa = write_ipa(dir)

      summary = File.join(dir, "summary.md")
      File.write(summary, "")
      harness = File.join(dir, "harness.rb")
      File.write(harness, distribute_harness(ipa, summary))

      output, error_output, run = Open3.capture3(ENV.to_h, "ruby", harness)
      assert run.success?, "script failed:\n#{output}\n#{error_output}"

      assert_includes output, "CFBundleVersion:             983"
      assert_includes output, "The IPA's CFBundleVersion is 983 but the workflow expected 982"
      assert_includes output, "Assigned build 983 to TestFlight group group-a."
      assert_includes output, "Assigned build 983 to TestFlight group group-b."
      assert_includes File.read(summary), "**Build (from the IPA):** `983`"
    end
  end

  # App Store Connect answers 403 FORBIDDEN_ERROR to GET on a build's
  # `betaGroups` relationship ("only CREATE, DELETE"), so the distributor must
  # never read it — and a group the build is already in comes back as a 409 that
  # means success, not a failed release.
  def test_a_group_the_build_is_already_in_is_not_a_failure
    skip "needs plutil (macOS runner)" unless system("command -v plutil > /dev/null 2>&1")

    Dir.mktmpdir("distribute-e2e") do |dir|
      ipa = write_ipa(dir)

      summary = File.join(dir, "summary.md")
      File.write(summary, "")
      harness = File.join(dir, "harness.rb")
      File.write(harness, distribute_harness(ipa, summary, already_assigned: ["group-b"]))

      output, error_output, run = Open3.capture3(ENV.to_h, "ruby", harness)
      assert run.success?, "script failed:\n#{output}\n#{error_output}"

      assert_includes output, "Assigned build 983 to TestFlight group group-a."
      assert_includes output, "Build 983 is already assigned to TestFlight group group-b."
    end
  end

  # TestFlight adds every processed build to the team's internal groups by
  # itself and App Store Connect refuses to assign one explicitly — HTTP 422
  # "Builds cannot be assigned to this internal group.", which is what killed
  # the ios-v2.5.7 run after the GET 403 was fixed.
  def test_an_internal_group_is_never_assigned_explicitly
    skip "needs plutil (macOS runner)" unless system("command -v plutil > /dev/null 2>&1")

    Dir.mktmpdir("distribute-e2e") do |dir|
      ipa = write_ipa(dir)

      summary = File.join(dir, "summary.md")
      File.write(summary, "")
      harness = File.join(dir, "harness.rb")
      File.write(harness, distribute_harness(ipa, summary, internal_groups: ["group-a"]))

      output, error_output, run = Open3.capture3(ENV.to_h, "ruby", harness)
      assert run.success?, "script failed:\n#{output}\n#{error_output}"

      assert_includes output,
                      "TestFlight group group-a is internal; build 983 is added to it automatically."
      assert_includes output, "Assigned build 983 to TestFlight group group-b."
    end
  end

  private

  def write_ipa(dir)
    ipa = File.join(dir, "Shogo-test.ipa")
    app_dir = File.join(dir, "Payload", "Shogo.app")
    FileUtils.mkdir_p(app_dir)
    File.write(File.join(app_dir, "Info.plist"), <<~PLIST)
      <?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
      <dict>
      <key>CFBundleIdentifier</key><string>ai.shogo.app</string>
      <key>CFBundleVersion</key><string>983</string>
      <key>CFBundleShortVersionString</key><string>2.4.9</string>
      </dict>
      </plist>
    PLIST
    _out, error, status = Open3.capture3("zip", "-qr", ipa, "Payload", chdir: dir)
    assert status.success?, "zip failed: #{error}"
    ipa
  end

  def distribute_harness(ipa, summary, already_assigned: [], internal_groups: [])
    <<~RUBY
      require #{File.join(SCRIPTS, 'lib/app-store-connect').inspect}
      require #{File.join(SCRIPTS, 'lib/ios-app').inspect}

      POSTED = []

      class AppStoreConnectClient
        def request(request_class, path, body = nil)
          case path
          when %r{\\A/v1/apps\\?}
            { "data" => [{ "id" => "222", "attributes" => { "name" => "shogo", "bundleId" => "ai.shogo.app" } }] }
          when %r{\\A/v1/apps/999\\z}
            { "data" => { "id" => "999", "attributes" => { "name" => "shogo mac", "bundleId" => "ai.shogo.mac" } } }
          when %r{\\A/v1/builds\\?.*filter%5Bversion%5D=983}
            { "data" => [{ "id" => "build-983", "attributes" => { "version" => "983", "processingState" => "VALID" } }] }
          when %r{\\A/v1/builds/[^/]+/betaGroups}
            raise "App Store Connect refuses GET on the build's betaGroups relationship (403 GET_RELATED)"
          when %r{\\A/v1/builds/}
            { "data" => [] }
          when %r{\\A/v1/betaGroups/}
            group = path[%r{\\A/v1/betaGroups/([^/]+)/}, 1]
            if ALREADY_ASSIGNED.include?(group)
              raise AppStoreConnectError.new(409, "{\\"errors\\":[]}")
            end
            if INTERNAL_GROUPS.include?(group)
              raise AppStoreConnectError.new(422, "{\\"errors\\":[{\\"code\\":\\"ENTITY_UNPROCESSABLE\\",\\"detail\\":\\"Cannot add internal group to a build.\\"}]}")
            end
            POSTED << path
            {}
          else
            raise "unexpected request \#{path}"
          end
        end
      end

      ALREADY_ASSIGNED = #{already_assigned.inspect}
      INTERNAL_GROUPS = #{internal_groups.inspect}

      ENV["ASC_KEY_ID"] = "key"
      ENV["ASC_ISSUER_ID"] = "issuer"
      ENV["ASC_PRIVATE_KEY"] = "unused-because-http-is-stubbed"
      ENV["ASC_APP_ID"] = "999"
      ENV["TESTFLIGHT_BUILD_NUMBER"] = "982"
      ENV["TESTFLIGHT_GROUP_IDS"] = "group-a,group-b"
      ENV["TESTFLIGHT_POLL_INTERVAL_SECONDS"] = "0"
      ENV["TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS"] = "10"
      ENV["TESTFLIGHT_GRACE_SECONDS"] = "0"
      ENV["TESTFLIGHT_IPA_PATH"] = #{ipa.inspect}
      ENV["GITHUB_STEP_SUMMARY"] = #{summary.inspect}

      load #{File.join(SCRIPTS, 'testflight-distribute.rb').inspect}
      abort "expected exactly the external, not-yet-assigned groups to be posted" unless POSTED.length == #{2 - already_assigned.length - internal_groups.length}
    RUBY
  end
end

class SparseCheckoutTest < Minitest::Test
  WORKFLOWS = File.expand_path("../workflows", SCRIPTS)

  # A job that checks out a file list and then runs a script whose
  # `require_relative` reaches outside that list dies with LoadError before it
  # ever talks to Apple — and only on a tag push, which is how four releases
  # were lost (SHO-282). Every sparse-checkout block must cover its scripts'
  # requires.
  def test_every_sparse_checkout_covers_its_scripts_requires
    blocks = sparse_checkout_blocks
    refute_empty blocks, "no sparse-checkout blocks found in #{WORKFLOWS}"

    blocks.each do |workflow, job, entries|
      entries.select { |entry| entry.end_with?(".rb") }.each do |entry|
        script = File.join(REPO, entry)
        assert File.file?(script), "#{workflow} #{job}: sparse-checkout lists #{entry}, which does not exist"

        require_targets(script).each do |target|
          assert covered?(entries, target),
                 "#{workflow} #{job}: #{entry} requires #{target}, which its sparse-checkout does not include " \
                 "(#{entries.join(', ')})"
        end
      end
    end
  end

  private

  def sparse_checkout_blocks
    Dir[File.join(WORKFLOWS, "*.yml")].sort.flat_map do |workflow|
      document = YAML.safe_load(File.read(workflow, encoding: "UTF-8"), aliases: true) || {}
      (document["jobs"] || {}).flat_map do |job_name, job|
        steps = (job || {})["steps"] || []
        steps.map do |step|
          entries = step.dig("with", "sparse-checkout")
          next if entries.nil?

          [File.basename(workflow), job_name, entries.lines.map(&:strip).reject(&:empty?)]
        end.compact
      end
    end
  end

  # Repo-relative paths of everything a script pulls in with require_relative.
  def require_targets(script)
    File.read(script, encoding: "UTF-8").scan(/require_relative\s+["']([^"']+)["']/).flatten.map do |target|
      path = File.expand_path(target, File.dirname(script))
      path += ".rb" unless path.end_with?(".rb")
      path.delete_prefix("#{REPO}/")
    end
  end

  def covered?(entries, target)
    entries.any? do |entry|
      entry == target || (entry.end_with?("/") ? target.start_with?(entry) : target.start_with?("#{entry}/"))
    end
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
