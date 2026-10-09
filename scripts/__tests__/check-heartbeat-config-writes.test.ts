// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { findViolations, scanRepo } from '../check-heartbeat-config-writes'

const FILE = 'apps/api/src/routes/example.ts'

describe('check-heartbeat-config-writes', () => {
  test('the repo currently has a single heartbeat writer', () => {
    expect(scanRepo()).toEqual([])
  })

  test('flags a direct update of a schedule field', () => {
    const src = `await prisma.agentConfig.update({ where: { projectId }, data: { heartbeatEnabled: true } })`
    const v = findViolations(FILE, src)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe(1)
  })

  test('flags nextHeartbeatAt in updateMany / upsert', () => {
    expect(findViolations(FILE, `prisma.agentConfig.updateMany({ data: { nextHeartbeatAt: null } })`)).toHaveLength(1)
    expect(
      findViolations(FILE, `prisma.agentConfig.upsert({ where: {}, create: {}, update: { heartbeatInterval: 60 } })`),
    ).toHaveLength(1)
  })

  test('flags a create that does not use buildAgentConfigCreateData', () => {
    const v = findViolations(FILE, `await prisma.agentConfig.create({ data: { projectId, channels: [] } })`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe(2)
  })

  test('allows creates built by buildAgentConfigCreateData, inline or via a variable', () => {
    expect(
      findViolations(FILE, `await tx.agentConfig.create({ data: buildAgentConfigCreateData(id, { heartbeatEnabled: true }) })`),
    ).toEqual([])
    expect(
      findViolations(
        FILE,
        `const agentData = buildAgentConfigCreateData(id, {})\nawait prisma.agentConfig.create({ data: agentData })`,
      ),
    ).toEqual([])
  })

  test('allows writes that do not touch schedule fields', () => {
    expect(
      findViolations(FILE, `await prisma.agentConfig.updateMany({ where: { projectId }, data: { lastHeartbeatAt: new Date() } })`),
    ).toEqual([])
  })

  test('flags raw SQL that updates schedule columns', () => {
    const src = 'await prisma.$executeRaw`UPDATE "agent_configs" SET "nextHeartbeatAt" = NOW() WHERE id = ${id}`'
    const v = findViolations(FILE, src)
    expect(v.some((x) => x.rule === 3)).toBe(true)
  })

  test('the config service and scheduler files are allowlisted', () => {
    const src = `await prisma.agentConfig.update({ where: { id }, data: { nextHeartbeatAt } })`
    expect(findViolations('apps/api/src/services/heartbeat-config.service.ts', src)).toEqual([])
    expect(findViolations('apps/api/src/lib/base-heartbeat-scheduler.ts', src)).toEqual([])
  })
})
