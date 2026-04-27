// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bun SQLite driver — wraps `bun:sqlite` behind a {@link SqliteDriver}.
 * Only usable inside Bun (checked via `typeof Bun !== 'undefined'`).
 */
import { createRequire } from 'node:module'
import type { CreateSqliteDriver, SqliteDriver } from './types.js'

/** Works in both ESM (import.meta.url) and tsup-CJS output (__filename). */
const req = createRequire(
  typeof __filename === 'string' ? __filename : (import.meta as { url: string }).url,
)

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => void
  close(): void
}

interface BunSqliteModule {
  Database: new (path: string) => RawDatabase
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

export const createBunDriver: CreateSqliteDriver = (dbPath: string): SqliteDriver => {
  if (!isBunRuntime()) {
    throw new Error('[@shogo-ai/sdk/memory] bun:sqlite driver requires Bun runtime')
  }
  // `bun:sqlite` is a Bun builtin and cannot be statically imported in Node.
  const mod = req('bun:sqlite') as BunSqliteModule
  const db = new mod.Database(dbPath)
  return wrap(db)
}

function wrap(db: RawDatabase): SqliteDriver {
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql)
      return {
        run: (...args: unknown[]) => stmt.run(...args),
        get: (...args: unknown[]) => stmt.get(...args),
        all: (...args: unknown[]) => stmt.all(...args),
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: <F extends (...args: any[]) => any>(fn: F) => db.transaction(fn),
    close: () => db.close(),
  }
}
