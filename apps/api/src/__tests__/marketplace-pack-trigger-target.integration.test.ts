// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pack's `work_item` trigger installs through the marketplace apply engine.
 *
 * The triggers API validates `workItemTarget` as `{ board, column?, mapping: {
 * title, … }, dedupeKey? }`. `applySystemPack` used to send a flat card, so
 * `department-people` failed with `mapping.title is required` while the
 * runtime's `system_apply` (which built the nested shape) worked — the
 * runtime↔marketplace drift decision #2 exists to prevent. Both now build it
 * with `cardToWorkItemTarget`, and this asserts the pack that exposed it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb, seedWorkspace } from './helpers/channels-test-db'
import { renderPackYaml } from '@shogo/agent-runtime/src/pack-templates'
import { parseSystemManifest } from '@shogo/agent-runtime/src/system-manifest'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { applySystemPack } = await import('../services/system-apply.service')
const db = prisma as any

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a pack work_item trigger', () => {
  test('department-people installs: its trigger gets the mapping shape the API validates', async () => {
    const seed = await seedWorkspace(db)
    const parsed = parseSystemManifest(renderPackYaml('department-people'))
    expect(parsed.ok).toBe(true)
    const manifest = parsed.manifest!

    const result = await applySystemPack({ workspaceId: seed.workspaceId, actorUserId: seed.owner, manifest })

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)

    const subscriptions = await db.eventSubscription.findMany({ where: { workspaceId: seed.workspaceId } })
    expect(subscriptions.length).toBe(manifest.triggers.length)
    const cardTrigger = subscriptions.find((s: any) => s.target === 'work_item')
    expect(cardTrigger).toBeTruthy()
    expect(cardTrigger.workItemTarget.mapping.title).toBeTruthy()
    expect(typeof cardTrigger.workItemTarget.boardId).toBe('string')
  })
})
