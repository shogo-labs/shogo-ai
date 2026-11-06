// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-353: `share_file` became remotable so a workspace agent on cloud can
 * mint a link to a file that lives in another project's runtime. Minting a link
 * only reads the target's disk (`read_file` exposes the same bytes), so it must
 * stay on `project:read` and must never require `project:update`.
 */
import { describe, expect, test } from 'bun:test'
import { REMOTE_READONLY_TOOLS, isRemoteReadonlyTool, remoteToolPermission } from '../remote-tool-policy'

describe('remote tool RBAC policy', () => {
  test('share_file is read-only: it needs project:read on the target', () => {
    expect(isRemoteReadonlyTool('share_file')).toBe(true)
    expect(remoteToolPermission('share_file')).toBe('project:read')
  })

  test('mutating tools still need project:update', () => {
    for (const tool of ['write_file', 'edit_file', 'delete_file', 'exec']) {
      expect(remoteToolPermission(tool as string)).toBe('project:update')
    }
  })

  test('every read-only tool is a tool the runtime can actually run remotely', () => {
    expect([...REMOTE_READONLY_TOOLS]).toContain('share_file')
  })
})
