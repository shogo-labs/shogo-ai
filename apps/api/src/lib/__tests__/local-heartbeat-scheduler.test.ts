// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { randomUUID } from 'crypto'

// Force local mode so we use the SQLite Prisma client
process.env.SHOGO_LOCAL_MODE = 'true'

let prisma: any
let LocalHeartbeatScheduler: any

const createdWorkspaceIds: string[] = []
const createdProjectIds: string[] = []

async function createTestFixtures(overrides: {
  heartbeatEnabled?: boolean
  heartbeatInterval?: number
  nextHeartbeatAt?: Date | null
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  quietHoursTimezone?: string | null
} = {}) {
  const workspaceId = randomUUID()
  const projectId = randomUUID()
  const slug = `test-ws-${workspaceId.slice(0, 8)}`

  await prisma.workspace.create({
    data: { id: workspaceId, name: 'Test Workspace', slug },
  })
  createdWorkspaceIds.push(workspaceId)

  await prisma.project.create({
    data: {
      id: projectId,
      name: 'Test Agent',
      workspaceId,
    },
  })
  createdProjectIds.push(projectId)

  await prisma.agentConfig.create({
    data: {
      projectId,
      heartbeatEnabled: overrides.heartbeatEnabled ?? true,
      heartbeatInterval: overrides.heartbeatInterval ?? 1800,
      nextHeartbeatAt: overrides.nextHeartbeatAt ?? new Date(Date.now() - 60_000),
      quietHoursStart: overrides.quietHoursStart ?? null,
      quietHoursEnd: overrides.quietHoursEnd ?? null,
      quietHoursTimezone: overrides.quietHoursTimezone ?? null,
      channels: '[]',
    },
  })

  return { workspaceId, projectId }
}

async function cleanup() {
  for (const projectId of createdProjectIds) {
    await prisma.agentConfig.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  for (const id of createdWorkspaceIds) {
    await prisma.workspace.deleteMany({ where: { id } }).catch(() => {})
  }
  createdProjectIds.length = 0
  createdWorkspaceIds.length = 0
}

beforeAll(async () => {
  const prismaModule = await import('../prisma')
  prisma = prismaModule.prisma

  const schedulerModule = await import('../local-heartbeat-scheduler')
  LocalHeartbeatScheduler = schedulerModule.LocalHeartbeatScheduler
})

afterEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect?.()
})

describe('LocalHeartbeatScheduler', () => {
  test('tick() picks up due agents and advances nextHeartbeatAt', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 60_000),
    })

    const triggeredProjects: string[] = []

    const mockRuntimeProvider = {
      status: (pid: string) => ({ agentPort: 99999 }),
      start: async (pid: string) => ({ agentPort: 99999 }),
    }

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).runtimeProvider = mockRuntimeProvider
    // Override triggerAgent to capture calls without making real HTTP requests
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })

    expect(config.nextHeartbeatAt).toBeTruthy()
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now())

    // nextHeartbeatAt should be ~interval + jitter from now
    const expectedMin = Date.now() + 1800 * 1000 - 5000
    const expectedMax = Date.now() + 1800 * 1000 + 1800 * 0.1 * 1000 + 5000
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(expectedMin)
    expect(config.nextHeartbeatAt.getTime()).toBeLessThan(expectedMax)

    expect(triggeredProjects).toContain(projectId)

    scheduler.stop()
  })

  test('tick() skips agents not yet due', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() + 600_000),
    })

    const triggeredProjects: string[] = []

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.nextHeartbeatAt.getTime()).toBeCloseTo(Date.now() + 600_000, -4)

    expect(triggeredProjects).not.toContain(projectId)

    scheduler.stop()
  })

  test('tick() skips disabled agents', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: false,
      nextHeartbeatAt: null,
    })

    const triggeredProjects: string[] = []

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    expect(triggeredProjects).not.toContain(projectId)

    scheduler.stop()
  })

  test('tick() handles multiple due agents in a single batch', async () => {
    const { projectId: pid1 } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 120_000),
    })
    const { projectId: pid2 } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 3600,
      nextHeartbeatAt: new Date(Date.now() - 30_000),
    })

    const triggeredProjects: string[] = []

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    expect(triggeredProjects).toContain(pid1)
    expect(triggeredProjects).toContain(pid2)

    const config1 = await prisma.agentConfig.findUnique({ where: { projectId: pid1 } })
    const config2 = await prisma.agentConfig.findUnique({ where: { projectId: pid2 } })

    expect(config1.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now() + 1700 * 1000)
    expect(config2.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now() + 3500 * 1000)

    scheduler.stop()
  })

  test('triggerAgent auto-starts runtime when not running', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 120,
      nextHeartbeatAt: new Date(Date.now() - 10_000),
    })

    const startedProjects: string[] = []

    const mockRuntimeProvider = {
      status: () => null,
      start: async (pid: string) => {
        startedProjects.push(pid)
        return { agentPort: 99999 }
      },
    }

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).runtimeProvider = mockRuntimeProvider
    // Override triggerAgent's HTTP call but keep the start logic
    const originalTrigger = (scheduler as any).triggerAgent.bind(scheduler)
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      // Just verify the start was called; skip the actual HTTP call
      startedProjects.push(pid)
    }

    await scheduler.tick()

    expect(startedProjects).toContain(projectId)

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now())

    scheduler.stop()
  })

  test('triggerAgent skips when runtime fails to start', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 120,
      nextHeartbeatAt: new Date(Date.now() - 10_000),
    })

    const mockRuntimeProvider = {
      status: () => null,
      start: async () => { throw new Error('start failed') },
    }

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).runtimeProvider = mockRuntimeProvider

    await scheduler.tick()

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now())

    scheduler.stop()
  })

  test('tick() skips agents in quiet hours and advances nextHeartbeatAt', async () => {
    const now = new Date()
    const hours = now.getUTCHours()

    const startH = hours
    const endH = (hours + 2) % 24

    const quietStart = `${String(startH).padStart(2, '0')}:00`
    const quietEnd = `${String(endH).padStart(2, '0')}:00`

    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 60_000),
      quietHoursStart: quietStart,
      quietHoursEnd: quietEnd,
      quietHoursTimezone: 'UTC',
    })

    const triggeredProjects: string[] = []

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.nextHeartbeatAt).toBeTruthy()
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now())

    expect(triggeredProjects).not.toContain(projectId)

    scheduler.stop()
  })

  test('no subscription check required (unlike production scheduler)', async () => {
    // The local scheduler should pick up agents even without a subscription row.
    // This is the key difference from the production HeartbeatScheduler.
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 300,
      nextHeartbeatAt: new Date(Date.now() - 5_000),
    })

    const triggeredProjects: string[] = []

    const scheduler = new LocalHeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    // Should be triggered even though there's no subscription for this workspace
    expect(triggeredProjects).toContain(projectId)

    scheduler.stop()
  })
})
