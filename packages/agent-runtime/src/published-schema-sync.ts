// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Schema synchronisation for a published Postgres pod (SHO-551 §D).
 *
 * On every boot the pod checks whether its DATABASE_URL's schema matches the
 * app's `prisma/schema.prisma`. When it does, the push is skipped
 * (`status: 'unchanged'`), keeping the boot time predictable. When it doesn't,
 * the schema is re-pushed (`status: 'applied'`). A failure is recorded as
 * `status: 'failed'` with the raw error message.
 *
 * Nothing here reaches a database directly — it shells out to the Prisma CLI the
 * same way `pushPublishedSchema` does in the API. That keeps the credential flow
 * in one place: the pod's DATABASE_URL is a direct Postgres URL, not the PgBouncer
 * pooler, so the push succeeds.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type SchemaSyncStatus = 'applied' | 'unchanged' | 'failed'

export interface SchemaSyncResult {
  status: SchemaSyncStatus
  /** Wall-clock time for the db push, or 0 when skipped. */
  timings: { dbPush: number }
  /** Error message when `status === 'failed'`. */
  error?: string
}

/** Identity of a schema text, stable across whitespace/comment changes. */
export function schemaIdentity(schemaText: string): string {
  const normalised = schemaText
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
  return createHash('sha1').update(normalised, 'utf-8').digest('hex')
}

/**
 * State persisted across reboots so the pod can short-circuit a push
 * when nothing has changed.
 */
export interface SchemaState {
  /** Identity of the schema that was last successfully applied. */
  appliedHash: string
}

/**
 * Ensure the pod's Postgres database schema is up to date.
 *
 * @param projectDir — workspace root containing `prisma/schema.prisma`
 * @param databaseUrl — direct (non-pooled) Postgres URL for the pod
 * @param lastState — the hash applied on the previous boot, or null
 * @param deps — test seam; defaults use the Prisma CLI
 */
export async function ensureAdditiveSchema(
  projectDir: string,
  databaseUrl: string,
  lastState: SchemaState | null,
  deps: { runDbPush?: (projectDir: string, databaseUrl: string) => Promise<void> } = {},
): Promise<SchemaSyncResult & { hash: string }> {
  const schemaPath = join(projectDir, 'prisma', 'schema.prisma')
  if (!existsSync(schemaPath)) {
    return { status: 'unchanged', timings: { dbPush: 0 }, hash: '' }
  }
  const schemaText = readFileSync(schemaPath, 'utf-8')
  const hash = schemaIdentity(schemaText)

  if (lastState?.appliedHash === hash) {
    return { status: 'unchanged', timings: { dbPush: 0 }, hash }
  }

  const run = deps.runDbPush ?? defaultRunDbPush
  const t0 = Date.now()
  try {
    await run(projectDir, databaseUrl)
    return { status: 'applied', timings: { dbPush: Date.now() - t0 }, hash }
  } catch (err: any) {
    return {
      status: 'failed',
      timings: { dbPush: Date.now() - t0 },
      hash,
      error: String(err?.message ?? err).slice(0, 500),
    }
  }
}

async function defaultRunDbPush(projectDir: string, databaseUrl: string): Promise<void> {
  const { pkg } = await import('@shogo/shared-runtime')
  await pkg.prismaDbPushAsync(projectDir, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  })
}
