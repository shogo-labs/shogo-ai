// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `heartbeat-config.service` — the single writer of heartbeat schedule fields.
 *
 * The regression this guards: rows that were `heartbeatEnabled` with a null
 * `nextHeartbeatAt` are invisible to the scheduler, so heartbeats never fired.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let paidAnswer = true
const paidCalls: string[] = []
mock.module('../billing-runtime', () => ({
  hasPaidSubscription: async (workspaceId: string) => {
    paidCalls.push(workspaceId)
    return paidAnswer
  },
}))
mock.module('../loops.service', () => ({ trackEvent: async () => {} }))

const rows = new Map<string, Record<string, any>>()
let projectWorkspace: string | null = 'ws_1'

const prismaStub = {
  project: {
    findUnique: async () => ({ workspaceId: projectWorkspace, createdBy: null }),
  },
  agentConfig: {
    findUnique: async ({ where }: any) => rows.get(where.projectId) ?? null,
    update: async ({ where, data }: any) => {
      const next = { ...rows.get(where.projectId), ...data }
      rows.set(where.projectId, next)
      return next
    },
    create: async ({ data }: any) => {
      rows.set(data.projectId, data)
      return data
    },
  },
}
mock.module('../../lib/prisma', () =>
  require('../../__tests__/helpers/prisma-mock-exports').withPrismaExports({ prisma: prismaStub }),
)

const {
  updateHeartbeatConfig,
  buildAgentConfigCreateData,
  computeNextHeartbeatAt,
  HeartbeatConfigError,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
} = await import('../heartbeat-config.service')

beforeEach(() => {
  rows.clear()
  paidAnswer = true
  paidCalls.length = 0
  projectWorkspace = 'ws_1'
})

describe('computeNextHeartbeatAt', () => {
  it('is null when disabled', () => {
    expect(computeNextHeartbeatAt(false, 300)).toBeNull()
  })

  it('is at least one interval in the future when enabled', () => {
    const now = 1_000_000
    const next = computeNextHeartbeatAt(true, 300, now)!
    expect(next.getTime()).toBeGreaterThanOrEqual(now + 300_000)
  })
})

describe('updateHeartbeatConfig', () => {
  it('schedules nextHeartbeatAt when switching on', async () => {
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 600, nextHeartbeatAt: null })
    const { config, previousEnabled } = await updateHeartbeatConfig('p1', { heartbeatEnabled: true })
    expect(previousEnabled).toBe(false)
    expect(config.heartbeatEnabled).toBe(true)
    expect(config.nextHeartbeatAt).toBeInstanceOf(Date)
  })

  it('clears nextHeartbeatAt when switching off (and never checks billing)', async () => {
    paidAnswer = false
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 600, nextHeartbeatAt: new Date() })
    const { config } = await updateHeartbeatConfig('p1', { heartbeatEnabled: false })
    expect(config.nextHeartbeatAt).toBeNull()
    expect(paidCalls).toHaveLength(0)
  })

  it('repairs an enabled row that has no nextHeartbeatAt, even for an unrelated patch', async () => {
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 600, nextHeartbeatAt: null })
    const { config } = await updateHeartbeatConfig('p1', { quietHoursStart: '22:00' })
    expect(config.nextHeartbeatAt).toBeInstanceOf(Date)
  })

  it('leaves an existing nextHeartbeatAt alone for an unrelated patch', async () => {
    const at = new Date(Date.now() + 5 * 60_000)
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 600, nextHeartbeatAt: at })
    const { config } = await updateHeartbeatConfig('p1', { quietHoursEnd: '07:00' })
    expect(config.nextHeartbeatAt).toBe(at)
  })

  it('reschedules when the interval changes', async () => {
    const at = new Date(Date.now() + 5 * 60_000)
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 600, nextHeartbeatAt: at })
    const { config } = await updateHeartbeatConfig('p1', { heartbeatInterval: 120 })
    expect(config.heartbeatInterval).toBe(120)
    expect(config.nextHeartbeatAt).not.toBe(at)
  })

  it('reschedules on every call with alwaysReschedule', async () => {
    const at = new Date(Date.now() + 5 * 60_000)
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: true, heartbeatInterval: 600, nextHeartbeatAt: at })
    const { config } = await updateHeartbeatConfig('p1', {}, { alwaysReschedule: true })
    expect(config.nextHeartbeatAt).not.toBe(at)
  })

  it('ignores an interval below the minimum by default, throws with strictInterval', async () => {
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 600, nextHeartbeatAt: null })
    const { config } = await updateHeartbeatConfig('p1', { heartbeatInterval: MIN_HEARTBEAT_INTERVAL_SECONDS - 1 })
    expect(config.heartbeatInterval).toBe(600)
    await expect(
      updateHeartbeatConfig('p1', { heartbeatInterval: 10 }, { strictInterval: true }),
    ).rejects.toMatchObject({ code: 'invalid_interval' })
  })

  it('throws a paywall error when enabling on an unpaid workspace and does not write', async () => {
    paidAnswer = false
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 600, nextHeartbeatAt: null })
    await expect(updateHeartbeatConfig('p1', { heartbeatEnabled: true })).rejects.toBeInstanceOf(HeartbeatConfigError)
    expect(rows.get('p1')!.heartbeatEnabled).toBe(false)
    expect(paidCalls).toEqual(['ws_1'])
  })

  it('skips the paywall with enforcePaywall: false (desktop / admin)', async () => {
    paidAnswer = false
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 600, nextHeartbeatAt: null })
    const { config } = await updateHeartbeatConfig('p1', { heartbeatEnabled: true }, { enforcePaywall: false })
    expect(config.heartbeatEnabled).toBe(true)
    expect(paidCalls).toHaveLength(0)
  })

  it('throws not_found when the row is missing, creates it with createIfMissing', async () => {
    await expect(updateHeartbeatConfig('p1', { heartbeatEnabled: true })).rejects.toMatchObject({ code: 'not_found' })
    const { config } = await updateHeartbeatConfig('p1', { heartbeatEnabled: true, heartbeatInterval: 300 }, { createIfMissing: true })
    expect(config.projectId).toBe('p1')
    expect(config.heartbeatEnabled).toBe(true)
    expect(config.nextHeartbeatAt).toBeInstanceOf(Date)
  })

  it('treats empty-string quiet hours as null', async () => {
    rows.set('p1', { projectId: 'p1', heartbeatEnabled: false, heartbeatInterval: 600, quietHoursStart: '22:00' })
    const { config } = await updateHeartbeatConfig('p1', { quietHoursStart: '' })
    expect(config.quietHoursStart).toBeNull()
  })
})

describe('buildAgentConfigCreateData', () => {
  it('schedules an enabled row (import / marketplace install regression)', () => {
    const data = buildAgentConfigCreateData('p1', { heartbeatEnabled: true, heartbeatInterval: 900 })
    expect(data.heartbeatEnabled).toBe(true)
    expect(data.heartbeatInterval).toBe(900)
    expect(data.nextHeartbeatAt).toBeInstanceOf(Date)
  })

  it('leaves a disabled row unscheduled', () => {
    const data = buildAgentConfigCreateData('p1', { heartbeatEnabled: false })
    expect(data.nextHeartbeatAt).toBeNull()
  })

  it('falls back to the default interval for a missing or invalid one', () => {
    expect(buildAgentConfigCreateData('p1', {}).heartbeatInterval).toBe(DEFAULT_HEARTBEAT_INTERVAL_SECONDS)
    expect(buildAgentConfigCreateData('p1', { heartbeatInterval: 5 }).heartbeatInterval).toBe(DEFAULT_HEARTBEAT_INTERVAL_SECONDS)
  })

  it('only includes quiet-hours and model columns the source defines', () => {
    const bare = buildAgentConfigCreateData('p1', {})
    expect('quietHoursStart' in bare).toBe(false)
    expect('modelName' in bare).toBe(false)
    const full = buildAgentConfigCreateData('p1', { quietHoursStart: '22:00', modelName: 'm' })
    expect(full.quietHoursStart).toBe('22:00')
    expect(full.modelName).toBe('m')
  })
})
