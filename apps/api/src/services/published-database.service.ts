// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Postgres at publish (SHO-308 §1) — the service half.
 *
 * On publish a server-backed app moves from the SQLite file inside the editing
 * runtime to a Postgres database of its own on the `projects-pg` cluster:
 *
 *   production → `project_<uuid>`         secret `published-db-<id>-production`
 *   staging    → `project_<uuid>_staging` secret `published-db-<id>-staging`
 *
 * Each environment owns a database and a role with no cross-database access, and
 * the `DATABASE_URL` written into the Secret points at PgBouncer, which is what
 * the published ksvc mounts (createPublishedServerService already references the
 * secret by name, so nothing here changes the pod's shape).
 *
 * Provisioning is idempotent: a second publish reuses the database and the
 * stored credentials, which is what makes republishing keep every row (AC 2).
 */

import { prisma } from '../lib/prisma'
import {
  publishedDbName,
  publishedDbSecretName,
  toPublishedDatabaseUrl,
  type PublishedEnvironmentName,
} from '@shogo/shared-runtime/published-database'
import {
  dropDatabase,
  getProjectsDbPoolerHost,
  provisionDatabase,
} from './database.service'

export interface PublishedDatabase {
  databaseName: string
  secretName: string
  /** The pooled URL the pod gets. Never returned to a browser. */
  url: string
  provider: 'postgres'
}

export type PublishedDatabaseResult =
  | { ok: true; value: PublishedDatabase }
  | { ok: false; code: string; message: string; status: number; details?: Record<string, unknown> }

/**
 * Provision (or re-use) the database for one published environment and mark the
 * environment row as Postgres-backed.
 *
 * Refusals are returned, not thrown: a publish that cannot reach `projects-pg`
 * must fail with a code the UI and the agent can act on, and must not leave an
 * environment row claiming Postgres it does not have.
 */
export async function ensureEnvironmentDatabase(
  projectId: string,
  environment: PublishedEnvironmentName,
  opts: { exposeToPod?: boolean } = {},
): Promise<PublishedDatabaseResult> {
  let databaseName: string
  let secretName: string
  try {
    databaseName = publishedDbName(projectId, environment)
    secretName = publishedDbSecretName(projectId, environment)
  } catch (err: any) {
    return {
      ok: false,
      code: 'invalid_project_id',
      message: err?.message ?? 'Cannot derive a database name for this project',
      status: 400,
    }
  }

  // Refuse before provisioning. A database whose pod URL does not resolve is
  // worse than no database: it looks provisioned, and the failure only shows up
  // inside the published pod.
  const poolerHost = getProjectsDbPoolerHost()
  if (!poolerHost) {
    console.error(
      `[published-database] PROJECTS_DB_POOLER_HOST is not set; refusing to provision "${databaseName}" for ${projectId}/${environment}`,
    )
    return {
      ok: false,
      code: 'database_unavailable',
      message:
        'Publishing to Postgres needs the projects database pooler, which is not deployed on this environment (PROJECTS_DB_POOLER_HOST is unset).',
      status: 503,
      details: { databaseName },
    }
  }

  let provisioned
  try {
    // The Secret is what moves the pod off SQLite, so it is written only when
    // the caller has already applied the Postgres schema (`exposeToPod`).
    // Without it the database exists but no pod reads it, which is the safe
    // state: publishing behaves exactly as it did before this existed.
    provisioned = await provisionDatabase(projectId, {
      databaseName,
      secretName,
      writeSecret: opts.exposeToPod === true,
    })
  } catch (err: any) {
    const notConfigured = /PROJECTS_DB_ADMIN_URL|not configured/i.test(err?.message ?? '')
    console.error(
      `[published-database] provisioning "${databaseName}" for ${projectId}/${environment} failed:`,
      err?.message ?? err,
    )
    return {
      ok: false,
      code: notConfigured ? 'database_unavailable' : 'database_provision_failed',
      message: notConfigured
        ? 'Publishing to Postgres needs the projects database cluster, which is not configured on this deployment.'
        : `Could not provision the ${environment} database: ${err?.message ?? 'unknown error'}`,
      status: 503,
      details: { databaseName },
    }
  }

  let url: string
  try {
    url = toPublishedDatabaseUrl(provisioned.connectionUrl, { poolerHost })
  } catch (err: any) {
    return {
      ok: false,
      code: 'database_provision_failed',
      message: `Provisioned "${databaseName}" but could not build its pooler URL: ${err?.message ?? 'unknown error'}`,
      status: 500,
      details: { databaseName },
    }
  }

  // The row records which database the environment owns so the Deployment tab,
  // the AC-6 replica guard and the teardown paths all agree on it. `dbProvider`
  // is only marked postgres once the pod can actually reach it, because
  // publishedLocalStateReason() reads this row to decide whether a second
  // replica is safe.
  try {
    await prisma.publishedEnvironment.updateMany({
      where: { projectId, name: environment },
      data: opts.exposeToPod === true
        ? { dbProvider: 'postgres', dbName: databaseName }
        : { dbName: databaseName },
    })
  } catch (err: any) {
    console.warn(
      `[published-database] could not record the database on ${projectId}/${environment}:`,
      err?.message ?? err,
    )
  }

  return {
    ok: true,
    value: { databaseName, secretName, url, provider: 'postgres' },
  }
}

/**
 * Drop one environment's database, role and Secret. Used by `delete_env` and by
 * unpublish. Best-effort: a database that is already gone is not an error, and a
 * failure here must not block the ksvc teardown that runs around it.
 */
export async function dropEnvironmentDatabase(
  projectId: string,
  environment: PublishedEnvironmentName,
): Promise<{ dropped: boolean; error?: string }> {
  let databaseName: string
  let secretName: string
  try {
    databaseName = publishedDbName(projectId, environment)
    secretName = publishedDbSecretName(projectId, environment)
  } catch (err: any) {
    return { dropped: false, error: err?.message ?? 'invalid project id' }
  }

  try {
    await dropDatabase(projectId, { databaseName, secretName })
  } catch (err: any) {
    console.error(
      `[published-database] dropping "${databaseName}" for ${projectId}/${environment} failed:`,
      err?.message ?? err,
    )
    return { dropped: false, error: err?.message ?? 'drop failed' }
  }

  try {
    await prisma.publishedEnvironment.updateMany({
      where: { projectId, name: environment },
      data: { dbProvider: null, dbName: null },
    })
  } catch {
    // The row is usually deleted alongside; nothing to repair if it is gone.
  }

  return { dropped: true }
}
