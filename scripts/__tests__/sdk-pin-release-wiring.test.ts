// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Release-pin wiring (SHO-522).
 *
 * The v2.6.1 image was built while `publish-sdk` was still uploading, so it
 * pinned `^2.6.0`; because the pin was a caret range, pods installing from it
 * resolved 2.6.1 — the release that shipped without `bin/bucket-cli.mjs`.
 *
 * These assertions pin the three things that keep that from recurring:
 *   1. every writer pins an exact `X.Y.Z` (a range is re-resolved on install),
 *   2. a release-tag image build pins the tag's own SDK and fails if npm never
 *      serves it (never falling back to `latest`), and
 *   3. the publish smoke check waits for the exact version instead of hammering
 *      `npm install` into an ETARGET red.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf-8')

describe('release SDK pin wiring (SHO-522)', () => {
  test('the workspace-deps image takes SHOGO_SDK_PIN_VERSION and asserts the pin', () => {
    const dockerfile = read('docker', 'workspace-deps', 'Dockerfile')
    expect(dockerfile).toContain('ARG SHOGO_SDK_PIN_VERSION')
    expect(dockerfile).toContain('export SHOGO_SDK_PIN_VERSION="${SHOGO_SDK_PIN_VERSION}"')
    // In-build assertion: exact pin, and equal to the release's version when
    // the build was told one.
    expect(dockerfile).toContain('pin must be an exact X.Y.Z')
    expect(dockerfile).toContain('was told to pin the release SDK')
  })

  test('runtime-multiarch passes the tag version on a tag and stamps it as a label', () => {
    const wf = read('.github', 'workflows', 'runtime-multiarch.yml')
    expect(wf).toContain('SHOGO_SDK_PIN_VERSION=${{ github.ref_type == \'tag\' && steps.sdk.outputs.pin || \'\' }}')
    expect(wf).toContain('org.opencontainers.image.sdk-pin=')
    // A tag build also publishes a tag no main-push build can overwrite.
    expect(wf).toContain('release-multiarch-${SHA}')
    expect(wf).toContain('release-docker-multiarch-${SHA}')
  })

  test('deploy.yml rebuilds the runtime chain for the release pin instead of promoting it', () => {
    const wf = read('.github', 'workflows', 'deploy.yml')
    expect(wf).toContain('rebuild-release-runtime:')
    expect(wf).toContain("needs.detect-changes.outputs.release_sdk_pin != ''")
    expect(wf).toContain('SHOGO_SDK_PIN_VERSION=${{ needs.detect-changes.outputs.release_sdk_pin }}')
    // The promoted runtime would overwrite the tag-pinned one.
    expect(wf).toContain('REPOS="shogo-api shogo-web shogo-docs"')
    // The acceptance check reads the pin out of the image.
    expect(wf).toContain('docker run --rm --entrypoint cat "$RUNTIME_IMAGE"')
    expect(wf).toContain('/app/templates/runtime-template/package.json')
    // A failed rebuild must stop the deploy, not silently promote a stale image.
    expect(wf).toContain("(needs.rebuild-release-runtime.result == 'success' || needs.rebuild-release-runtime.result == 'skipped')")
  })

  test('the metal promotion is told the release pin', () => {
    const wf = read('.github', 'workflows', 'deploy.yml')
    expect(wf).toContain('SDK_PIN: ${{ needs.detect-changes.outputs.release_sdk_pin }}')
    const script = read('.github', 'scripts', 'promote-metal-runtime-image.sh')
    expect(script).toContain('release-multiarch-${SHA}')
    expect(script).toContain('org.opencontainers.image.sdk-pin')
  })

  test('publish-sdk waits for the exact version before the smoke install', () => {
    const wf = read('.github', 'workflows', 'publish-sdk.yml')
    const wait = wf.indexOf('Wait until npm serves every published version')
    const smoke = wf.indexOf('Smoke check published packages')
    expect(wait).toBeGreaterThan(-1)
    expect(smoke).toBeGreaterThan(wait)
    expect(wf).toContain('--wait-for "@shogo-ai/$pkg@$VERSION"')
    // The stale cache was half the ETARGET story.
    expect(wf).toContain('--cache "$DIR/.npm-cache"')
  })

  test('no writer still emits a caret pin for @shogo-ai/sdk', () => {
    const writers = [
      read('scripts', 'materialize-runtime-template.ts'),
      read('packages', 'agent-runtime', 'src', 'workspace-defaults.ts'),
      read('apps', 'api', 'src', 'lib', 'runtime', 'manager.ts'),
    ]
    for (const src of writers) {
      expect(src.match(/dependencies\['@shogo-ai\/sdk'\] = `\^/g)).toBeNull()
    }
    // The materialize script writes the bare version.
    expect(read('scripts', 'materialize-runtime-template.ts')).toContain('deps[name] = version')
  })
})
