// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-66 QA integration coverage — agent packs against a real SQLite DB.
 *
 * The dev's `system-apply.service.test.ts` mocks every service, so it proves
 * decisions but not that a pack actually lands in the database. These tests
 * drive the real engine against the desktop migration history: projects,
 * conversations, boards and `AgentSchedule` rows are written by the same
 * services the API uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'sho66-workspaces-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../lib/prisma')
const { applySystemPack, previewSystemPack, uninstallSystemPack } = await import('../services/system-apply.service')
const { runScheduleNow } = await import('../services/agent-schedule.service')
const { getPackTemplate } = await import('@shogo/agent-runtime/src/pack-templates')
const { parseSystemManifest } = await import('@shogo/agent-runtime/src/system-manifest')

const db = prisma as any
let seed: SeededWorkspace

const packManifest = () => {
  const parsed = parseSystemManifest(getPackTemplate('self-evolving')!.manifest)
  if (!parsed.ok) throw new Error(`self-evolving pack does not parse: ${parsed.errors.join('; ')}`)
  return parsed.manifest!
}

const answers = {
  product: 'a payments API for small shops',
  roster: 'every agent project in this workspace',
  hour: '18:00',
  timezone: 'America/New_York',
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workspacesDir, { recursive: true, force: true })
  delete process.env.WORKSPACES_DIR
})

describe('installing the Self Evolving pack', () => {
  test('creates the agent, both channels and an enabled schedule that posts in #evolution', async () => {
    const manifest = packManifest()
    const preview = await previewSystemPack({ workspaceId: seed.workspaceId, manifest, answers })
    expect(preview.channelNames).toEqual({ evolution: 'evolution', ideas: 'ideas' })

    const applied = await applySystemPack({
      workspaceId: seed.workspaceId,
      manifest,
      answers,
      actorUserId: seed.owner,
      channelNames: preview.channelNames,
    })
    expect(applied.errors).toEqual([])
    expect(applied.ok).toBe(true)

    const projectId = applied.bindings.projects['self-evolving']
    const project = await db.project.findUnique({ where: { id: projectId } })
    expect(project?.workspaceId).toBe(seed.workspaceId)

    const agentsMd = readFileSync(join(workspacesDir, projectId, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('a payments API for small shops')

    const channels = await db.conversation.findMany({
      where: { workspaceId: seed.workspaceId, slug: { in: ['evolution', 'ideas'] } },
    })
    expect(channels.map((c: any) => c.slug).sort()).toEqual(['evolution', 'ideas'])
    const evolution = channels.find((c: any) => c.slug === 'evolution')
    expect(evolution.systemManagedBy).toBe(projectId)

    const schedules = await db.agentSchedule.findMany({ where: { workspaceId: seed.workspaceId } })
    expect(schedules).toHaveLength(2)
    const daily = schedules.find((s: any) => s.name === 'Daily self review')
    expect(daily.enabled).toBe(true)
    expect(daily.notifyConversationId).toBe(evolution.id)
    expect(daily.prompt).toContain(`<@a:p:${projectId}>`)
    expect(daily.prompt).toContain(evolution.id)

    // AC3: prove the schedule can be fired now and stays pointed at #evolution.
    const due = await runScheduleNow(seed.workspaceId, daily.id)
    expect(due?.enabled).toBe(true)
    expect(due?.notifyConversationId).toBe(evolution.id)
    expect(Math.abs((due?.nextRunAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000)

    // AC6: uninstall removes exactly the created ids, schedule first.
    const removed = await uninstallSystemPack({
      workspaceId: seed.workspaceId,
      actorUserId: seed.owner,
      bindings: applied.bindings,
    })
    expect(removed.errors).toEqual([])
    expect(await db.agentSchedule.count({ where: { workspaceId: seed.workspaceId } })).toBe(0)
    expect(await db.conversation.count({ where: { workspaceId: seed.workspaceId, slug: { in: ['evolution', 'ideas'] } } })).toBe(0)
    expect((await db.project.findUnique({ where: { id: projectId } }))?.status).toBe('archived')
  })

  test('a taken channel name is suffixed on disk and the existing channel is left alone', async () => {
    const existing = await db.conversation.create({
      data: { workspaceId: seed.workspaceId, kind: 'public', name: 'ideas', slug: 'ideas' },
    })
    const manifest = packManifest()
    const preview = await previewSystemPack({ workspaceId: seed.workspaceId, manifest, answers })
    expect(preview.channelNames.ideas).toBe('ideas-2')
    expect(preview.conflicts.join('\n')).toContain('#ideas is taken')

    const applied = await applySystemPack({
      workspaceId: seed.workspaceId,
      manifest,
      answers,
      actorUserId: seed.owner,
      channelNames: preview.channelNames,
    })
    expect(applied.errors).toEqual([])
    const created = await db.conversation.findMany({
      where: { workspaceId: seed.workspaceId, slug: { in: ['ideas', 'ideas-2', 'evolution'] } },
    })
    expect(created.map((c: any) => c.slug).sort()).toEqual(['evolution', 'ideas', 'ideas-2'])
    // The pre-existing #ideas was adopted by nothing: systemManagedBy stays null.
    expect((await db.conversation.findUnique({ where: { id: existing.id } }))?.systemManagedBy).toBeNull()

    await uninstallSystemPack({ workspaceId: seed.workspaceId, actorUserId: seed.owner, bindings: applied.bindings })
    expect(await db.conversation.findUnique({ where: { id: existing.id } })).toBeTruthy()
  })
})

describe('answers', () => {
  test('every answer lands in the prompts and profile (no literal {{answers.*}})', async () => {
    const manifest = packManifest()
    const applied = await applySystemPack({
      workspaceId: seed.workspaceId,
      manifest,
      answers,
      actorUserId: seed.owner,
    })
    const projectId = applied.bindings.projects['self-evolving']
    const agentsMd = readFileSync(join(workspacesDir, projectId, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).not.toContain('{{answers.')
    expect(agentsMd).toContain('18:00')
    await uninstallSystemPack({ workspaceId: seed.workspaceId, actorUserId: seed.owner, bindings: applied.bindings })
  })

  test('the answered hour and timezone reach the daily schedule', async () => {
    const manifest = packManifest()
    const applied = await applySystemPack({
      workspaceId: seed.workspaceId,
      manifest,
      answers,
      actorUserId: seed.owner,
    })
    const daily = await db.agentSchedule.findFirst({ where: { workspaceId: seed.workspaceId, name: 'Daily self review' } })
    expect(daily.timezone).toBe('America/New_York')
    expect(daily.cronExpression).toBe('0 18 * * *')
    await uninstallSystemPack({ workspaceId: seed.workspaceId, actorUserId: seed.owner, bindings: applied.bindings })
  })
})
