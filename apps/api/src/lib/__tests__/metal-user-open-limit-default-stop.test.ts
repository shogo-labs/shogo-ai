// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The per-user open cap must suspend the runtime that actually serves an
 * opened project — its anchored workspace runtime `ws:proj:<id>` — not a bare
 * per-project key that no longer has a VM behind it.
 */

import { describe, expect, it, mock } from 'bun:test'

const stopped: string[] = []
mock.module('../metal-warm-pool-controller', () => ({
  stopMetalProject: async (key: string) => {
    stopped.push(key)
    return { suspended: true, busy: false }
  },
  workspaceRuntimeKey: (workspaceId: string, anchorProjectId?: string) =>
    anchorProjectId ? `ws:proj:${anchorProjectId}` : `ws:${workspaceId}`,
}))

const { MetalPlacementRegistry } = await import('../metal-placement-registry')
const { enforceUserMetalOpenLimit, stopOpenedProjectRuntime } = await import('../metal-user-open-limit')

describe('default open-limit stop', () => {
  it('targets the anchored workspace runtime key', async () => {
    stopped.length = 0
    await stopOpenedProjectRuntime('proj-1')
    expect(stopped).toEqual(['ws:proj:proj-1'])
  })

  it('enforceUserMetalOpenLimit suspends the LRU project via its anchored key by default', async () => {
    stopped.length = 0
    const registry = new MetalPlacementRegistry(() => null)
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) await enforceUserMetalOpenLimit('u', p, { registry, max: 3, now })
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, max: 3, now })
    expect(suspended).toEqual(['a'])
    expect(stopped).toEqual(['ws:proj:a'])
  })
})
