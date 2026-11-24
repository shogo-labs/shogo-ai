// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure, env-only configuration for the publishing substrate seam. Kept
 * dependency-free (no k8s / metal / prisma imports) so both substrates and the
 * publish route can read it cheaply without pulling a heavy controller.
 */

import { parsePublishFlag, publishFlagAllows } from './publish-flag'

/**
 * Whether NEW publishes are OWNED by the metal substrate.
 *
 * Published apps run on **Knative** (SHO-308, Russell 2026-11-04). Metal is the
 * substrate for DEV / EDITING runtimes only — it is not a production target and
 * does not scale past one instance. So the default is Knative even when the
 * metal fleet is enabled (`SHOGO_METAL_ALL_PROJECTS=true`), which is exactly the
 * case that used to flip publishing to metal.
 *
 * Precedence:
 *   PUBLISH_SUBSTRATE=metal    → force metal (the escape hatch / rollback, and
 *                                what the cutover script uses to put a site back
 *                                on metal).
 *   PUBLISH_SUBSTRATE=knative  → force Knative (explicit, same as the default).
 *   unset (default)            → Knative, always.
 *
 * Note this only decides where NEW/re-published sites are provisioned and which
 * substrate the wake/always-on ops target for the CURRENT publish. Already-live
 * sites keep serving from wherever their SERVER_BACKED edge flag points until a
 * (re)publish or the cutover script (scripts/migrate-published-to-knative.ts)
 * flips them — so a rollback is a config flip, never a data move.
 */
export function isPublishMetalAuthoritative(): boolean {
  const override = (process.env.PUBLISH_SUBSTRATE || '').trim().toLowerCase()
  return override === 'metal'
}

/**
 * Whether a STATIC published app is served purely from PUBLISH_BUCKET + the
 * Cloudflare Worker (edge-only), with NO published nginx ksvc / DomainMapping.
 *
 * The Worker already serves `/`, `*.js`, etc. directly from the OCI PAR origin,
 * so the nginx `published-{id}` ksvc is redundant for pure-static serving — it
 * is the last Knative dependency for static apps. Edge-only is the default (the
 * Phase 0 win); set `PUBLISH_STATIC_KSVC=true` to restore the legacy behavior
 * of also provisioning the nginx ksvc (e.g. for a rollback).
 */
export function shouldServeStaticFromEdgeOnly(): boolean {
  return process.env.PUBLISH_STATIC_KSVC !== 'true'
}

/**
 * Whether this publish keeps the environment's database on Postgres (§G).
 *
 * `dbProvider` on the environment row is the record of what the pod is actually
 * mounted with, and the region switch must never contradict it. An environment
 * that has moved to Postgres and is then published while `PUBLISH_POSTGRES` says
 * `off` would otherwise build a SQLite image against a Postgres `DATABASE_URL`:
 * the boot guard exits, the revision never becomes ready, and every later
 * republish fails the same way. So a recorded Postgres environment stays on
 * Postgres; taking it back to SQLite is an explicit cutover (which clears
 * `dbProvider`), never a side effect of the flag.
 *
 * `sticky` is reported separately from `flag`/`config` so the publish log says
 * which rule decided.
 */
export function resolvePublishDbProvider(input: {
  serverBacked: boolean
  substrateKind: 'knative' | 'metal'
  /** `PublishedEnvironment.dbProvider` as stored. */
  environmentProvider?: string | null
  projectId?: string | null
}): { provider: 'sqlite' | 'postgres'; reason: 'sticky' | 'flag' | 'config' | 'off' | 'not-server-backed' | 'metal' } {
  if (!input.serverBacked) return { provider: 'sqlite', reason: 'not-server-backed' }
  if (input.substrateKind !== 'knative') return { provider: 'sqlite', reason: 'metal' }
  if (input.environmentProvider === 'postgres') return { provider: 'postgres', reason: 'sticky' }
  const flag = parsePublishFlag(process.env.PUBLISH_POSTGRES)
  const verdict = publishFlagAllows(flag, input.projectId)
  if (verdict === true) return { provider: 'postgres', reason: 'flag' }
  if (verdict === false) return { provider: 'sqlite', reason: 'off' }
  return configuredProjectsDatabase()
    ? { provider: 'postgres', reason: 'config' }
    : { provider: 'sqlite', reason: 'off' }
}

/**
 * The parts of the projects-database configuration that are missing, for the
 * publish log. Empty when the cluster is fully wired up.
 */
export function missingProjectsDatabaseConfig(): string[] {
  const missing: string[] = []
  if (!(process.env.PROJECTS_DB_ADMIN_URL || '').trim()) missing.push('PROJECTS_DB_ADMIN_URL')
  if (!(process.env.PROJECTS_DB_POOLER_HOST || '').trim()) missing.push('PROJECTS_DB_POOLER_HOST')
  return missing
}

function configuredProjectsDatabase(): boolean {
  return missingProjectsDatabaseConfig().length === 0
}
