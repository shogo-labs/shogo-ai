// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project.settings encoding helpers.
 *
 * `Project.settings` is a `Json?` column, but every client write path builds it
 * with `JSON.stringify(...)` and PATCHes/POSTs the resulting *string*. Postgres
 * stores that faithfully as a jsonb string scalar rather than an object, so
 * Prisma reads it back as a `string` and `settings?.techStackId` evaluates to
 * `undefined` — the stack silently degrades to the agent-runtime default.
 *
 * SQLite (local dev + desktop) hides the bug entirely: `wrapForSqlite` in
 * `lib/prisma.ts` JSON-parses these columns on read, so an object comes back
 * either way. That asymmetry is why this only ever reproduced on cloud.
 *
 * `normalizeProjectSettings` runs on the write path so the column always holds
 * a real object; `parseProjectSettings` tolerates rows written before it.
 */

/** Guard against pathological nesting from repeated re-encoding. */
const MAX_UNWRAP_DEPTH = 5

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read `Project.settings` as an object regardless of how it was encoded.
 * Returns null for absent/unparseable values so callers can use `?.` freely.
 */
export function parseProjectSettings(raw: unknown): Record<string, unknown> | null {
  let value = raw
  for (let depth = 0; typeof value === 'string' && depth < MAX_UNWRAP_DEPTH; depth++) {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return isPlainObject(value) ? value : null
}

/**
 * Coerce an inbound `settings` value into the object form the column is meant
 * to hold. Values that don't decode to an object are passed through untouched
 * so a malformed payload fails loudly at the DB rather than being silently
 * replaced here.
 */
export function normalizeProjectSettings(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  return parseProjectSettings(raw) ?? raw
}
