// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Child script for `setupChannelsTestDb` in Postgres mode:
 *   bun pg-test-db.ts create <serverUrl> <dbName>   (create + apply cloud migrations)
 *   bun pg-test-db.ts drop <serverUrl> <dbName>
 * Runs as a separate process so the test helper can stay synchronous.
 */

import { SQL } from 'bun'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../../prisma/migrations')

const [action, serverUrl, dbName] = process.argv.slice(2)
if (!action || !serverUrl || !/^[a-z0-9_]+$/.test(dbName ?? '')) {
  console.error('usage: pg-test-db.ts create|drop <serverUrl> <dbName>')
  process.exit(2)
}

const admin = new SQL(serverUrl)
if (action === 'drop') {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.close()
  process.exit(0)
}

await admin.unsafe(`CREATE DATABASE "${dbName}"`)
await admin.close()

const url = new URL(serverUrl)
url.pathname = `/${dbName}`
const db = new SQL(url.toString())
const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
for (const name of migrations) {
  try {
    await db.unsafe(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8')).simple()
  } catch (err: any) {
    console.error(`migration ${name} failed: ${err?.message}`)
    process.exit(1)
  }
}
await db.close()
