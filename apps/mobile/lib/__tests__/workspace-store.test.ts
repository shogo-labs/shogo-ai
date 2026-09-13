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
  getActiveWorkspaceId,
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
    resolveActiveWorkspaceId(['ws-1', 'ws-2'])
    expect(getActiveWorkspaceId()).toBe('ws-1')
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
