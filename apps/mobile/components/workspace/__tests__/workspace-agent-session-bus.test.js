// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  getKnownCurrentWorkspaceSession,
  publishCurrentWorkspaceSession,
  publishWorkspaceSessionScopeChanged,
  subscribeCurrentWorkspaceSession,
  subscribeWorkspaceSessionScopeChanged,
} from '../workspace-agent-session-bus'

describe('workspace-agent-session-bus', () => {
  test('lets the chat surface publish the open session without shell creation', () => {
    const workspaceId = 'ws-primary-bus-test'
    const received = []
    const unsubscribe = subscribeCurrentWorkspaceSession(workspaceId, (sessionId) => received.push(sessionId))

    publishCurrentWorkspaceSession(workspaceId, 'session-current')

    expect(getKnownCurrentWorkspaceSession(workspaceId)).toBe('session-current')
    expect(received).toEqual(['session-current'])
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
