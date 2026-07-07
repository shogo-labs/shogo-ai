// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Unit tests for the pure desired-version resolver — the control-plane half of
 * the pull-based deploy. We pin the fallback precedence (exact region+channel →
 * region 'stable' → wildcard '*' region → null) and the "unpublished = stay put"
 * (null) contract, so a canary host gets canary, a plain host gets stable, and a
 * region with nothing published never forces an update.
 */

import { describe, expect, it } from 'bun:test'
import { resolveDesiredAgent, type FleetChannels } from '../metal-agent-release'

const channels: FleetChannels = {
  us: {
    stable: { version: 's1', bundleUrl: 's3://b/agent-s1.tgz', sha256: 'aa' },
    canary: { version: 'c1', bundleUrl: 's3://b/agent-c1.tgz', sha256: 'bb' },
  },
  '*': {
    stable: { version: 'g1', bundleUrl: 's3://b/agent-g1.tgz', sha256: 'cc' },
  },
}

describe('resolveDesiredAgent', () => {
  it('resolves the exact region + channel', () => {
    expect(resolveDesiredAgent('us', 'canary', channels)).toMatchObject({ version: 'c1', channel: 'canary' })
    expect(resolveDesiredAgent('us', 'stable', channels)).toMatchObject({ version: 's1', channel: 'stable' })
  })

  it('falls back to the region stable channel for an unpublished channel', () => {
    const r = resolveDesiredAgent('us', 'beta', channels)
    expect(r).toMatchObject({ version: 's1', channel: 'stable' })
  })

  it("uses the wildcard '*' region when the region has no channels", () => {
    expect(resolveDesiredAgent('eu', 'canary', channels)).toMatchObject({ version: 'g1', channel: 'stable' })
  })

  it('returns null when nothing is published for the region and no wildcard', () => {
    expect(resolveDesiredAgent('eu', 'canary', { us: channels.us })).toBeNull()
  })

  it('returns null for a malformed release (no version/bundleUrl)', () => {
    const bad: FleetChannels = { us: { stable: { version: '', bundleUrl: '', sha256: '' } } }
    expect(resolveDesiredAgent('us', 'stable', bad)).toBeNull()
  })

  it('carries rebuildRootfs through only when set', () => {
    const c: FleetChannels = {
      us: { stable: { version: 's1', bundleUrl: 's3://b/x.tgz', sha256: 'aa', rebuildRootfs: true } },
    }
    expect(resolveDesiredAgent('us', 'stable', c)).toMatchObject({ rebuildRootfs: true })
    expect(resolveDesiredAgent('us', 'stable', channels)?.rebuildRootfs).toBeUndefined()
  })
})
