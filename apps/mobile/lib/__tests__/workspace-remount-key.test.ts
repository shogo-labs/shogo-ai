// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it } from 'bun:test'
import {
  INITIAL_WORKSPACE_REMOUNT_STATE,
  nextWorkspaceRemountState,
  workspaceRemountKey,
  type WorkspaceRemountState,
} from '../workspace-remount-key'

function keys(ids: Array<string | null | undefined>): string[] {
  let state: WorkspaceRemountState = INITIAL_WORKSPACE_REMOUNT_STATE
  return ids.map((id) => {
    state = nextWorkspaceRemountState(state, id)
    return workspaceRemountKey(state)
  })
}

describe('workspace remount key (SHO-298)', () => {
  it('keeps the key when the workspace list finishes loading on a cold start', () => {
    const [loading, loaded, again] = keys([null, 'ws-a', 'ws-a'])
    expect(loaded).toBe(loading)
    expect(again).toBe(loading)
  })

  it('changes the key when a different workspace is chosen', () => {
    const [a, b, backToA] = keys(['ws-a', 'ws-b', 'ws-a'])
    expect(b).not.toBe(a)
    expect(backToA).not.toBe(b)
    expect(backToA).not.toBe(a)
  })

  it('treats a gap (sign-out, refetch) as nothing, then remounts for a new workspace', () => {
    const [a, gap, sameAgain, other] = keys(['ws-a', null, 'ws-a', 'ws-b'])
    expect(gap).toBe(a)
    expect(sameAgain).toBe(a)
    expect(other).not.toBe(a)
  })

  it('is idempotent for the same id, so a double render cannot bump it', () => {
    const state = nextWorkspaceRemountState(INITIAL_WORKSPACE_REMOUNT_STATE, 'ws-a')
    expect(nextWorkspaceRemountState(state, 'ws-a')).toBe(state)
    expect(nextWorkspaceRemountState(state, undefined)).toBe(state)
  })
})
