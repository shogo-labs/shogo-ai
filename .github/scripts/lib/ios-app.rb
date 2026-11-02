# Reads the identity of a built .ipa: the bundle id, the marketing version and
# the build number that Apple will actually see.
#
# The release pipeline used to *assume* that the build number inside the IPA was
# GITHUB_RUN_NUMBER + 100 (SHO-282). When that assumption is wrong every
# App Store Connect query filters on a build number that was never uploaded, so
# the upload "succeeds" and the build is never found. The plist is the only
# authority, so read it.

require "open3"
require "rexml/document"
require "shellwords"
require "tmpdir"

require_relative "app-store-connect"

module IosApp
  Info = Struct.new(:bundle_id, :build_number, :short_version)

  # What the upload will be known as in App Store Connect: the IPA's own
  # values, with the workflow's expectations kept only for reporting.
  Release = Struct.new(:bundle_id, :build_number, :short_version, :expected_build_number) do
    def mismatch?
      expected_build_number && build_number.to_s != expected_build_number.to_s
    end
  end

  INFO_PLIST_IN_IPA = %r{\APayload/[^/]+\.app/Info\.plist\z}.freeze

  module_function

  # The identity to poll for. The IPA is authoritative — a build number taken
  # from GITHUB_RUN_NUMBER is only a guess that Apple never agreed to (SHO-282).
  def release(info, expected_build_number:, fallback_bundle_id: "ai.shogo.app")
    if info.nil?
      return Release.new(fallback_bundle_id, expected_build_number, nil, expected_build_number)
    end

    Release.new(
      info.bundle_id.to_s.empty? ? fallback_bundle_id : info.bundle_id,
      info.build_number,
      info.short_version,
      expected_build_number,
    )
  end

  # Top-level <key>value</key> pairs of an XML property list.
  def parse_info_plist(xml)
    document = REXML::Document.new(xml)
    values = {}
    pending_key = nil
    document.elements.each("plist/dict/*") do |element|
      if element.name == "key"
        pending_key = element.text.to_s.strip
      elsif pending_key && !values.key?(pending_key)
        values[pending_key] = element.text.to_s
        pending_key = nil
      end
    end
    Info.new(
      values["CFBundleIdentifier"],
      values["CFBundleVersion"],
      values["CFBundleShortVersionString"],
    )
  end

  def read_ipa(ipa_path)
    raise ReleaseConfigError, "IPA not found at #{ipa_path}" unless File.file?(ipa_path)

    entry = list_entries(ipa_path).find { |name| name =~ INFO_PLIST_IN_IPA }
    unless entry
      raise ReleaseConfigError, "#{ipa_path} has no Payload/*.app/Info.plist — it is not an iOS app bundle."
    end

    Dir.mktmpdir("ipa-info") do |dir|
      _, error, status = Open3.capture3("unzip", "-o", "-q", ipa_path, entry, "-d", dir)
      raise ReleaseConfigError, "Could not extract #{entry} from #{ipa_path}: #{error}" unless status.success?

      xml, error, status = Open3.capture3("plutil", "-convert", "xml1", "-o", "-", File.join(dir, entry))
      unless status.success?
        raise ReleaseConfigError,
              "Could not read #{entry} from #{ipa_path} (plutil failed: #{error.strip}). " \
              "plutil is only available on macOS runners."
      end

      info = parse_info_plist(xml)
      raise ReleaseConfigError, "#{ipa_path} has no CFBundleVersion in its Info.plist." if info.build_number.to_s.empty?

      info
    end
  end

  def list_entries(ipa_path)
    output, error, status = Open3.capture3("unzip", "-Z1", ipa_path)
    raise ReleaseConfigError, "Could not list #{ipa_path}: #{error}" unless status.success?

    output.lines.map(&:strip).reject(&:empty?)
  end
end
