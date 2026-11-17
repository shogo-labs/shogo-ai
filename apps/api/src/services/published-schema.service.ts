// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Schema and seed at publish (SHO-308 §1).
 *
 * A published environment's database is only useful once the app's own
 * `prisma/schema.prisma` has been applied to it, and only correct once the rows
 * the developer built the app against are in it. Both happen here, in this
 * order, inside the publish pipeline:
 *
 *   provisioning (published-database.service)  →  schema push  →  seed  →  Secret
 *
 * The project's runtime (`/agent/published-schema`) exports the Postgres schema
 * and, on a first deploy, `dev.db` as seed SQL: it is the only place with those
 * files. The push and the load run here (`published-schema-push.ts`), inside the
 * cluster, because a runtime may live on a host outside the cluster network
 * (metal), and the database credential must not enter a sandbox that runs user
 * code.
 *
 * Two guards live here rather than in the runtime:
 *   - **destructive changes** are classified against the schema the database
 *     already has (`PublishedEnvironment.dbSchema`) and refused with
 *     `destructive_schema_change` unless the caller accepts data loss (AC 2);
 *   - **seeding** only happens on an environment's first deploy, so a republish
 *     can never overwrite data the live site has accumulated.
 */

import { prisma } from '../lib/prisma'
import {
  classifySchemaChange,
  describeDestructiveChanges,
  type DestructiveChange,
  type PublishedEnvironmentName,
} from '@shogo/shared-runtime/published-database'
import { ensureEnvironmentDatabase, type PublishedDatabase } from './published-database.service'
import { pushPublishedSchema } from './published-schema-push'

const SCHEMA_TIMEOUT_MS = 180_000

export interface PreparedEnvironmentDatabase {
  /**
   * The environment's database, or null in local/desktop mode — a desktop
   * publish keeps SQLite and has no `projects-pg` to provision on.
   */
  database: PublishedDatabase | null
  /** True when this publish pushed the app's schema at the database. */
  applied: boolean
  /** True when `prisma/dev.db` was loaded (an environment's first deploy). */
  seeded: boolean
  seededRows: number
  schemaHash: string | null
  warnings: string[]
}

export type PrepareEnvironmentDatabaseResult =
  | { ok: true; value: PreparedEnvironmentDatabase }
  | {
      ok: false
      code: string
      message: string
      status: number
      details?: Record<string, unknown>
    }

function isKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

/**
 * Call the project's runtime publish-schema endpoint.
 *
 * Same auth and namespace as `/agent/dist-files`: `x-runtime-token` derived for
 * the project, `/agent/*` so the user app's own `/api/*` proxy can never shadow
 * it.
 */
async function callRuntimeSchema(
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const { getProjectPodUrl } = await import('../lib/knative-project-manager')
  const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
  const podUrl = await getProjectPodUrl(projectId)
  const response = await fetch(
    `${podUrl}/agent/published-schema?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-runtime-token': await deriveProjectRuntimeToken(projectId),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SCHEMA_TIMEOUT_MS),
    },
  )
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data }
}

/**
 * Make one published environment's database match the app: provision (or
 * reuse) it, apply the schema, seed it on first deploy, then hand the pod its
 * `DATABASE_URL`.
 *
 * Every failure returns a code the publish route, the Deployment tab and the
 * agent's `publish` can all surface verbatim — publish never proceeds with a
 * half-prepared database.
 */
export async function prepareEnvironmentDatabase(
  projectId: string,
  environment: PublishedEnvironmentName,
  opts: { allowDataLoss?: boolean } = {},
): Promise<PrepareEnvironmentDatabaseResult> {
  const fail = (code: string, message: string, status = 400, details?: Record<string, unknown>) =>
    ({ ok: false, code, message, status, details }) as const

  // Local / desktop mode: a desktop publish keeps SQLite. There is no
  // projects-pg to provision on and no cloud runtime to push from, so this is a
  // no-op rather than a refusal — the desktop's own publish path is unchanged.
  if (!isKubernetes()) {
    return {
      ok: true,
      value: {
        database: null,
        applied: false,
        seeded: false,
        seededRows: 0,
        schemaHash: null,
        warnings: [],
      },
    }
  }

  // 1. Provision the database (idempotent) without exposing it to the pod yet:
  //    the Secret is written only after the schema is on it, because the pod
  //    reads the Secret at boot.
  const provisioned = await ensureEnvironmentDatabase(projectId, environment)
  if (!provisioned.ok) return provisioned

  // 2. Nothing to push if the app declares no models.

  // 3. Ask the runtime what the app's schema becomes on Postgres.
  let described: { ok: boolean; status: number; data: any }
  try {
    described = await callRuntimeSchema(projectId, { mode: 'describe' })
  } catch (err: any) {
    return fail(
      'schema_unavailable',
      `Could not read the app's schema from its runtime: ${err?.message ?? 'unknown error'}`,
      503,
    )
  }
  if (!described.ok) {
    return fail(
      described.data?.code ?? 'schema_unavailable',
      described.data?.message ?? 'Could not read the app\'s Prisma schema',
      400,
    )
  }

  const resolved = described.data?.schema as
    | { content: string; hash: string; warnings: string[] }
    | null
  if (!resolved) {
    // No models: a static app, or a server app with nothing persisted. Nothing
    // to push and nothing to seed — and the pod stays on SQLite, because a
    // DATABASE_URL pointing at an empty database the app never reads only adds a
    // way to fail.
    return {
      ok: true,
      value: {
        database: provisioned.value,
        applied: false,
        seeded: false,
        seededRows: 0,
        schemaHash: null,
        warnings: [],
      },
    }
  }

  const env = await prisma.publishedEnvironment.findUnique({
    where: { projectId_name: { projectId, name: environment } },
    select: { id: true, dbSchema: true, dbSchemaHash: true, dbProvider: true },
  })

  // 4. Classify against the schema the database already has. A dropped column or
  //    model destroys rows Prisma will not warn about until after the push.
  const destructive: DestructiveChange[] =
    env?.dbSchema && env.dbSchemaHash !== resolved.hash
      ? classifySchemaChange(env.dbSchema, resolved.content)
      : []
  if (destructive.length > 0 && opts.allowDataLoss !== true) {
    console.warn(
      `[published-schema] refusing a destructive schema change on ${projectId}/${environment}: ` +
        destructive.map((change) => change.kind).join(', '),
    )
    return fail(
      'destructive_schema_change',
      describeDestructiveChanges(destructive),
      409,
      {
        environment,
        changes: destructive.map((change) => ({ kind: change.kind, name: change.name, message: change.message })),
      },
    )
  }

  const unchanged = env?.dbSchemaHash === resolved.hash && env?.dbProvider === 'postgres'
  // Seed only a database that has never had one: republishing must never
  // overwrite what the live site has written (Q4 seeds staging from dev.db, not
  // from production, and this is the same rule for both environments).
  //
  // Deliberately NOT tied to `allowDataLoss`: the seed is a plain INSERT with the
  // seeded ids, so reloading it into a populated database can only fail on a
  // duplicate key — after the destructive push it was meant to rescue has already
  // dropped the column. Accepting data loss accepts the drop; it does not refill
  // the table.
  const seed = !env?.dbSchema

  let applied: { hash: string; warnings: string[]; seededRows: number } | null = null
  if (!unchanged) {
    // The runtime exports the schema (and, on a first deploy, dev.db as SQL);
    // the push itself runs here, inside the cluster, where projects-pg is
    // reachable. The database URL never leaves the API.
    let exported: { ok: boolean; status: number; data: any }
    try {
      exported = await callRuntimeSchema(projectId, {
        mode: 'export',
        seed,
        expectedHash: resolved.hash,
      })
    } catch (err: any) {
      return fail(
        'schema_unavailable',
        `Could not read the app's schema from its runtime: ${err?.message ?? 'unknown error'}`,
        503,
      )
    }
    if (!exported.ok) {
      return fail(
        exported.data?.code ?? 'schema_unavailable',
        exported.data?.message ?? 'Could not read the app\'s Prisma schema',
        exported.status === 409 || exported.status === 413 ? exported.status : 400,
        { environment },
      )
    }
    const schema = exported.data?.schema as { content: string; hash: string; warnings: string[] } | undefined
    if (!schema?.content) {
      return fail('schema_unavailable', 'The runtime returned no schema to apply', 502, { environment })
    }
    const seedSql: string | null = seed ? (exported.data?.seed?.sql ?? null) : null

    const pushed = await pushPublishedSchema({
      schema: schema.content,
      seedSql,
      databaseUrl: provisioned.value.directUrl,
    })
    if (!pushed.ok) {
      return fail(pushed.code, pushed.message, 500, { environment })
    }
    applied = {
      hash: schema.hash,
      warnings: schema.warnings ?? [],
      seededRows: seedSql ? (exported.data?.seed?.rows ?? 0) : 0,
    }
  }

  // 5. Only now is the database safe to expose: the pod reads its DATABASE_URL
  //    from the Secret, so the Secret is the switch from SQLite to Postgres.
  const exposed = await ensureEnvironmentDatabase(projectId, environment, { exposeToPod: true })
  if (!exposed.ok) return exposed

  const hash = applied?.hash ?? resolved.hash
  if (env) {
    try {
      await prisma.publishedEnvironment.update({
        where: { id: env.id },
        data: { dbProvider: 'postgres', dbSchema: resolved.content, dbSchemaHash: hash },
      })
    } catch (err: any) {
      console.warn(
        `[published-schema] applied the schema to ${projectId}/${environment} but could not record it: ` +
          `${err?.message ?? err}`,
      )
    }
  }

  return {
    ok: true,
    value: {
      database: exposed.value,
      applied: !unchanged,
      seeded: seed && (applied?.seededRows ?? 0) > 0,
      seededRows: applied?.seededRows ?? 0,
      schemaHash: hash,
      warnings: applied?.warnings ?? resolved.warnings ?? [],
    },
  }
}
