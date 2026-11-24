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
import { headLiveSeedArchive, readLiveSeedArchive } from './published-live-seed'
import type { SeedOrphan } from '@shogo/shared-runtime/published-schema'

const SCHEMA_TIMEOUT_MS = 180_000

export interface PreparedEnvironmentDatabase {
  /**
   * The environment's database, or null in local/desktop mode — a desktop
   * publish keeps SQLite and has no `projects-pg` to provision on.
   */
  database: PublishedDatabase | null
  /** True when this publish pushed the app's schema at the database. */
  applied: boolean
  /** True when this publish loaded a database into the environment. */
  seeded: boolean
  /**
   * Which database the seed came from. `live-archive` is the archive the
   * environment was already serving (a SQLite→Postgres switchover); `dev.db`
   * is the builder's workspace database (an environment that was never live).
   */
  seededFrom: 'live-archive' | 'dev.db' | null
  seededRows: number
  schemaHash: string | null
  warnings: string[]
  /**
   * Rows that were silently left out of the seed because their FK target was
   * deleted. The rows stay in the SQLite archive, which is never deleted, so
   * they can be recovered.
   */
  orphans: SeedOrphan[]
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
 * The destructive changes a pending publish would make, without applying any of
 * them.
 *
 * `prepareEnvironmentDatabase` learns this mid-pipeline — it needs the app's
 * schema as the runtime resolves it — so a refusal only reaches the caller as a
 * code (`destructive_schema_change`). Publishing is a background job now
 * (SHO-542), so the agent's `publish` tool reads the outcome from the publish
 * status and asks for the details with this: same describe call, same
 * classifier, no provision, no push, no seed.
 */
export async function describePendingDestructiveChanges(
  projectId: string,
  environment: PublishedEnvironmentName,
): Promise<{ message: string; changes: Array<{ kind: string; name: string; message: string }> } | null> {
  const env = await prisma.publishedEnvironment.findUnique({
    where: { projectId_name: { projectId, name: environment } },
    select: { dbSchema: true, dbSchemaHash: true },
  })
  if (!env?.dbSchema) return null

  const described = await callRuntimeSchema(projectId, { mode: 'describe' })
  const resolved = described.ok ? (described.data?.schema as { content: string; hash: string } | null) : null
  if (!resolved || env.dbSchemaHash === resolved.hash) return null

  const destructive = classifySchemaChange(env.dbSchema, resolved.content)
  if (destructive.length === 0) return null
  return {
    message: describeDestructiveChanges(destructive),
    changes: destructive.map((change) => ({ kind: change.kind, name: change.name, message: change.message })),
  }
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
  opts: {
    allowDataLoss?: boolean
    writeFreeze?: import('./published-write-freeze').WriteFreeze
    /**
     * Start a brand-new published database with no rows (`data: 'empty'`, §G4).
     * Valid only on an environment's FIRST Postgres deploy with nothing to
     * lose: no schema of its own and no live SQLite archive. The schema is
     * pushed and nothing is seeded — `prisma/dev.db` is never read, so a builder
     * database over the seed cap cannot block the switch.
     */
    data?: 'empty'
  } = {},
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
        seededFrom: null,
        seededRows: 0,
        schemaHash: null,
        warnings: [],
        orphans: [],
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
        seededFrom: null,
        seededRows: 0,
        schemaHash: null,
        warnings: [],
        orphans: [],
      },
    }
  }

  const env = await prisma.publishedEnvironment.findUnique({
    where: { projectId_name: { projectId, name: environment } },
    select: {
      id: true,
      dbSchema: true,
      dbSchemaHash: true,
      dbProvider: true,
      // The published-data archive key is `{subdomain}/data.tar.gz`.
      subdomain: true,
    },
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

  // §G4: an app whose builder database is too big to seed (Nada App's 91 MB) can
  // be started empty instead — but only where that cannot cost anything. Both
  // refusals are named, so the caller acts on them instead of guessing why the
  // publish stopped.
  const startEmpty = opts.data === 'empty'
  if (startEmpty) {
    if (env?.dbSchema) {
      return fail(
        'data_empty_not_allowed',
        `${environment} already has a Postgres schema. data: 'empty' only starts a database that has never been ` +
          `seeded — it never wipes one. Publish without the option to apply the schema to the existing database.`,
        400,
        { environment },
      )
    }
    const live = env?.subdomain
      ? await headLiveSeedArchive(env.subdomain)
      : ({ ok: true, exists: false, bytes: 0 } as const)
    if (!live.ok) return fail(live.code, live.message, 413, { environment })
    if (live.exists) {
      return fail(
        'data_empty_not_allowed',
        `${environment} is already live on SQLite (${env?.subdomain}/data.tar.gz, ` +
          `${(live.bytes / (1024 * 1024)).toFixed(1)} MB), so starting empty would leave everything that site has ` +
          `written behind. Publish without the option to move its rows to Postgres instead.`,
        400,
        { environment, archiveBytes: live.bytes },
      )
    }
    console.log(
      `[published-schema] ${projectId}/${environment} starting empty (data: 'empty') — schema only, no seed`,
    )
  }

  // Seed only a database that has never had one: republishing must never
  // overwrite what the live site has written (Q4 seeds staging from dev.db, not
  // from production, and this is the same rule for both environments).
  //
  // Deliberately NOT tied to `allowDataLoss`: the seed is a plain INSERT with the
  // seeded ids, so reloading it into a populated database can only fail on a
  // duplicate key — after the destructive push it was meant to rescue has already
  // dropped the column. Accepting data loss accepts the drop; it does not refill
  // the table.
  const seed = !env?.dbSchema && !startEmpty

  // A first deploy of an environment that is ALREADY LIVE ON SQLITE must seed
  // from what that site is serving, not from the builder's `prisma/dev.db`
  // (SHO-514). Every app published before its region had a `projects-pg` has
  // `dbSchema: null` while real rows — sign-ups, runs, uploads — sit in
  // `{subdomain}/data.tar.gz`; seeding from `dev.db` would hand Postgres the
  // builder's rows and orphan everything the live site accumulated.
  //
  // The archive is read, never deleted: it is what `PUBLISH_POSTGRES=off`
  // restores from, so the switch stays reversible.
  let liveSeed: { archive: string; bytes: number } | null = null
  if (seed && env?.subdomain) {
    // §G3: the archive is only as current as the serving pod's last upload (30 s
    // by default). Freeze writes and make the pod flush BEFORE reading it, or
    // every write since that upload — and every write the SQLite pod accepts
    // while the Postgres revision rolls out — is copied nowhere. The freeze stays
    // up until the caller releases it (after the new revision serves), and always
    // lifts through its own `end()`.
    if (opts.writeFreeze) {
      const frozen = await opts.writeFreeze.begin()
      if (!frozen.ok) return fail(frozen.code, frozen.message, 409, { environment })
    }
    const live = await readLiveSeedArchive(env.subdomain)
    if (!live.ok) {
      return fail(live.code, live.message, 413, { environment })
    }
    liveSeed = live.value
    if (liveSeed) {
      console.log(
        `[published-schema] ${projectId}/${environment} has no Postgres schema yet and is live on SQLite — ` +
          `seeding from its archive (${liveSeed.bytes} bytes of prisma/dev.db), not prisma/dev.db`,
      )
    } else if (opts.writeFreeze?.begun) {
      // Nothing to preserve, so nothing to freeze for: an app that has never been
      // live has no archive and no pending writes. Lift immediately rather than
      // holding a maintenance page over a publish that only pushes a schema.
      await opts.writeFreeze.end(null)
    }
  }
  const seededFrom = seed ? (liveSeed ? ('live-archive' as const) : ('dev.db' as const)) : null

  let applied: { hash: string; warnings: string[]; seededRows: number; orphans: SeedOrphan[] } | null = null
  if (!unchanged) {
    // The runtime exports the schema (and, on a first deploy, a database as
    // SQL); the push itself runs here, inside the cluster, where projects-pg is
    // reachable. The database URL never leaves the API.
    let exported: { ok: boolean; status: number; data: any }
    try {
      exported = await callRuntimeSchema(projectId, {
        mode: 'export',
        seed,
        expectedHash: resolved.hash,
        // The live database travels as the archive the runtime converts to seed
        // SQL — the converter stays in one place (the runtime's
        // `published-schema-export`), and the runtime still never gets a
        // database URL.
        ...(liveSeed ? { seedArchive: liveSeed.archive } : {}),
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

    // The runtime must PROVE it seeded from the archive we sent (SHO-541). A
    // runtime older than SHO-514's second half accepts `seedArchive` and
    // ignores it: it reads the builder's `prisma/dev.db` instead, which on a
    // SQLite→Postgres switchover means Postgres gets the BUILDER's rows while
    // the API reports a successful seed — the live site's sign-ups and uploads
    // orphaned, silently. Samsara's EU VM did exactly this four times on 23 Nov,
    // and only survived because the builder's own `dev.db` happened to be
    // unreadable.
    //
    // A reply with no seed at all is fine: nothing is pushed, so nothing can be
    // wrong. It is a seed WITH rows from somewhere else that must stop here.
    const seedSource = exported.data?.seedSource
    if (liveSeed && exported.data?.seed && seedSource !== 'archive') {
      return fail(
        'runtime_outdated',
        'The editing runtime is older than this publish needs: it would seed Postgres from the ' +
          "builder's database, not the live site's. Its runtime has to be recycled onto the current build before this publish can go through.",
        409,
        { environment, seedSource: seedSource ?? null },
      )
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
    const exportedOrphans: SeedOrphan[] = Array.isArray(exported.data?.orphans) ? exported.data.orphans : []
    applied = {
      hash: schema.hash,
      warnings: schema.warnings ?? [],
      seededRows: seedSql ? (exported.data?.seed?.rows ?? 0) : 0,
      orphans: exportedOrphans,
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
      seededFrom: seed && (applied?.seededRows ?? 0) > 0 ? seededFrom : null,
      seededRows: applied?.seededRows ?? 0,
      schemaHash: hash,
      warnings: applied?.warnings ?? resolved.warnings ?? [],
      orphans: applied?.orphans ?? [],
    },
  }
}
