#!/usr/bin/env ruby
# frozen_string_literal: true

# =============================================================================
# fix-code-sign-identity.rb
# =============================================================================
# Patches the generated Xcode project so every Release build configuration
# uses "Apple Distribution" (the modern, platform-agnostic certificate type)
# instead of the legacy "iOS Distribution" / "iPhone Distribution" identities.
#
# Expo prebuild sometimes emits "iOS Distribution" into the project-level build
# settings; if the p12 in CI is an "Apple Distribution" certificate, xcodebuild
# fails with:
#   No signing certificate "iOS Distribution" found
# even when CODE_SIGN_IDENTITY is overridden on the command line, because Xcode
# validates project-level settings before applying overrides.
#
# Usage
# -----
#   ruby scripts/fix-code-sign-identity.rb [project_path] [target_name]
#
# Defaults: ios/Shogo.xcodeproj, target "Shogo".
# Idempotent — safe to run repeatedly.
# =============================================================================

require "xcodeproj"

script_dir   = File.expand_path(__dir__)
project_path = ARGV[0] || File.expand_path("../ios/Shogo.xcodeproj", script_dir)
target_name  = ARGV[1] || "Shogo"

abort "[fix-code-sign] Xcode project not found: #{project_path}" unless Dir.exist?(project_path)

project = Xcodeproj::Project.open(project_path)
target  = project.native_targets.find { |t| t.name == target_name }
abort "[fix-code-sign] Target '#{target_name}' not found in #{project_path}" unless target

patched = 0

target.build_configurations.each do |config|
  bs = config.build_settings
  identity = bs["CODE_SIGN_IDENTITY"]
  sdk_identity = bs["CODE_SIGN_IDENTITY[sdk=iphoneos*]"]

  if identity != "Apple Distribution"
    puts "[fix-code-sign] #{config.name}: CODE_SIGN_IDENTITY #{identity.inspect} → Apple Distribution"
    bs["CODE_SIGN_IDENTITY"] = "Apple Distribution"
    patched += 1
  end

  if sdk_identity && sdk_identity != "Apple Distribution"
    puts "[fix-code-sign] #{config.name}: CODE_SIGN_IDENTITY[sdk=iphoneos*] #{sdk_identity.inspect} → Apple Distribution"
    bs["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
    patched += 1
  end

  bs["CODE_SIGN_STYLE"] = "Manual" unless bs["CODE_SIGN_STYLE"] == "Manual"
end

project.build_configurations.each do |config|
  bs = config.build_settings
  identity = bs["CODE_SIGN_IDENTITY"]
  sdk_identity = bs["CODE_SIGN_IDENTITY[sdk=iphoneos*]"]

  if identity && identity != "Apple Distribution"
    puts "[fix-code-sign] Project #{config.name}: CODE_SIGN_IDENTITY #{identity.inspect} → Apple Distribution"
    bs["CODE_SIGN_IDENTITY"] = "Apple Distribution"
    patched += 1
  end

  if sdk_identity && sdk_identity != "Apple Distribution"
    puts "[fix-code-sign] Project #{config.name}: CODE_SIGN_IDENTITY[sdk=iphoneos*] #{sdk_identity.inspect} → Apple Distribution"
    bs["CODE_SIGN_IDENTITY[sdk=iphoneos*]"] = "Apple Distribution"
    patched += 1
  end
end

project.save

if patched == 0
  puts "[fix-code-sign] All code sign identities already set to Apple Distribution."
else
  puts "[fix-code-sign] Patched #{patched} build setting(s)."
end
