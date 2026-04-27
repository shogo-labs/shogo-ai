// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Minimal SQLite statement surface used by {@link MemorySearchEngine} */
export interface SqliteStatement {
  run(...args: unknown[]): unknown
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

/** Minimal SQLite database surface (Bun Database + better-sqlite3 compatible) */
export interface SqliteDriver {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  /** better-sqlite3 / bun:sqlite return a variadic transactional wrapper */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<F extends (...args: any[]) => any>(fn: F): (...args: Parameters<F>) => void
  close(): void
}

export type CreateSqliteDriver = (dbPath: string) => SqliteDriver
