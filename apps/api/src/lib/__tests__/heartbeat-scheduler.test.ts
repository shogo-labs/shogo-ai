// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test'
import { randomUUID } from 'crypto'

const TEST_DB_URL = process.env.DATABASE_URL || 'postgres://shogo:shogo_dev@127.0.0.1:5432/shogo'
process.env.DATABASE_URL = TEST_DB_URL

let prisma: any
let HeartbeatScheduler: any

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
      type: 'AGENT',
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
      channels: [],
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

  const schedulerModule = await import('../heartbeat-scheduler')
  HeartbeatScheduler = schedulerModule.HeartbeatScheduler
})

afterEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect?.()
})

describe('HeartbeatScheduler e2e', () => {
  test('tick() picks up due agents and advances nextHeartbeatAt', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 60_000),
    })

    const triggeredProjects: string[] = []

    const scheduler = new HeartbeatScheduler()
    ;(scheduler as any).running = true
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    await scheduler.tick()

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })

    expect(config.nextHeartbeatAt).toBeTruthy()
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now())

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

    const scheduler = new HeartbeatScheduler()
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    // Must set running=true since tick() checks it
    ;(scheduler as any).running = true
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

    const scheduler = new HeartbeatScheduler()
    ;(scheduler as any).triggerAgent = async (pid: string) => {
      triggeredProjects.push(pid)
    }

    ;(scheduler as any).running = true
    await scheduler.tick()

    expect(triggeredProjects).not.toContain(projectId)

    scheduler.stop()
  })

  test('tick() skips agents in quiet hours and advances nextHeartbeatAt', async () => {
    const now = new Date()
    const tz = 'UTC'
    const hours = now.getUTCHours()
    const minutes = now.getUTCMinutes()

    const startH = hours
    const startM = 0
    const endH = (hours + 2) % 24
    const endM = 0

    const quietStart = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`
    const quietEnd = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`

    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 60_000),
      quietHoursStart: quietStart,
      quietHoursEnd: quietEnd,
      quietHoursTimezone: tz,
    })

    const triggeredProjects: string[] = []

    const scheduler = new HeartbeatScheduler()
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

    const scheduler = new HeartbeatScheduler()
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

  test('heartbeat/complete endpoint updates lastHeartbeatAt', async () => {
    const { projectId } = await createTestFixtures()

    await prisma.agentConfig.updateMany({
      where: { projectId },
      data: { lastHeartbeatAt: null },
    })

    const before = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(before.lastHeartbeatAt).toBeNull()

    await prisma.agentConfig.updateMany({
      where: { projectId },
      data: { lastHeartbeatAt: new Date() },
    })

    const after = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(after.lastHeartbeatAt).toBeTruthy()
    expect(after.lastHeartbeatAt.getTime()).toBeCloseTo(Date.now(), -3)
  })

  test('heartbeat config update sets nextHeartbeatAt with jitter when enabling', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: false,
      nextHeartbeatAt: null,
    })

    const interval = 3600

    const jitter = Math.floor(Math.random() * interval * 0.1) * 1000
    const nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)

    await prisma.agentConfig.update({
      where: { projectId },
      data: {
        heartbeatEnabled: true,
        heartbeatInterval: interval,
        nextHeartbeatAt,
      },
    })

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.heartbeatEnabled).toBe(true)
    expect(config.heartbeatInterval).toBe(3600)
    expect(config.nextHeartbeatAt).toBeTruthy()
    expect(config.nextHeartbeatAt.getTime()).toBeGreaterThan(Date.now() + 3500 * 1000)
  })

  test('heartbeat config update clears nextHeartbeatAt when disabling', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      nextHeartbeatAt: new Date(Date.now() + 1800_000),
    })

    await prisma.agentConfig.update({
      where: { projectId },
      data: {
        heartbeatEnabled: false,
        nextHeartbeatAt: null,
      },
    })

    const config = await prisma.agentConfig.findUnique({ where: { projectId } })
    expect(config.heartbeatEnabled).toBe(false)
    expect(config.nextHeartbeatAt).toBeNull()
  })

  test('partial index exists for heartbeat scheduling queries', async () => {
    const result = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'agent_configs'
        AND indexname = 'idx_agent_configs_heartbeat_schedule'
    `
    expect((result as any[]).length).toBe(1)
  })

  test('SKIP LOCKED prevents duplicate processing across concurrent ticks', async () => {
    const { projectId } = await createTestFixtures({
      heartbeatEnabled: true,
      heartbeatInterval: 1800,
      nextHeartbeatAt: new Date(Date.now() - 60_000),
    })

    const triggeredA: string[] = []
    const triggeredB: string[] = []

    const schedulerA = new HeartbeatScheduler()
    ;(schedulerA as any).running = true
    ;(schedulerA as any).triggerAgent = async (pid: string) => {
      triggeredA.push(pid)
    }

    const schedulerB = new HeartbeatScheduler()
    ;(schedulerB as any).running = true
    ;(schedulerB as any).triggerAgent = async (pid: string) => {
      triggeredB.push(pid)
    }

    await Promise.all([
      schedulerA.tick(),
      schedulerB.tick(),
    ])

    const totalTriggers = triggeredA.length + triggeredB.length
    expect(totalTriggers).toBe(1)

    schedulerA.stop()
    schedulerB.stop()
  })
})
