// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  getKnownPrimaryWorkspaceSession,
  publishPrimaryWorkspaceSession,
  publishWorkspaceSessionScopeChanged,
  subscribePrimaryWorkspaceSession,
  subscribeWorkspaceSessionScopeChanged,
} from '../workspace-agent-session-bus'

describe('workspace-agent-session-bus', () => {
  test('lets the chat surface publish the primary session without shell creation', () => {
    const workspaceId = 'ws-primary-bus-test'
    const received = []
    const unsubscribe = subscribePrimaryWorkspaceSession(workspaceId, (sessionId) => received.push(sessionId))

    publishPrimaryWorkspaceSession(workspaceId, 'session-primary')

    expect(getKnownPrimaryWorkspaceSession(workspaceId)).toBe('session-primary')
    expect(received).toEqual(['session-primary'])
    unsubscribe()
  })

  test('only refreshes project scope for the changed session', () => {
    const workspaceId = 'ws-scope-bus-test'
    const received = []
    const unsubscribe = subscribeWorkspaceSessionScopeChanged(workspaceId, (sessionId) => received.push(sessionId))

    publishWorkspaceSessionScopeChanged(workspaceId, 'session-side')

    expect(received).toEqual(['session-side'])
    unsubscribe()
  })
})
