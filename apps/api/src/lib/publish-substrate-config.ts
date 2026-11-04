// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure, env-only configuration for the publishing substrate seam. Kept
 * dependency-free (no k8s / metal / prisma imports) so both substrates and the
 * publish route can read it cheaply without pulling a heavy controller.
 */

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
 * Whether a publish should move the app's data onto Postgres (SHO-308 §1).
 *
 * The publish pipeline provisions the environment's database, pushes the app's
 * schema at it and seeds it from `prisma/dev.db` — which can only work where the
 * `projects-pg` infrastructure exists. Two conditions, both real configuration
 * rather than a switch that hides a broken path:
 *
 *   1. the site is being published to **Knative**. A metal site keeps its SQLite
 *      data archive; that is the substrate's contract, and the escape hatch has
 *      to stay usable.
 *   2. the cluster is reachable *and* its databases have a pooled address —
 *      `PROJECTS_DB_ADMIN_URL` and `PROJECTS_DB_POOLER_HOST`. These are exactly
 *      the two things `ensureEnvironmentDatabase` refuses on (it answers
 *      `database_unavailable` for a missing pooler or a missing admin URL), so
 *      the gate and the refusal can never disagree: a region that would 503 is a
 *      region that this gate keeps on SQLite, publishing exactly as it does
 *      today. Checking only one of them would let the other turn every
 *      server-app publish into a 503.
 *
 * `PUBLISH_POSTGRES=on|off` forces the decision for a single rollout step —
 * `on` is how a misconfigured cluster surfaces as `database_unavailable` instead
 * of silently staying on SQLite, and `off` is how a publish is taken back off
 * Postgres without unsetting the URLs.
 */
export function shouldProvisionPublishedDatabase(substrateKind: 'knative' | 'metal'): boolean {
  if (substrateKind !== 'knative') return false
  const override = (process.env.PUBLISH_POSTGRES || '').trim().toLowerCase()
  if (override === 'off') return false
  if (override === 'on') return true
  return !!configuredProjectsDatabase()
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
