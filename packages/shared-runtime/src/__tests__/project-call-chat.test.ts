// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { runChatSessionId } from '../project-call-chat'

describe('runChatSessionId', () => {
  test('is stable for a project and run, and changes when either changes', () => {
    const first = runChatSessionId('project-1', 'run-1')

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(runChatSessionId('project-1', 'run-1')).toBe(first)
    expect(runChatSessionId('project-2', 'run-1')).not.toBe(first)
    expect(runChatSessionId('project-1', 'run-2')).not.toBe(first)
  })
})
