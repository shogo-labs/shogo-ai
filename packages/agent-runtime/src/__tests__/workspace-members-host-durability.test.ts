// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A metal guest gets bucket names but no object-store credentials; the host
 * hydrates a member before mounting it and owns its backups. Mounting a member
 * there must not start an in-guest S3 sync.
 *
 *   bun test packages/agent-runtime/src/__tests__/workspace-members-host-durability.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const actual = await import('@shogo/shared-runtime')
const syncsCreated: string[] = []
mock.module('@shogo/shared-runtime', () => ({
  ...actual,
  createS3SyncForProject: (_dir: string, projectId: string) => {
    syncsCreated.push(projectId)
    return {
      downloadAll: async () => ({ downloaded: 0, errors: [] }),
      startPeriodicSync: () => {},
      startWatcher: () => {},
      stopWatcher: () => {},
      stopPeriodicSync: () => {},
      flush: async () => {},
    }
  },
}))

const { initWorkspaceMembers, mountWorkspaceMember, unmountWorkspaceMember } = await import('../workspace-members')

const KEYS = ['WORKSPACE_RUNTIME', 'WORKSPACE_ID', 'WORKSPACE_DIR', 'WORKSPACE_PROJECT_IDS', 'S3_BUCKET', 'SHOGO_DURABILITY_HOST_MEDIATED']
let previous: Record<string, string | undefined>
let root: string

beforeEach(() => {
  previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  root = mkdtempSync(join(tmpdir(), 'shogo-members-durability-'))
  process.env.WORKSPACE_RUNTIME = 'true'
  process.env.WORKSPACE_ID = 'ws-test'
  process.env.WORKSPACE_DIR = root
  process.env.WORKSPACE_PROJECT_IDS = ''
  process.env.S3_BUCKET = 'workspaces'
  syncsCreated.length = 0
  initWorkspaceMembers()
})

afterEach(async () => {
  await unmountWorkspaceMember('project-1').catch(() => {})
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('mounting a workspace member', () => {
  test('starts no S3 sync under host-mediated durability', async () => {
    process.env.SHOGO_DURABILITY_HOST_MEDIATED = '1'
    await mountWorkspaceMember({ id: 'project-1' })
    expect(syncsCreated).toEqual([])
  })

  test('still syncs the member from S3 on non-metal cloud runtimes', async () => {
    delete process.env.SHOGO_DURABILITY_HOST_MEDIATED
    await mountWorkspaceMember({ id: 'project-1' })
    expect(syncsCreated).toEqual(['project-1'])
  })
})
