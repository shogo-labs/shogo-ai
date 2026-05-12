#!/usr/bin/env ruby
# frozen_string_literal: true

# =============================================================================
# strip-sentry-build-phases.rb
# =============================================================================
# Removes the Sentry-injected Xcode build phases from the iOS app target so
# `xcodebuild archive` does not depend on sentry-cli at archive time.
#
# Why this exists
# ---------------
# `@sentry/react-native/expo` injects two build phases into the main app
# target during `expo prebuild`:
#
#   1. "Upload Debug Symbols to Sentry" — a standalone PBXShellScriptBuildPhase
#      that runs `sentry-cli debug-files upload` against the freshly built
#      dSYMs.
#   2. "Bundle React Native code and images" — wrapped with `sentry-xcode.sh`
#      so that `react-native-xcode.sh` is invoked through `sentry-cli react-
#      native xcode`, which uploads JS bundle + sourcemap.
#
# Both run under `set -e` and try to resolve `@sentry/cli` via Node BEFORE
# they honour `SENTRY_DISABLE_AUTO_UPLOAD=true`. With Bun's strict-hoisted
# workspace `node_modules`, that resolution path is fragile — and even when
# it succeeds, an unset auth token / transient network failure aborts the
# entire archive.
#
# In CI we want the archive to be deterministic and decoupled from Sentry.
# dSYM (and optionally JS sourcemap) upload happens as an explicit, cleanly
# scoped post-archive workflow step driven by `SENTRY_AUTH_TOKEN`. That is
# Sentry's officially documented CI pattern.
#
# Usage
# -----
#   ruby scripts/strip-sentry-build-phases.rb [project_path] [target_name]
#
# Defaults: ios/Shogo.xcodeproj, target "Shogo".
# Idempotent — safe to run repeatedly. Exits 0 when nothing needs stripping.
# =============================================================================

require "xcodeproj"

script_dir   = File.expand_path(__dir__)
project_path = ARGV[0] || File.expand_path("../ios/Shogo.xcodeproj", script_dir)
target_name  = ARGV[1] || "Shogo"

abort "[strip-sentry] Xcode project not found: #{project_path}" unless Dir.exist?(project_path)

project = Xcodeproj::Project.open(project_path)
target  = project.native_targets.find { |t| t.name == target_name }
abort "[strip-sentry] Target '#{target_name}' not found in #{project_path}" unless target

removed_phases  = []
modified_phases = []

target.build_phases.dup.each do |phase|
  next unless phase.is_a?(Xcodeproj::Project::Object::PBXShellScriptBuildPhase)

  case phase.name
  when "Upload Debug Symbols to Sentry"
    phase.remove_from_project
    removed_phases << phase.name

  when "Bundle React Native code and images"
    next unless phase.shell_script.to_s.include?("sentry-xcode.sh")

    # The Sentry plugin prepends `/bin/sh `<sentry-path-expression>` ` in
    # front of the original `react-native-xcode.sh` invocation. Strip exactly
    # that wrapper, leaving the plain RN bundler invocation untouched.
    cleaned = phase.shell_script.sub(
      %r{/bin/sh\s+`[^`]*sentry-xcode\.sh[^`]*`\s+},
      ""
    )

    if cleaned != phase.shell_script
      phase.shell_script = cleaned
      modified_phases << phase.name
    end
  end
end

project.save

if removed_phases.empty? && modified_phases.empty?
  puts "[strip-sentry] No Sentry build phases found — already clean."
else
  puts "[strip-sentry] Removed phases : #{removed_phases.inspect}"
  puts "[strip-sentry] Modified phases: #{modified_phases.inspect}"
end
