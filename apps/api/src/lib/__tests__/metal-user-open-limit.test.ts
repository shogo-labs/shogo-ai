// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { MetalPlacementRegistry } from '../metal-placement-registry'
import { enforceUserMetalOpenLimit } from '../metal-user-open-limit'

// In-process registry (no Redis) so the ZSET semantics are deterministic.
const mkRegistry = () => new MetalPlacementRegistry(() => null)

function mkStopSpy(busy: Set<string> = new Set()) {
  const stopped: string[] = []
  const attempted: string[] = []
  const stop = async (projectId: string) => {
    attempted.push(projectId)
    if (busy.has(projectId)) return { suspended: false, busy: true }
    stopped.push(projectId)
    return { suspended: true, busy: false }
  }
  return { stopped, attempted, stop }
}

describe('enforceUserMetalOpenLimit', () => {
  it('does nothing while at or under the cap', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) {
      const suspended = await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
      expect(suspended).toEqual([])
    }
    expect(stopped).toEqual([])
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toEqual(['a', 'b', 'c'])
  })

  it('suspends the least-recently-opened project when a 4th is opened', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) {
      await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
    }
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, stop, max: 3, now })
    expect(suspended).toEqual(['a']) // 'a' is oldest
    expect(stopped).toEqual(['a'])
    // 'a' is dropped from the user's open set; the live 3 remain.
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toEqual(['b', 'c', 'd'])
  })

  it('re-opening an older project protects it and evicts the next-oldest', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) {
      await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
    }
    // Re-open 'a' (now newest), then open 'd' → oldest is now 'b'.
    await enforceUserMetalOpenLimit('u', 'a', { registry, stop, max: 3, now })
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, stop, max: 3, now })
    expect(suspended).toEqual(['b'])
    expect(stopped).toEqual(['b'])
  })

  it('never suspends the just-opened project even if it was previously oldest', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) {
      await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
    }
    // Re-open the currently-oldest ('a'): it becomes newest, nothing to evict.
    const suspended = await enforceUserMetalOpenLimit('u', 'a', { registry, stop, max: 3, now })
    expect(suspended).toEqual([])
    expect(stopped).toEqual([])
  })

  it('is disabled when the cap is 0 or negative', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    for (const p of ['a', 'b', 'c', 'd', 'e']) {
      const suspended = await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 0 })
      expect(suspended).toEqual([])
    }
    expect(stopped).toEqual([])
  })

  it('suspends multiple when already several over the cap', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy()
    let t = 1_000
    const now = () => (t += 1_000)
    // Seed 5 opens directly into the registry (as if the cap had been off).
    for (const p of ['a', 'b', 'c', 'd', 'e']) await registry.recordUserOpen('u', p, now())
    // Opening 'f' with cap=3 should shed everything beyond the newest 3.
    const suspended = await enforceUserMetalOpenLimit('u', 'f', { registry, stop, max: 3, now })
    expect(suspended).toEqual(['a', 'b', 'c'])
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toEqual(['d', 'e', 'f'])
  })

  it('keeps the project open (does not remove it) when stop fails', async () => {
    const registry = mkRegistry()
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) await registry.recordUserOpen('u', p, now())
    const stop = async () => {
      throw new Error('host unreachable')
    }
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, stop, max: 3, now })
    expect(suspended).toEqual([]) // stop threw → nothing reported suspended
    // 'a' stays in the set so a later open retries the eviction.
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toContain('a')
  })

  it('never shuts down a busy project — skips it and evicts the next-oldest idle one', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy(new Set(['a'])) // oldest 'a' has an active message
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, stop, max: 3, now })
    expect(suspended).toEqual(['b']) // 'a' busy → skipped; next-oldest 'b' evicted
    expect(stopped).toEqual(['b'])
    // Busy 'a' stays open (still counted); it'll be retried on a later open.
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toEqual(['a', 'c', 'd'])
  })

  it('suspends nothing (stays over cap) when every eviction candidate is busy', async () => {
    const registry = mkRegistry()
    const { stopped, stop } = mkStopSpy(new Set(['a', 'b', 'c']))
    let t = 1_000
    const now = () => (t += 1_000)
    for (const p of ['a', 'b', 'c']) await enforceUserMetalOpenLimit('u', p, { registry, stop, max: 3, now })
    const suspended = await enforceUserMetalOpenLimit('u', 'd', { registry, stop, max: 3, now })
    expect(suspended).toEqual([])
    expect(stopped).toEqual([])
    // Nothing freed → temporarily over cap; all four remain open.
    expect((await registry.listUserOpen('u', t + 1)).map((e) => e.projectId)).toEqual(['a', 'b', 'c', 'd'])
  })
})
