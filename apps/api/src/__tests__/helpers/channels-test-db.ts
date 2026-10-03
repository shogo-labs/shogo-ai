// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Real database for workspace-channel tests: replays the desktop migration
 * history into a temp SQLite file and points the API's Prisma client at it.
 * Must run before anything imports `lib/prisma`.
 *
 * Set CHANNELS_TEST_PG_URL (a Postgres server URL whose user can create
 * databases) to run against a throwaway Postgres database with the cloud
 * migrations instead, e.g. to exercise the full-text search SQL:
 *   CHANNELS_TEST_PG_URL=postgresql://shogo:shogo_dev@localhost:55432/shogo bun test ./src/__tests__/conversation-search.integration.test.ts
 */

import { Database } from 'bun:sqlite'
import { afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../desktop/prisma/migrations')

const PG_SETUP_SCRIPT = resolve(import.meta.dir, 'pg-test-db.ts')

function setupPostgres(serverUrl: string, dir: string): void {
  const dbName = `shogo_channels_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const run = (action: 'create' | 'drop') => spawnSync(process.execPath, [PG_SETUP_SCRIPT, action, serverUrl, dbName], { encoding: 'utf-8' })
  const created = run('create')
  if (created.status !== 0) throw new Error(`Postgres test database setup failed: ${created.stderr || created.stdout}`)
  afterAll(() => { run('drop') })
  const url = new URL(serverUrl)
  url.pathname = `/${dbName}`
  delete process.env.SHOGO_LOCAL_MODE
  process.env.SHOGO_APP_DATABASE_URL = url.toString()
  process.env.SHOGO_DATA_DIR = dir
}

export function setupChannelsTestDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-channels-'))
  const dbPath = join(dir, 'test.db')
  const pgUrl = process.env.CHANNELS_TEST_PG_URL
  if (pgUrl) {
    setupPostgres(pgUrl, dir)
    return { dir, dbPath }
  }
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
