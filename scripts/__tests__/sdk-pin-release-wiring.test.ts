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
 *   1. every release-path writer pins an exact `X.Y.Z` (a range is re-resolved
 *      on install) — while a source checkout keeps its own `^X.Y.Z` line, whose
 *      bare version is unpublished and whose `latest` is a different major,
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

  test('every release-path writer pins an exact @shogo-ai/sdk, never a range', () => {
    // Release paths: the materializer that stamps a template, and the branches
    // of the runtime writers that read a *materialized* template's own pin.
    // A range there is re-resolved against npm on install, which is how a
    // broken release reached an image that had only pinned `^2.6.0`.
    const materialize = read('scripts', 'materialize-runtime-template.ts')
    expect(materialize).toContain('deps[name] = version')
    expect(materialize).not.toContain('deps[name] = `^')

    const runtime = read('packages', 'agent-runtime', 'src', 'workspace-defaults.ts')
    // The materialized-template branches write the bare version.
    expect(runtime).toContain("templateSdkRange = m[1]")
    expect(runtime).toContain("pin = typeof range === 'string' ? range.match(/(\\d+\\.\\d+\\.\\d+)/)?.[1] : undefined")
    expect(runtime).toContain('templateSdkPin = m[1]')
  })

  test('a source checkout keeps its own caret range — never the bare placeholder, never latest', () => {
    // The `workspace:*` sentinel means a source checkout, whose
    // `packages/<pkg>/package.json` version is a development placeholder the
    // release never publishes (v2.6.1's tree still said 1.7.0): pinning it bare
    // fails `bun install` with ETARGET. `latest` is the other failure mode — it
    // jumps a major, and 2.6.1's published tarball omits `bin/bucket-cli.mjs`,
    // so every `shogo generate` in a seeded project died and E2E went red
    // (chat-resume-on-send, run 45113235623). The checkout's own line, as a
    // range, is the one shape that installs.
    const runtime = read('packages', 'agent-runtime', 'src', 'workspace-defaults.ts')
    expect(runtime).toContain("templateSdkRange = `^${repoSdkPkg.version}`")
    expect(runtime).toContain('pin = `^${repoSdkVersion}`')
    expect(runtime).toContain('templateSdkPin = `^${repoSdkPkg.version}`')
    expect(runtime).not.toContain("templateSdkRange = 'latest'")
    expect(runtime).not.toContain("?? 'latest'")

    // apps/api seeds a project from the same checkout: caret on its in-repo
    // version, `latest` only when there is no in-repo package at all.
    const manager = read('apps', 'api', 'src', 'lib', 'runtime', 'manager.ts')
    expect(manager).toContain('deps[name] = `^${version}`')
    expect(manager).toContain('resolveInRepoPackageVersion')
  })
})
