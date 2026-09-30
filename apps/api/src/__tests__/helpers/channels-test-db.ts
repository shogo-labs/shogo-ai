// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Real SQLite database for workspace-channel tests: replays the desktop
 * migration history into a temp file and points the API's Prisma client at
 * it. Must run before anything imports `lib/prisma`.
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../desktop/prisma/migrations')

export function setupChannelsTestDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-channels-'))
  const dbPath = join(dir, 'test.db')
  const sqlite = new Database(dbPath)
  const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const name of migrations) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8'))
  }
  sqlite.close()
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_APP_DATABASE_URL = `file:${dbPath}`
  process.env.SHOGO_DATA_DIR = dir
  return { dir, dbPath }
}

export interface SeededWorkspace {
  workspaceId: string
  otherWorkspaceId: string
  owner: string
  member: string
  viewer: string
  outsider: string
  projectId: string
  foreignProjectId: string
}

export async function seedWorkspace(db: any): Promise<SeededWorkspace> {
  const suffix = crypto.randomUUID().slice(0, 8)
  const mkUser = (name: string) => db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [owner, member, viewer, outsider] = await Promise.all([
    mkUser('owner'), mkUser('member'), mkUser('viewer'), mkUser('outsider'),
  ])
  const ws = await db.workspace.create({ data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' } })
  const other = await db.workspace.create({ data: { name: 'Other', slug: `other-${suffix}`, kind: 'team' } })
  await db.member.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'owner' } })
  await db.member.create({ data: { userId: member.id, workspaceId: ws.id, role: 'member' } })
  await db.member.create({ data: { userId: viewer.id, workspaceId: ws.id, role: 'viewer' } })
  await db.member.create({ data: { userId: outsider.id, workspaceId: other.id, role: 'owner' } })
  const project = await db.project.create({ data: { name: 'Billing Bot', workspaceId: ws.id } })
  const foreign = await db.project.create({ data: { name: 'Elsewhere', workspaceId: other.id } })
  return {
    workspaceId: ws.id,
    otherWorkspaceId: other.id,
    owner: owner.id,
    member: member.id,
    viewer: viewer.id,
    outsider: outsider.id,
    projectId: project.id,
    foreignProjectId: foreign.id,
  }
}

export function sseResponse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
