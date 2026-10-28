// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  HEARTBEAT_SESSION_ID,
  HEARTBEAT_SESSION_PREFIX,
  heartbeatSessionIdFor,
  heartbeatSessionProjectId,
  isHeartbeatChatSessionId,
} from '../heartbeat-session'

describe('isHeartbeatChatSessionId', () => {
  test('matches the bare id every pre-SHO-178 tick bills under', () => {
    expect(isHeartbeatChatSessionId(HEARTBEAT_SESSION_ID)).toBe(true)
  })

  test('matches the per-tick shape', () => {
    expect(isHeartbeatChatSessionId(heartbeatSessionIdFor('proj_1', 'tick_9'))).toBe(true)
    expect(isHeartbeatChatSessionId('heartbeat:proj_1:tick_9')).toBe(true)
    // The project alone is enough — the tick id is not part of the contract.
    expect(isHeartbeatChatSessionId('heartbeat:proj_1')).toBe(true)
  })

  test('does not match a chat session a person named like one', () => {
    expect(isHeartbeatChatSessionId('heartbeat-notes')).toBe(false)
    expect(isHeartbeatChatSessionId('heartbeats')).toBe(false)
    expect(isHeartbeatChatSessionId('my-heartbeat')).toBe(false)
    expect(isHeartbeatChatSessionId('Heartbeat')).toBe(false)
  })

  test('still rejects the prefix when nothing follows it', () => {
    expect(isHeartbeatChatSessionId('heartbeat:')).toBe(true)
    // ...but it names no project, which is what the reader cares about.
    expect(heartbeatSessionProjectId('heartbeat:')).toBeNull()
  })

  test('is total over missing ids', () => {
    for (const id of [null, undefined, '']) {
      expect(isHeartbeatChatSessionId(id)).toBe(false)
      expect(heartbeatSessionProjectId(id)).toBeNull()
    }
  })
})

describe('heartbeatSessionProjectId', () => {
  test('reads the project out of the per-tick id', () => {
    expect(heartbeatSessionProjectId('heartbeat:proj_1:tick_9')).toBe('proj_1')
    expect(heartbeatSessionProjectId(heartbeatSessionIdFor('proj_2', 'x'))).toBe('proj_2')
  })

  test('has no project for the shared bare id', () => {
    expect(heartbeatSessionProjectId(HEARTBEAT_SESSION_ID)).toBeNull()
  })

  test('has no project for a normal chat session', () => {
    expect(heartbeatSessionProjectId('chat-123')).toBeNull()
  })
})

describe('heartbeatSessionIdFor', () => {
  test('is the shape the reader parses back', () => {
    const id = heartbeatSessionIdFor('proj_1', 'tick_9')
    expect(id.startsWith(HEARTBEAT_SESSION_PREFIX)).toBe(true)
    expect(id).toBe('heartbeat:proj_1:tick_9')
  })
})
