// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-66 QA e2e — every catalogue pack installs into a fresh workspace.
 *
 * AC 7: the catalogue lists 13 installable packs and each one has working
 * questions and a plan that applies clean. AC 4: a department pack creates its
 * channel + board + agent in one click. This drives the real apply engine
 * against a real SQLite DB, one pack at a time, with only the questions'
 * defaults (the "skip everything" path), and asserts that nothing is reported
 * as an error and that uninstall leaves the workspace as it found it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'sho66-catalogue-'))
process.env.WORKSPACES_DIR = workspacesDir

const { prisma } = await import('../lib/prisma')
const { applySystemPack, previewSystemPack, uninstallSystemPack } = await import('../services/system-apply.service')
const { listPackTemplates, getPackTemplate } = await import('@shogo/agent-runtime/src/pack-templates')
const { parseSystemManifest } = await import('@shogo/agent-runtime/src/system-manifest')

const db = prisma as any
let seed: SeededWorkspace

const packs = listPackTemplates()

function manifestOf(id: string) {
  const parsed = parseSystemManifest(getPackTemplate(id)!.manifest)
  if (!parsed.ok || !parsed.manifest) throw new Error(`${id} does not parse: ${parsed.errors.join('; ')}`)
  return parsed.manifest!
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

describe('the catalogue', () => {
  test('lists 13 packs, each with questions', () => {
    expect(packs.length).toBe(13)
    for (const pack of packs) {
      const manifest = manifestOf(pack.id)
      expect({ pack: pack.id, questions: (manifest.setup?.questions.length ?? 0) > 0 }).toEqual({ pack: pack.id, questions: true })
    }
  })

  test('every pack installs with only its defaults and uninstalls clean', async () => {
    const problems: string[] = []
    for (const pack of packs) {
      const manifest = manifestOf(pack.id)
      const preview = await previewSystemPack({ workspaceId: seed.workspaceId, manifest })
      for (const line of preview.plan.filter((l) => l.startsWith('cannot create schedule'))) problems.push(`${pack.id}: preview ${line}`)

      const applied = await applySystemPack({
        workspaceId: seed.workspaceId,
        manifest,
        actorUserId: seed.owner,
        channelNames: preview.channelNames,
      })
      for (const e of applied.errors) problems.push(`${pack.id}: apply ${e}`)
      if (applied.applied.length === 0) problems.push(`${pack.id}: applied nothing`)

      const schedules = await db.agentSchedule.findMany({ where: { workspaceId: seed.workspaceId } })
      if (schedules.length !== manifest.schedules.length) problems.push(`${pack.id}: ${schedules.length} schedules, declared ${manifest.schedules.length}`)
      for (const s of schedules) {
        if (!s.cronExpression) problems.push(`${pack.id}: schedule ${s.name} has no cron`)
        if (!s.timezone) problems.push(`${pack.id}: schedule ${s.name} has no timezone`)
        if (s.prompt.includes('{{')) problems.push(`${pack.id}: schedule ${s.name} has an unresolved template`)
      }

      const removed = await uninstallSystemPack({ workspaceId: seed.workspaceId, actorUserId: seed.owner, bindings: applied.bindings })
      for (const e of removed.errors) problems.push(`${pack.id}: uninstall ${e}`)
      const leftSchedules = await db.agentSchedule.count({ where: { workspaceId: seed.workspaceId } })
      if (leftSchedules !== 0) problems.push(`${pack.id}: ${leftSchedules} schedules left after uninstall`)
      const leftChannels = await db.conversation.count({ where: { workspaceId: seed.workspaceId } })
      if (leftChannels !== 0) problems.push(`${pack.id}: ${leftChannels} channels left after uninstall`)
    }
    expect(problems).toEqual([])
  })
})
