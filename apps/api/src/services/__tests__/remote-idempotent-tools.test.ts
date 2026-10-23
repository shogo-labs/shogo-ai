// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 §4b — the API decides which remote tool calls may be replayed from
 * its own copy of the list (`REMOTE_IDEMPOTENT_TOOLS`), because it cannot
 * import the runtime package. This asserts the two lists stay in step; if the
 * runtime grows a read-only tool the API will not retry it (safe), but if a
 * mutating tool were added here the API would replay a write (unsafe).
 */
import { describe, expect, test } from 'bun:test'
import { REMOTE_IDEMPOTENT_TOOLS, isRemoteIdempotentTool } from '../agent-call.service'
import { REMOTE_READONLY_TOOLS } from '@shogo/agent-runtime/src/remote-tools'

describe('REMOTE_IDEMPOTENT_TOOLS', () => {
  test('matches the runtime allows replay for exactly the read-only tools', () => {
    expect([...REMOTE_IDEMPOTENT_TOOLS].sort()).toEqual([...REMOTE_READONLY_TOOLS].sort())
  })

  test('never includes a mutating tool', () => {
    for (const tool of ['write_file', 'edit_file', 'delete_file', 'exec']) {
      expect(isRemoteIdempotentTool(tool)).toBe(false)
    }
  })
})
