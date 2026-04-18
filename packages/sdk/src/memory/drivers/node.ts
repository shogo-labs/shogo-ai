// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Node SQLite driver — wraps `better-sqlite3` behind a {@link SqliteDriver}.
 * `better-sqlite3` is an optional peer dependency; install it separately.
 */
import { createRequire } from 'node:module'
import type { CreateSqliteDriver, SqliteDriver } from './types.js'

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

type BetterSqliteCtor = new (path: string) => RawDatabase

export const createNodeDriver: CreateSqliteDriver = (dbPath: string): SqliteDriver => {
  let Ctor: BetterSqliteCtor
  try {
    const mod = req('better-sqlite3') as BetterSqliteCtor | { default: BetterSqliteCtor }
    Ctor = (mod as { default?: BetterSqliteCtor }).default ?? (mod as BetterSqliteCtor)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      `[@shogo-ai/sdk/memory] Missing optional peer dependency 'better-sqlite3'. Install it: npm install better-sqlite3 (${detail})`,
    )
  }
  const db = new Ctor(dbPath)
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
