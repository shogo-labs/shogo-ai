// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── @shogo/shared-runtime mock ────────────────────────────────────────
// Only `docker-compose` declares a floor; everything else is unrestricted.
mock.module('@shogo/shared-runtime', () => ({
  getMinimumInstanceSize: (techStackId: string | null | undefined) =>
    techStackId === 'docker-compose' ? 'large' : null,
}))

// ─── billing.service mock ──────────────────────────────────────────────
type TierGateResult = { allowed: boolean; currentSize: string; requiredSize: string | null }
let tierGateAnswer: TierGateResult = { allowed: true, currentSize: 'micro', requiredSize: null }
const tierGateCalls: Array<{ workspaceId: string; techStackId: string | null | undefined }> = []
let paidAnswer = true
const paidCalls: string[] = []
mock.module('../billing.service', () => ({
  canRunTechStackOnInstanceSize: async (workspaceId: string, techStackId: string | null | undefined) => {
    tierGateCalls.push({ workspaceId, techStackId })
    return tierGateAnswer
  },
  hasPaidSubscription: async (workspaceId: string) => {
    paidCalls.push(workspaceId)
    return paidAnswer
  },
}))

// ─── generated/project.hooks mock (createProjectInWorkspace only) ─────
type BeforeCreateResult = { ok: true; data?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }
let beforeCreateAnswer: BeforeCreateResult = { ok: true }
const beforeCreateCalls: Array<Record<string, unknown>> = []
mock.module('../../generated/project.hooks', () => ({
  projectHooks: {
    beforeCreate: async (input: Record<string, unknown>) => {
      beforeCreateCalls.push(input)
      return beforeCreateAnswer
    },
    afterCreate: async () => {},
  },
}))

// ─── lib/prisma mock ────────────────────────────────────────────────────
interface FakeProject {
  id: string
  name: string
  description: string | null
  workspaceId: string
  workingMode: string
  settings: unknown
  createdAt: Date
}

const projects = new Map<string, FakeProject>()
const agentConfigs = new Map<string, Record<string, unknown>>()
let createIdCounter = 0

const prismaStub = {
  workspace: {
    findUnique: async () => ({ kind: 'team' }),
  },
  project: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id = `proj_${++createIdCounter}`
      const record: FakeProject = {
        id,
        name: data.name as string,
        description: (data.description as string | null) ?? null,
        workspaceId: data.workspaceId as string,
        workingMode: (data.workingMode as string) ?? 'managed',
        settings: data.settings ?? null,
        createdAt: new Date(),
      }
      projects.set(id, record)
      return record
    },
    findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = projects.get(where.id)
      if (!existing) throw new Error('not found')
      const updated = { ...existing, ...data }
      projects.set(where.id, updated)
      return updated
    },
  },
  agentConfig: {
    findUnique: async ({ where }: { where: { projectId: string } }) => agentConfigs.get(where.projectId) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { projectId: string }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => {
      const existing = agentConfigs.get(where.projectId)
      const record = existing ? { ...existing, ...update } : create
      agentConfigs.set(where.projectId, record)
      return record
    },
  },
}

mock.module('../../lib/prisma', () =>
  require('../../__tests__/helpers/prisma-mock-exports').withPrismaExports({ prisma: prismaStub }),
)

const { createProjectInWorkspace, configureProject, ProjectLifecycleError } = await import(
  '../project-lifecycle.service'
)

function seedProject(overrides: Partial<FakeProject> = {}): FakeProject {
  const id = overrides.id ?? `proj_${++createIdCounter}`
  const record: FakeProject = {
    id,
    name: 'Existing',
    description: null,
    workspaceId: 'ws_1',
    workingMode: 'managed',
    settings: { techStackId: 'nextjs' },
    createdAt: new Date(),
    ...overrides,
  }
  projects.set(id, record)
  return record
}

beforeEach(() => {
  projects.clear()
  agentConfigs.clear()
  createIdCounter = 0
  tierGateAnswer = { allowed: true, currentSize: 'micro', requiredSize: null }
  tierGateCalls.length = 0
  paidAnswer = true
  paidCalls.length = 0
  beforeCreateAnswer = { ok: true }
  beforeCreateCalls.length = 0
})

describe('createProjectInWorkspace', () => {
  it('creates the project when beforeCreate allows it', async () => {
    beforeCreateAnswer = { ok: true }
    const project = await createProjectInWorkspace({
      workspaceId: 'ws_1',
      actingUserId: 'user_1',
      name: 'New Project',
    })
    expect(project.name).toBe('New Project')
    expect(project.workspaceId).toBe('ws_1')
    expect(beforeCreateCalls).toHaveLength(1)
  })

  it('throws ProjectLifecycleError with the instance_too_small code untouched (not coerced to bad_request)', async () => {
    beforeCreateAnswer = {
      ok: false,
      error: { code: 'instance_too_small', message: 'This stack requires the large compute tier or higher.' },
    }
    await expect(
      createProjectInWorkspace({
        workspaceId: 'ws_1',
        actingUserId: 'user_1',
        name: 'Docker Project',
        techStackId: 'docker-compose',
      }),
    ).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'instance_too_small',
    })
  })

  it('coerces an unrecognized hook error code down to bad_request', async () => {
    beforeCreateAnswer = { ok: false, error: { code: 'some_weird_code', message: 'nope' } }
    await expect(
      createProjectInWorkspace({ workspaceId: 'ws_1', actingUserId: 'user_1', name: 'X' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('still passes through forbidden/unauthorized/not_found style codes unchanged', async () => {
    beforeCreateAnswer = { ok: false, error: { code: 'forbidden', message: 'nope' } }
    await expect(
      createProjectInWorkspace({ workspaceId: 'ws_1', actingUserId: 'user_1', name: 'X' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('configureProject — Docker-class minimum compute tier', () => {
  it('does not call the tier gate when settings has no techStackId change', async () => {
    const p = seedProject({ settings: { techStackId: 'nextjs' } })
    await configureProject(p.id, { settings: { foo: 'bar' } })
    expect(tierGateCalls).toHaveLength(0)
  })

  it('does not call the tier gate for a stack with no declared floor', async () => {
    const p = seedProject({ settings: { techStackId: 'nextjs' } })
    await configureProject(p.id, { settings: { techStackId: 'react-app' } })
    expect(tierGateCalls).toHaveLength(0)
  })

  it('does not call the tier gate when techStackId is unchanged (re-PATCHing the same stack)', async () => {
    const p = seedProject({ settings: { techStackId: 'docker-compose' } })
    await configureProject(p.id, { settings: { techStackId: 'docker-compose' } })
    expect(tierGateCalls).toHaveLength(0)
  })

  it('blocks switching to docker-compose when the workspace instance size is too small', async () => {
    tierGateAnswer = { allowed: false, currentSize: 'micro', requiredSize: 'large' }
    const p = seedProject({ workspaceId: 'ws_small', settings: { techStackId: 'nextjs' } })
    await expect(configureProject(p.id, { settings: { techStackId: 'docker-compose' } })).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'instance_too_small',
    })
    expect(tierGateCalls).toEqual([{ workspaceId: 'ws_small', techStackId: 'docker-compose' }])
    // Settings must NOT have been persisted.
    expect((projects.get(p.id)!.settings as Record<string, unknown>).techStackId).toBe('nextjs')
  })

  it('allows switching to docker-compose when the workspace meets the tier floor', async () => {
    tierGateAnswer = { allowed: true, currentSize: 'large', requiredSize: 'large' }
    const p = seedProject({ workspaceId: 'ws_large', settings: { techStackId: 'nextjs' } })
    const result = await configureProject(p.id, { settings: { techStackId: 'docker-compose' } })
    expect((result.settings as Record<string, unknown>).techStackId).toBe('docker-compose')
    expect(tierGateCalls).toEqual([{ workspaceId: 'ws_large', techStackId: 'docker-compose' }])
  })

  it('throws not_found for a nonexistent project', async () => {
    await expect(configureProject('nope', { name: 'x' })).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'not_found',
    })
  })
})

describe('configureProject — heartbeat paywall', () => {
  it('does not check billing when the patch has no agent block', async () => {
    const p = seedProject({ workspaceId: 'ws_free' })
    await configureProject(p.id, { name: 'Renamed' })
    expect(paidCalls).toHaveLength(0)
  })

  it('does not check billing when heartbeatEnabled is not touched and was already disabled', async () => {
    const p = seedProject({ workspaceId: 'ws_free' })
    agentConfigs.set(p.id, { heartbeatEnabled: false, heartbeatInterval: 1800 })
    await configureProject(p.id, { agent: { modelName: 'claude-haiku-4-5' } })
    expect(paidCalls).toHaveLength(0)
  })

  it('blocks enabling the heartbeat on an unpaid workspace', async () => {
    paidAnswer = false
    const p = seedProject({ workspaceId: 'ws_free' })
    await expect(
      configureProject(p.id, { agent: { heartbeatEnabled: true } }),
    ).rejects.toMatchObject({ name: 'ProjectLifecycleError', code: 'paywall' })
    expect(paidCalls).toEqual(['ws_free'])
    // AgentConfig must NOT have been persisted as enabled.
    expect(agentConfigs.get(p.id)).toBeUndefined()
  })

  it('blocks patching other agent fields while the heartbeat is already enabled on an unpaid workspace', async () => {
    paidAnswer = false
    const p = seedProject({ workspaceId: 'ws_free' })
    agentConfigs.set(p.id, { heartbeatEnabled: true, heartbeatInterval: 1800 })
    await expect(
      configureProject(p.id, { agent: { modelName: 'claude-haiku-4-5' } }),
    ).rejects.toMatchObject({ name: 'ProjectLifecycleError', code: 'paywall' })
  })

  it('allows disabling the heartbeat on an unpaid workspace', async () => {
    paidAnswer = false
    const p = seedProject({ workspaceId: 'ws_free' })
    agentConfigs.set(p.id, { heartbeatEnabled: true, heartbeatInterval: 1800 })
    const result = await configureProject(p.id, { agent: { heartbeatEnabled: false } })
    expect(result.agent?.heartbeatEnabled).toBe(false)
  })

  it('allows enabling the heartbeat on a paid workspace', async () => {
    paidAnswer = true
    const p = seedProject({ workspaceId: 'ws_paid' })
    const result = await configureProject(p.id, { agent: { heartbeatEnabled: true, heartbeatInterval: 900 } })
    expect(result.agent?.heartbeatEnabled).toBe(true)
    expect(paidCalls).toEqual(['ws_paid'])
  })
})
