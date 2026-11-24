// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-578 — the platform flag is the only gate for Docker stacks.
//
// SHO-424 retired instance-size purchases (compute is metered per VM), but the
// `docker-compose` stack floor survived on the project write path: every
// create/switch on a `micro` workspace (nearly every workspace in prod) was
// answered 402 "compute too small", pointing at a Billing screen that no
// longer sells compute. These tests pin the post-fix behaviour at the hooks —
// the create path every surface (UI, agent `create_project`, marketplace,
// bundle import) funnels through.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { setDockerClassOverride } from '../lib/runtime-class-setting'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-micro'
const PROJECT_ID = 'proj-1'

// A `micro` workspace is the realistic case: 28,008 of 28,009 in prod. On
// origin/main this row made every docker-compose create/switch answer 402;
// after SHO-578 it never reaches a size check.
const prisma = {
  workspace: {
    findUnique: async () => ({ instanceSize: 'micro' }),
  },
  user: {
    findUnique: async () => ({ role: 'super_admin' }),
  },
  member: {
    findMany: async () => [{ role: 'owner', projectId: null, isBillingAdmin: false }],
  },
  project: {
    findUnique: async () => ({
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      visibility: 'workspace',
      settings: { activeMode: 'canvas', techStackId: 'nextjs' },
    }),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

const { projectHooks } = await import('../generated/project.hooks')

function makeCtx(body: any = {}) {
  return { body, params: {}, query: {}, userId: USER_ID, prisma } as any
}

afterEach(() => {
  setDockerClassOverride(null)
})

describe('projectHooks.beforeCreate — docker-compose on a micro workspace (SHO-578)', () => {
  test('accepts a docker-compose project when the platform flag is on', async () => {
    setDockerClassOverride(true)
    const input: any = {
      name: 'Compose Stack',
      workspaceId: WORKSPACE_ID,
      settings: { activeMode: 'canvas', techStackId: 'docker-compose' },
    }

    const result = await projectHooks.beforeCreate!(input, makeCtx(input))

    expect(result).toMatchObject({ ok: true })
    expect((result as any).data.settings.techStackId).toBe('docker-compose')
  })

  test('refuses with docker_class_disabled when the platform flag is off', async () => {
    setDockerClassOverride(false)
    const input: any = {
      name: 'Compose Stack',
      workspaceId: WORKSPACE_ID,
      settings: { activeMode: 'canvas', techStackId: 'docker-compose' },
    }

    const result = await projectHooks.beforeCreate!(input, makeCtx(input))

    expect(result).toEqual({
      ok: false,
      error: { code: 'docker_class_disabled', message: 'Docker projects are not available on this server yet.' },
    })
  })

  test('leaves a non-Docker stack alone with the flag off', async () => {
    setDockerClassOverride(false)
    const input: any = {
      name: 'Vite App',
      workspaceId: WORKSPACE_ID,
      settings: { activeMode: 'canvas', techStackId: 'react-app' },
    }

    expect(await projectHooks.beforeCreate!(input, makeCtx(input))).toMatchObject({ ok: true })
  })
})

describe('projectHooks.beforeUpdate — switching an existing project (SHO-578)', () => {
  test('switches nextjs → docker-compose when the platform flag is on', async () => {
    setDockerClassOverride(true)
    const input: any = { settings: { techStackId: 'docker-compose' } }

    const result = await projectHooks.beforeUpdate!(PROJECT_ID, input, makeCtx(input))

    expect(result).toMatchObject({ ok: true })
  })

  test('refuses the switch with docker_class_disabled when the platform flag is off', async () => {
    setDockerClassOverride(false)
    const input: any = { settings: { techStackId: 'docker-compose' } }

    const result = await projectHooks.beforeUpdate!(PROJECT_ID, input, makeCtx(input))

    expect(result).toEqual({
      ok: false,
      error: { code: 'docker_class_disabled', message: 'Docker projects are not available on this server yet.' },
    })
  })

  test('an unrelated settings PATCH on an existing docker project is never blocked', async () => {
    // The double already holds `techStackId: 'nextjs'`; sending the SAME stack
    // is not a switch, so the gate must not fire even with the flag off.
    setDockerClassOverride(false)
    const input: any = { settings: { techStackId: 'nextjs' } }

    expect(await projectHooks.beforeUpdate!(PROJECT_ID, input, makeCtx(input))).toMatchObject({ ok: true })
  })
})
