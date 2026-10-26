// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A pack's three JSON columns, written through the *local* (SQLite) client.
 *
 * `systemPack`, `answers` and `packBindings` are `Json?` on Postgres and
 * `String?` on SQLite, so the object ⇄ string conversion lives in
 * `JSON_OBJECT_FIELDS` (`lib/create-prisma-client.ts`). Missing from that set,
 * publishing a pack and installing one both throw
 * `PrismaClientValidationError` on desktop while cloud is fine — the
 * desktop/cloud divergence the channel rules fail a card for. Asserted on the
 * desktop migration history replayed into a real SQLite file, not on PG.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb, seedWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const db = prisma as any

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const packManifest = {
  version: 1,
  name: 'Self Evolving',
  schedules: [{ key: 'daily-evolution', hour: '{{answers.profile.review-time}}' }],
}

const answers = { profile: { 'review-time': '18:30', timezone: 'America/New_York' } }
const packBindings = { projects: { 'self-evolving': 'p-1' }, channels: {}, boards: {}, schedules: { 'daily-evolution': 's-1' }, triggers: {} }

async function listingFixture() {
  const seed = await seedWorkspace(db)
  const creator = await db.creatorProfile.create({ data: { userId: seed.owner, displayName: 'Owner' } })
  const suffix = crypto.randomUUID().slice(0, 8)
  const listing = await db.marketplaceListing.create({
    data: {
      projectId: seed.projectId,
      creatorId: creator.id,
      slug: `pack-${suffix}`,
      title: 'Self Evolving',
      shortDescription: 'A pack',
    },
  })
  return { seed, listing }
}

describe('pack JSON columns on the desktop client', () => {
  test('a listing version stores the parsed pack and reads it back as an object', async () => {
    const { listing } = await listingFixture()
    const version = await db.marketplaceListingVersion.create({
      data: { listingId: listing.id, version: '1.0.0', systemPack: packManifest },
    })
    expect(version.systemPack).toEqual(packManifest)
    const reread = await db.marketplaceListingVersion.findUnique({ where: { id: version.id } })
    expect(reread.systemPack).toEqual(packManifest)
  })

  test('an install stores its answers and bindings, and updates them', async () => {
    const { seed, listing } = await listingFixture()
    const install = await db.marketplaceInstall.create({
      data: {
        listingId: listing.id,
        projectId: seed.projectId,
        workspaceId: seed.workspaceId,
        userId: seed.owner,
        installModel: 'fork',
        installedVersion: '1.0.0',
        answers,
        packBindings,
      },
    })
    expect(install.answers).toEqual(answers)
    expect(install.packBindings).toEqual(packBindings)

    const next = { ...packBindings, schedules: { 'daily-evolution': 's-2' } }
    const updated = await db.marketplaceInstall.update({ where: { id: install.id }, data: { packBindings: next } })
    expect(updated.packBindings).toEqual(next)

    const reread = await db.marketplaceInstall.findFirst({ where: { id: install.id } })
    expect(reread.answers).toEqual(answers)
    expect(reread.packBindings).toEqual(next)
  })
})
