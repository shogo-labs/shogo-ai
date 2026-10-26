// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the self-update decision guard. We deliberately test the pure
 * `shouldUpdate` (not the IO-driving maybeSelfUpdate) so the "when do we apply"
 * policy is pinned without downloading/swapping/restarting: never when disabled,
 * never on a missing/malformed release, never when already on the version, and
 * yes only on a real, well-formed version change.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SELF_ACTIVATE_AFTER_MS,
  activateStagedImages,
  dockerRuntimeImage,
  rootfsActivationDecision,
  shouldRebuildRootfs,
  shouldUpdate,
  stagedRootfsPath,
  type DesiredAgent,
  type StagedRootfs,
} from './self-update'

const rel = (over: Partial<DesiredAgent> = {}): DesiredAgent => ({
  version: 'v2',
  bundleUrl: 's3://bucket/agent-v2.tgz',
  sha256: 'abc',
  ...over,
})

describe('shouldUpdate', () => {
  test('applies on a real version change when enabled', () => {
    expect(shouldUpdate('v1', rel(), true)).toBe(true)
  })

  test('never applies when self-update is disabled', () => {
    expect(shouldUpdate('v1', rel(), false)).toBe(false)
  })

  test('does not apply when already on the desired version', () => {
    expect(shouldUpdate('v2', rel({ version: 'v2' }), true)).toBe(false)
  })

  test('does not apply on null/undefined desired', () => {
    expect(shouldUpdate('v1', null, true)).toBe(false)
    expect(shouldUpdate('v1', undefined, true)).toBe(false)
  })

  test('does not apply on a malformed release (missing version or bundleUrl)', () => {
    expect(shouldUpdate('v1', rel({ version: '' }), true)).toBe(false)
    expect(shouldUpdate('v1', rel({ bundleUrl: '' }), true)).toBe(false)
  })

  test("'unknown' dev version never equals a published version → updates once", () => {
    expect(shouldUpdate('unknown', rel(), true)).toBe(true)
  })
})

/**
 * `shouldRebuildRootfs` decouples the golden-rootfs rebuild from the agent
 * code-version gate. Regression for the 2026-07 "guest rootfs stale after agent
 * self-update" incident: a commit that changed both the agent and the runtime
 * chain published two SAME-version releases — the immediate push (rebuild=false)
 * and, minutes later, the runtime-image workflow_run (rebuild=true). The host had
 * already updated its code on the first, so the version matched and the
 * rebuild-flagged release was silently dropped. The rebuild is now keyed off a
 * local "last-built" marker instead of the code version.
 */
describe('shouldRebuildRootfs', () => {
  const rebuildRel = (over: Partial<DesiredAgent> = {}): DesiredAgent =>
    rel({ rebuildRootfs: true, ...over })

  test('rebuilds when the release asks for it and we never built this version', () => {
    // The core race: version already matches (code updated), marker is an OLDER
    // version → we must still rebuild.
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v1', true)).toBe(true)
    // Fresh host, no marker yet.
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), null, true)).toBe(true)
  })

  test('does not rebuild again once we have built this exact version', () => {
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v2', true)).toBe(false)
  })

  test('does not rebuild when the release does not ask for it', () => {
    expect(shouldRebuildRootfs(rel({ version: 'v2', rebuildRootfs: false }), 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(rel({ version: 'v2' }), 'v1', true)).toBe(false)
  })

  test('never rebuilds when self-update is disabled', () => {
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v1', false)).toBe(false)
  })

  test('does not rebuild on null/undefined or version-less desired', () => {
    expect(shouldRebuildRootfs(null, 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(undefined, 'v1', true)).toBe(false)
    expect(shouldRebuildRootfs(rebuildRel({ version: '' }), 'v1', true)).toBe(false)
  })

  test('a release already staged is not rebuilt again; a newer one rebuilds the staged image', () => {
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v2' }), 'v1', true, 'v2')).toBe(false)
    expect(shouldRebuildRootfs(rebuildRel({ version: 'v3' }), 'v1', true, 'v2')).toBe(true)
  })
})

describe('rootfsActivationDecision', () => {
  const staged = (over: Partial<StagedRootfs> = {}): StagedRootfs => ({
    version: 'v2',
    identities: { standard: 'sz1-mt1' },
    stagedAt: 1_000_000,
    ...over,
  })

  test('activates on the control plane\'s word for exactly the staged version', () => {
    expect(rootfsActivationDecision(staged(), 'v2', 1_000_001)).toBe('activate')
  })

  test('waits without a word, and refuses a word for any other version', () => {
    expect(rootfsActivationDecision(staged(), null, 1_000_001)).toBe('wait')
    expect(rootfsActivationDecision(staged(), 'v1', 1_000_001)).toBe('refuse')
    expect(rootfsActivationDecision(null, 'v2', 1_000_001)).toBe('refuse')
    expect(rootfsActivationDecision(null, undefined, 1_000_001)).toBe('wait')
  })

  test('switches on its own once staged long enough, so a release is never stranded', () => {
    expect(rootfsActivationDecision(staged(), null, 1_000_000 + SELF_ACTIVATE_AFTER_MS - 1)).toBe('wait')
    expect(rootfsActivationDecision(staged(), null, 1_000_000 + SELF_ACTIVATE_AFTER_MS)).toBe('self-activate')
    expect(rootfsActivationDecision(staged(), 'v1', 1_000_000 + SELF_ACTIVATE_AFTER_MS)).toBe('self-activate')
  })
})

describe('activateStagedImages', () => {
  test('renames each staged image over its base, keeping size and mtime (the identity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activate-'))
    try {
      const base = join(dir, 'rootfs.ext4')
      const docker = join(dir, 'docker.ext4')
      writeFileSync(base, 'old')
      writeFileSync(docker, 'old-docker')
      writeFileSync(stagedRootfsPath(base), 'new image')
      writeFileSync(stagedRootfsPath(docker), 'new docker image')
      utimesSync(stagedRootfsPath(base), 1_700_000_000, 1_700_000_000)
      const before = statSync(stagedRootfsPath(base))

      activateStagedImages(base, docker)
      expect(readFileSync(base, 'utf8')).toBe('new image')
      expect(readFileSync(docker, 'utf8')).toBe('new docker image')
      expect(existsSync(stagedRootfsPath(base))).toBe(false)
      expect(existsSync(stagedRootfsPath(docker))).toBe(false)
      const after = statSync(base)
      expect(after.size).toBe(before.size)
      expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a docker class with nothing staged leaves its image alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activate-'))
    try {
      const base = join(dir, 'rootfs.ext4')
      const docker = join(dir, 'docker.ext4')
      writeFileSync(docker, 'old-docker')
      writeFileSync(stagedRootfsPath(base), 'new image')
      activateStagedImages(base, docker)
      expect(readFileSync(base, 'utf8')).toBe('new image')
      expect(readFileSync(docker, 'utf8')).toBe('old-docker')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('dockerRuntimeImage', () => {
  test('rewrites a multiarch tag to the docker-class tag', () => {
    expect(dockerRuntimeImage('ocir.io/ns/shogo/shogo-runtime:staging-multiarch-abc')).toBe(
      'ocir.io/ns/shogo/shogo-runtime:staging-docker-multiarch-abc',
    )
  })

  test('appends -docker when the tag has no multiarch segment', () => {
    expect(dockerRuntimeImage('example.com/runtime:latest')).toBe('example.com/runtime:latest-docker')
  })
})
