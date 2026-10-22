// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-151: SHO-141 moved task logs to host-backed storage at
// `<workspacesDir>/.shogo-state/<projectId>/tasks` so they outlive the VM that
// wrote them — outside the project tree, so nothing that deletes a project ever
// saw them. A project whose row is gone can never read its logs again, so
// `afterDelete` sweeps that directory, in local mode too (this is app-owned
// state, not cloud infra), and leaves `workspaces/<id>` alone as designed.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const root = mkdtempSync(join(tmpdir(), 'shogo-sho151-hooks-'))
const workspacesDir = join(root, 'workspaces')
mkdirSync(workspacesDir, { recursive: true })
// `resolveWorkspacesDir()` reads this; the hook has no other way in.
process.env.WORKSPACES_DIR = workspacesDir
// Local mode skips the cloud teardown — which is exactly the mode that must
// still sweep the logs, so proving it here pins the placement of the call
// outside the `SHOGO_LOCAL_MODE !== 'true'` block.
process.env.SHOGO_LOCAL_MODE = 'true'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-151'
const PROJECT_ID = 'proj-151'
const SIBLING_ID = 'proj-151-sibling'

const prisma = {
  user: { findUnique: async () => ({ role: 'super_admin' }) },
  member: { findMany: async () => [{ role: 'owner', projectId: null, isBillingAdmin: false }] },
  project: { findUnique: async () => ({ id: PROJECT_ID, workspaceId: WORKSPACE_ID }) },
  chatSession: { findMany: async () => [] },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

mock.module('../services/conversation.service', () => ({
  removeProjectAgent: async () => {},
}))

mock.module('../lib/substrate', () => ({
  destroyProjectRuntime: async () => {},
}))

const { projectHooks } = await import('../generated/project.hooks')

function makeCtx(): any {
  return { body: {}, params: {}, query: {}, userId: USER_ID, prisma }
}

function seedDir(projectId: string) {
  const stateDir = join(workspacesDir, '.shogo-state', projectId)
  mkdirSync(join(stateDir, 'tasks'), { recursive: true })
  writeFileSync(join(stateDir, 'tasks', 'build.log'), 'log line\n')
  return stateDir
}

afterAll(() => {
  delete process.env.WORKSPACES_DIR
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(join(workspacesDir, '.shogo-state'), { recursive: true, force: true })
  rmSync(join(workspacesDir, PROJECT_ID), { recursive: true, force: true })
})

describe('projectHooks.afterDelete — durable task logs', () => {
  test('removes the deleted project state dir and nothing else', async () => {
    const stateDir = seedDir(PROJECT_ID)
    const siblingStateDir = seedDir(SIBLING_ID)
    // Project delete keeps the project tree on disk; that must not change.
    const projectDir = join(workspacesDir, PROJECT_ID)
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'export {}\n')

    await projectHooks.beforeDelete!(PROJECT_ID, makeCtx())
    await projectHooks.afterDelete!(PROJECT_ID, makeCtx())

    expect(existsSync(stateDir)).toBe(false)
    expect(existsSync(siblingStateDir)).toBe(true)
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(true)
    // The shared parent stays: a concurrent assign writes into it.
    expect(existsSync(join(workspacesDir, '.shogo-state'))).toBe(true)
  })

  test('a project that never wrote logs deletes without a throw', async () => {
    await expect(projectHooks.afterDelete!(PROJECT_ID, makeCtx())).resolves.toBeUndefined()
  })
})
