// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-433 acceptance: the Android/iOS release config that decides whether a
 * crash is readable.
 *
 * Two things kept production Android stacks at `app:///index.android.bundle:1`
 * and made the Sentry environment tag lie about which build a device ran:
 *
 *   1. `EXPO_UPDATES_CHANNEL` was exported by both release workflows and read
 *      by nothing, so every prebuilt binary shipped channel-less.
 *   2. `android.yml` replaced `node_modules/@sentry/cli/bin/sentry-cli` with a
 *      no-op stub *before* running the upload, so the upload step exited 0
 *      having uploaded nothing — and reported it in the job summary as
 *      "Uploaded JS bundle + composed sourcemap to Sentry".
 *
 * Both are asserted here against the real files, because neither is exercised
 * by any unit test that runs the app.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../..')
const require = createRequire(import.meta.url)

const APP_CONFIG = join(ROOT, 'apps/mobile/app.config.js')
const helpers = require(join(ROOT, 'apps/mobile/config/expo-env-config.js')) as {
  UPDATE_CHANNEL_HEADER: string
  withUpdateChannel: (updates: Record<string, unknown> | undefined, channel?: string) => any
  withSentryProject: (plugins: unknown[] | undefined, project?: string) => any
}

/** `app.config.js` as Expo would resolve it under this environment. */
function resolveAppConfig(env: Record<string, string | undefined>) {
  const keys = ['EXPO_UPDATES_CHANNEL', 'SENTRY_PROJECT']
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k]
    }
    delete require.cache[APP_CONFIG]
    return require(APP_CONFIG)
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k] as string
    }
    delete require.cache[APP_CONFIG]
  }
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf-8')
/** YAML with full-line comments dropped, so prose can't trip a check. */
const code = (file: string) =>
  read(file)
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
const android = code('.github/workflows/android.yml')
const ios = code('.github/workflows/ios.yml')

/** One step of one job, from `- name: <name>` to the next step. */
function step(yaml: string, name: string): string {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  if (start === -1) throw new Error(`no step '${name}'`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.trim().startsWith('- name: ') || /^ {2}[A-Za-z0-9_-]+:/.test(l))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

describe('SHO-433 · the update channel is baked into the native project', () => {
  it('adds the expo-channel-name request header the SDK actually reads', () => {
    const updates = helpers.withUpdateChannel({ url: 'https://u.expo.dev/x' }, ' production ')
    expect(updates.url).toBe('https://u.expo.dev/x')
    expect(updates.requestHeaders).toEqual({ 'expo-channel-name': 'production' })
    expect(helpers.UPDATE_CHANNEL_HEADER).toBe('expo-channel-name')
  })

  it('leaves the config untouched when no channel is set, and keeps existing headers', () => {
    expect(helpers.withUpdateChannel({ url: 'u' }, '')).toEqual({ url: 'u' })
    expect(helpers.withUpdateChannel({ url: 'u' }, undefined)).toEqual({ url: 'u' })
    expect(
      helpers.withUpdateChannel({ url: 'u', requestHeaders: { 'x-y': 'z' } }, 'staging').requestHeaders,
    ).toEqual({ 'x-y': 'z', 'expo-channel-name': 'staging' })
  })

  it('app.config.js resolves the channel from EXPO_UPDATES_CHANNEL', () => {
    const resolved = resolveAppConfig({ EXPO_UPDATES_CHANNEL: 'staging' })
    expect(resolved.updates.requestHeaders['expo-channel-name']).toBe('staging')

    const prod = resolveAppConfig({ EXPO_UPDATES_CHANNEL: 'production' })
    expect(prod.updates.requestHeaders['expo-channel-name']).toBe('production')

    // Local prebuild (no channel) must keep the config exactly as app.json has it.
    const local = resolveAppConfig({})
    expect(local.updates).toEqual(require(join(ROOT, 'apps/mobile/app.json')).expo.updates)
  })

  it('both release workflows export the channel variable around expo prebuild', () => {
    expect(step(android, 'Expo Prebuild')).toContain('EXPO_UPDATES_CHANNEL: ${{ needs.check-fingerprint.outputs.environment }}')
    expect(step(ios, 'Expo prebuild iOS')).toContain('EXPO_UPDATES_CHANNEL: ${{ needs.check-fingerprint.outputs.environment }}')
  })
})

describe('SHO-433 · native Sentry uploads target the platform project', () => {
  it('rewrites the Sentry Expo plugin to the given project and keeps its other options', () => {
    const plugins = [
      'expo-secure-store',
      ['@sentry/react-native/expo', { organization: 'shogo-ai', project: 'shogo-ios' }],
    ]
    const out = helpers.withSentryProject(plugins, 'shogo-android')
    expect(out[0]).toBe('expo-secure-store')
    expect(out[1][1]).toEqual({ organization: 'shogo-ai', project: 'shogo-android' })

    // No override → app.json is left exactly as it is.
    expect(helpers.withSentryProject(plugins, '')).toEqual(plugins)
    expect(helpers.withSentryProject(plugins, undefined)).toEqual(plugins)
  })

  it('each workflow prebuilds with its own project', () => {
    expect(android).toContain('SENTRY_PROJECT: shogo-android')
    expect(ios).toContain('SENTRY_PROJECT: shogo-ios')
  })
})

describe('SHO-433 · the Android sourcemap upload cannot silently do nothing', () => {
  const upload = () => step(android, 'Upload JS sourcemaps to Sentry')

  it('never replaces sentry-cli with a no-op stub', () => {
    expect(android).not.toContain('sentry-cli stub')
    expect(android).not.toMatch(/>\s*"?\$SENTRY_CLI"?\s*$/m)
    expect(android).not.toContain('- name: Ensure Sentry CLI binary')
  })

  it('turns the plugin upload off explicitly instead of neutralising the binary', () => {
    const build = step(android, 'Build AAB')
    expect(build).toContain("SENTRY_DISABLE_AUTO_UPLOAD: 'true'")
    // The plugin would upload under `--release <appId>@<version>+<code>
    // --dist <versionCode>`, which no event ever reports.
    expect(build).not.toContain('SENTRY_AUTH_TOKEN')
  })

  it('proves the CLI it uploads with is a real sentry-cli', () => {
    expect(upload()).toContain("grep -qE '^sentry-cli [0-9]+\\.[0-9]+\\.[0-9]+'")
  })

  it('uploads under the release/dist the app reports at runtime', () => {
    // `Sentry.init({ release: EXPO_PUBLIC_BUILD_HASH, dist: Platform.OS })`.
    expect(upload()).toContain('EXPO_PUBLIC_BUILD_HASH: ${{ github.sha }}')
    expect(upload()).toContain('--release "$EXPO_PUBLIC_BUILD_HASH"')
    expect(upload()).toContain('--dist android')
  })

  it('a release build fails when the upload fails instead of shipping blind', () => {
    const body = upload()
    expect(body).toContain('SENTRY_UPLOAD_REQUIRED')
    expect(body).toMatch(/exit 1/)
    // Nothing exits 0 after the upload has run: every failure path ends in
    // fail_upload, and the one `exit 0` it owns is the staging escape hatch —
    // it can only be reached through a failure, never after a "success".
    const lines = body.split('\n')
    const exits = lines.flatMap((l, i) => (l.trim() === 'exit 0' ? [i] : []))
    expect(exits).toHaveLength(1)
    expect(exits[0]).toBeLessThan(lines.findIndex((l) => l.includes('sourcemaps upload')))
    expect(body).toContain('|| fail_upload "sourcemaps inject failed"')
    expect(body).toContain('|| fail_upload "sourcemaps upload failed')
    expect(body).toContain('fail_upload "expo export:embed exited $EXPORT_RC"')
    expect(body).toContain('fail_upload "SENTRY_AUTH_TOKEN is not configured"')
  })
})

describe('SHO-433 · a release that shipped blind can still be symbolicated', () => {
  // The releases built before the upload worked have no artifacts at all, so
  // their stored events stay `index.android.bundle:1` until a map is uploaded
  // for them. Sentry symbolicates on read, so backfilling that map is what
  // makes ANDROID-11 readable without shipping a new build.
  const backfillYaml = code('.github/workflows/symbolicate-android-release.yml')
  const upload = () => step(backfillYaml, 'Upload sourcemaps for ${{ inputs.release }}')

  it('is a manual dispatch that names the release and dist to backfill', () => {
    expect(backfillYaml).toContain('workflow_dispatch:')
    expect(backfillYaml).toMatch(/release:[\s\S]{0,400}required: true/)
    expect(backfillYaml).toMatch(/dist:[\s\S]{0,400}default: android/)
  })

  it('builds the ref that shipped, not whatever HEAD is now', () => {
    expect(backfillYaml).toContain('ref: ${{ inputs.ref || inputs.release }}')
    expect(backfillYaml).toContain('EXPO_PUBLIC_BUILD_HASH: ${{ inputs.release }}')
    // The inlined API URL is part of the bundle: a different one shifts it.
    expect(backfillYaml).toContain('EXPO_PUBLIC_API_URL: ${{ inputs.environment')
  })

  it('uploads under the release/dist the events report', () => {
    expect(upload()).toContain('--release "$RELEASE"')
    expect(upload()).toContain('--dist "$SENTRY_DIST"')
  })

  it('refuses a map that cannot match the shipped Hermes bytecode', () => {
    const body = upload()
    expect(body).toContain('no index.android.bundle.hbc.map')
    // No fallback to the raw packager map: its columns are JS text offsets, so
    // uploading it for a Hermes release would map confidently-wrong lines.
    expect(body).not.toContain('cp "$PACKAGER_MAP" "$OUT/index.android.bundle.map"')
    expect(body).toContain('compose-source-maps.js')
  })

  it('proves the upload landed and never succeeds silently', () => {
    const body = upload()
    expect(body).toContain('releases files "$RELEASE" list')
    expect(body).toContain('-gt 0')
    // Every failure ends non-zero: no "continue anyway" path here.
    expect(body.split('\n').filter((l) => l.trim() === 'exit 0')).toHaveLength(0)
    expect(body).toContain('is_real_cli $SENTRY_CLI || fail "no working sentry-cli"')
  })
})
