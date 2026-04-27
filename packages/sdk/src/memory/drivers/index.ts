// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SQLite driver detection. Prefers `bun:sqlite` when running under Bun;
 * falls back to `better-sqlite3` on Node.
 */
import { createBunDriver, isBunRuntime } from './bun.js'
import { createNodeDriver } from './node.js'
import type { CreateSqliteDriver } from './types.js'

/** Returns a `CreateSqliteDriver` suitable for the current runtime. */
export function detectDriver(): CreateSqliteDriver {
  return isBunRuntime() ? createBunDriver : createNodeDriver
}

/** Open a SQLite database using the auto-detected driver. */
export const createSqliteDriver: CreateSqliteDriver = (dbPath: string) => {
  return detectDriver()(dbPath)
}

export { createBunDriver, isBunRuntime } from './bun.js'
export { createNodeDriver } from './node.js'
export type { CreateSqliteDriver, SqliteDriver, SqliteStatement } from './types.js'
