// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for the active-workspace-id cache and its validation helpers.
 *
 * `resolveActiveWorkspaceId` exists because `getActiveWorkspaceId()` is a
 * bare, unscoped-by-user localStorage key: signing out of one account and
 * into another on the same browser/device otherwise leaves the previous
 * account's workspace id "active", and every workspace-scoped fetch for the
 * new account gets denied by the server until the user manually switches
 * workspaces. See apps/mobile/components/layout/sidebar/AppSidebar.tsx and
 * apps/mobile/hooks/useActiveWorkspace.ts for the call sites this guards.
 *
 * happy-dom is registered in the test preload so `localStorage` is available.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearActiveWorkspaceId,
  clearWorkspaceSwitchIntent,
  getActiveWorkspaceId,
  getCachedWorkspaceKind,
  rememberWorkspaceKind,
  resolveActiveWorkspaceId,
  setActiveWorkspaceId,
  subscribeActiveWorkspaceId,
} from '../workspace-store'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('getActiveWorkspaceId / setActiveWorkspaceId / clearActiveWorkspaceId', () => {
  test('returns null when nothing is persisted', () => {
    expect(getActiveWorkspaceId()).toBeNull()
  })

  test('round-trips a persisted id', () => {
    setActiveWorkspaceId('ws-1')
    expect(getActiveWorkspaceId()).toBe('ws-1')
  })

  test('clearActiveWorkspaceId removes the persisted id', () => {
    setActiveWorkspaceId('ws-1')
    clearActiveWorkspaceId()
    expect(getActiveWorkspaceId()).toBeNull()
  })
})

describe('resolveActiveWorkspaceId', () => {
  test('trusts the persisted id when it is one of the user\'s own workspaces', () => {
    setActiveWorkspaceId('ws-2')
    expect(resolveActiveWorkspaceId(['ws-1', 'ws-2'])).toBe('ws-2')
  })

  test('trusts an explicit candidate id over the persisted one', () => {
    setActiveWorkspaceId('ws-1')
    expect(resolveActiveWorkspaceId(['ws-1', 'ws-2'], 'ws-2')).toBe('ws-2')
  })

  test('falls back to the first own workspace when the persisted id belongs to a different account', () => {
    // Simulates a stale id left over from a previously signed-in account.
    setActiveWorkspaceId('someone-elses-workspace')
    expect(resolveActiveWorkspaceId(['ws-1', 'ws-2'])).toBe('ws-1')
  })

  test('persists the fallback so subsequent reads are self-consistent', () => {
    setActiveWorkspaceId('someone-elses-workspace')
    // A stale id is not a switch the person just made; the intent would have
    // been cleared on sign-out (SHO-157).
    clearWorkspaceSwitchIntent()
    resolveActiveWorkspaceId(['ws-1', 'ws-2'])
    expect(getActiveWorkspaceId()).toBe('ws-1')
  })

  test('self-heals a stale id without notifying subscribers during render', async () => {
    setActiveWorkspaceId('someone-elses-workspace')
    await Promise.resolve()
    const seen: string[] = []
    const unsub = subscribeActiveWorkspaceId(() => {
      seen.push('ping')
    })

    expect(resolveActiveWorkspaceId(['ws-1', 'ws-2'])).toBe('ws-1')
    await Promise.resolve()
    expect(seen).toEqual([])
    unsub()
  })

  test('rejects an unverified candidate id not in the own-workspace list', () => {
    expect(resolveActiveWorkspaceId(['ws-1', 'ws-2'], 'not-mine')).toBe('ws-1')
  })

  test('trusts a persisted id when the own-workspace list is empty (not loaded yet, or genuinely none)', () => {
    // Distinguishing "not loaded yet" from "genuinely zero workspaces" isn't
    // possible from this signature alone. Callers only call this after
    // `loadAll()` resolves, so we deliberately don't null out a
    // possibly-valid persisted id just because the list came back empty —
    // that matches the pre-existing "first ever load" fallback this
    // helper replaces.
    setActiveWorkspaceId('ws-1')
    expect(resolveActiveWorkspaceId([])).toBe('ws-1')
  })

  test('returns null when the list is empty and nothing is persisted', () => {
    expect(resolveActiveWorkspaceId([])).toBeNull()
  })

  test('does not replace the selected workspace while the list is loading', () => {
    setActiveWorkspaceId('ws-team')
    expect(
      resolveActiveWorkspaceId(['ws-personal'], undefined, {
        listLoaded: false,
      }),
    ).toBe('ws-team')
    expect(getActiveWorkspaceId()).toBe('ws-team')
  })

  test('does not persist a render fallback', () => {
    setActiveWorkspaceId('ws-team')
    expect(
      resolveActiveWorkspaceId(['ws-personal'], undefined, {
        listLoaded: true,
        persistFallback: false,
      }),
    ).toBe('ws-personal')
    expect(getActiveWorkspaceId()).toBe('ws-team')
  })

  test('persists a fallback after an authoritative load when requested', () => {
    // A stale id from an earlier session is not a switch the person just made,
    // so the self-heal still lands (the intent is cleared on sign-out; this
    // stands in for "the switch that produced this id is long gone").
    setActiveWorkspaceId('ws-team')
    clearWorkspaceSwitchIntent()
    expect(
      resolveActiveWorkspaceId(['ws-personal'], undefined, {
        listLoaded: true,
      }),
    ).toBe('ws-personal')
    expect(getActiveWorkspaceId()).toBe('ws-personal')
  })

  test('does not let a fallback undo a switch the person just made', () => {
    // SHO-157: the own-workspace list arrives before it includes the workspace
    // the person picked, and the AppSidebar mount persist would flip the
    // selection back to the first item.
    setActiveWorkspaceId('ws-personal')
    setActiveWorkspaceId('ws-team')
    expect(
      resolveActiveWorkspaceId(['ws-personal'], undefined, {
        listLoaded: true,
      }),
    ).toBe('ws-personal')
    expect(getActiveWorkspaceId()).toBe('ws-team')
  })
})

describe('a workspace switch the person just made', () => {
  const INTENT_KEY = 'shogo:active-workspace-switch'

  test('cannot be undone by an automatic writer', () => {
    setActiveWorkspaceId('ws-old')
    setActiveWorkspaceId('ws-new')

    expect(setActiveWorkspaceId('ws-old', { reason: 'automatic' })).toBe(false)
    expect(getActiveWorkspaceId()).toBe('ws-new')
  })

  test('lets an automatic writer re-select the same workspace', () => {
    setActiveWorkspaceId('ws-new')
    expect(setActiveWorkspaceId('ws-new', { reason: 'automatic' })).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-new')
  })

  test('does not block after its window passes', () => {
    setActiveWorkspaceId('ws-old')
    setActiveWorkspaceId('ws-new')
    // Age the record rather than waiting: the TTL is wall-clock.
    localStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ id: 'ws-new', left: ['ws-old'], at: Date.now() - 60_000 }),
    )

    expect(setActiveWorkspaceId('ws-old', { reason: 'automatic' })).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-old')
  })

  test('does not block an automatic writer that has a real reason for a third workspace', () => {
    // A chip for another workspace, a freshly created one: the person never
    // left it, so the intent says nothing about it.
    setActiveWorkspaceId('ws-old')
    setActiveWorkspaceId('ws-new')

    expect(setActiveWorkspaceId('ws-third', { reason: 'automatic' })).toBe(true)
    expect(getActiveWorkspaceId()).toBe('ws-third')
  })

  test('keeps every workspace the person left protected across a fast second switch', () => {
    setActiveWorkspaceId('ws-a')
    setActiveWorkspaceId('ws-b')
    setActiveWorkspaceId('ws-c')

    expect(setActiveWorkspaceId('ws-a', { reason: 'automatic' })).toBe(false)
    expect(setActiveWorkspaceId('ws-b', { reason: 'automatic' })).toBe(false)
    expect(getActiveWorkspaceId()).toBe('ws-c')
  })

  test('is published to other windows, which then cannot echo the old id back', () => {
    setActiveWorkspaceId('ws-old')
    setActiveWorkspaceId('ws-new')

    // The second window sees the switch through `storage`, re-renders, and its
    // still-mounted chat screen writes the workspace its chat belongs to.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'shogo:active-workspace-id', newValue: 'ws-new' }),
    )
    expect(setActiveWorkspaceId('ws-old', { reason: 'automatic' })).toBe(false)
    expect(getActiveWorkspaceId()).toBe('ws-new')
  })

  test('is dropped when the workspace pointer is cleared on sign-out', () => {
    setActiveWorkspaceId('ws-old')
    setActiveWorkspaceId('ws-new')
    clearActiveWorkspaceId()

    expect(localStorage.getItem(INTENT_KEY)).toBeNull()
    setActiveWorkspaceId('ws-other', { reason: 'automatic' })
    expect(getActiveWorkspaceId()).toBe('ws-other')
  })
})

describe('cached workspace kind', () => {
  test('returns null until a kind is remembered for the active id', () => {
    setActiveWorkspaceId('ws-1')
    expect(getCachedWorkspaceKind('ws-1')).toBeNull()
  })

  test('round-trips a kind only for the workspace it was remembered with', () => {
    rememberWorkspaceKind('ws-1', 'personal')
    expect(getCachedWorkspaceKind('ws-1')).toBe('personal')
    expect(getCachedWorkspaceKind('ws-2')).toBeNull()
  })

  test('clearActiveWorkspaceId drops the cached kind', () => {
    setActiveWorkspaceId('ws-1')
    rememberWorkspaceKind('ws-1', 'team')
    clearActiveWorkspaceId()
    expect(getCachedWorkspaceKind('ws-1')).toBeNull()
  })
})

describe('subscribeActiveWorkspaceId', () => {
  test('notifies after the persist so React is not updated during render', async () => {
    const seen: Array<string | null> = []
    const unsub = subscribeActiveWorkspaceId(() => {
      seen.push(getActiveWorkspaceId())
    })
    setActiveWorkspaceId('ws-1')
    expect(getActiveWorkspaceId()).toBe('ws-1')
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual(['ws-1'])
    unsub()
  })

  test('does not notify when the id is unchanged', async () => {
    setActiveWorkspaceId('ws-1')
    await Promise.resolve()
    const seen: string[] = []
    const unsub = subscribeActiveWorkspaceId(() => {
      seen.push('ping')
    })
    setActiveWorkspaceId('ws-1')
    await Promise.resolve()
    expect(seen).toEqual([])
    unsub()
  })
})

describe('switches made in another window', () => {
  test('notify subscribers when the active workspace changes elsewhere', () => {
    let pings = 0
    const unsub = subscribeActiveWorkspaceId(() => {
      pings++
    })
    localStorage.setItem('shogo:active-workspace-id', 'ws-2')
    window.dispatchEvent(new StorageEvent('storage', { key: 'shogo:active-workspace-id', newValue: 'ws-2' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x' }))
    expect(pings).toBe(1)
    expect(getActiveWorkspaceId()).toBe('ws-2')
    unsub()
    window.dispatchEvent(new StorageEvent('storage', { key: 'shogo:active-workspace-id', newValue: 'ws-3' }))
    expect(pings).toBe(1)
  })
})
