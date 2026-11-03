// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { planFileLinkArrival } from '../file-link-arrival'

describe('planFileLinkArrival (SHO-284)', () => {
  const base = {
    path: 'notes/plan.md',
    linkWorkspaceId: 'ws-1',
    workspaceId: 'ws-1',
    memberWorkspaceIds: ['ws-1', 'ws-2'],
    handled: false,
  }

  test('a link to the workspace on screen opens the file', () => {
    expect(planFileLinkArrival(base)).toBe('open')
  })

  test('no file param, or an already handled arrival, does nothing', () => {
    expect(planFileLinkArrival({ ...base, path: null })).toBe('idle')
    expect(planFileLinkArrival({ ...base, handled: true })).toBe('idle')
  })

  test('another workspace this account is in gets adopted', () => {
    expect(planFileLinkArrival({ ...base, linkWorkspaceId: 'ws-2' })).toBe('adopt')
  })

  test('a non-member is refused, and nothing says to switch', () => {
    expect(planFileLinkArrival({ ...base, linkWorkspaceId: 'ws-other' })).toBe('denied')
  })

  test('an unloaded workspace list is unknown, not a refusal', () => {
    expect(planFileLinkArrival({ ...base, linkWorkspaceId: 'ws-2', memberWorkspaceIds: null })).toBe(
      'wait',
    )
  })

  test('waits for the workspace itself before deciding anything', () => {
    expect(planFileLinkArrival({ ...base, workspaceId: null })).toBe('wait')
  })

  test('a link with no workspace id opens in the workspace on screen', () => {
    expect(planFileLinkArrival({ ...base, linkWorkspaceId: null, memberWorkspaceIds: null })).toBe('open')
  })
})
