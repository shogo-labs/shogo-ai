// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure, env-only configuration for the publishing substrate seam. Kept
 * dependency-free (no k8s / metal / prisma imports) so both substrates and the
 * publish route can read it cheaply without pulling a heavy controller.
 */

import { isMetalEnabled } from './metal-eligibility'

/**
 * Whether NEW publishes are OWNED by the metal substrate authoritatively — i.e.
 * metal is THE publishing runtime for EVERY project the moment the metal fleet
 * is enabled, decoupled from the gradual per-project PREVIEW rollout
 * (METAL_ROLLOUT_PERCENT / METAL_PROJECT_ALLOWLIST). Preview/dev routing still
 * follows the graduated eligibility gate; publishing does not, because the
 * publish path is a distinct, always-on-metal target once the fleet exists.
 *
 * Precedence:
 *   PUBLISH_SUBSTRATE=metal    → force metal (even if the global metal flag is
 *                                off — a metal-only publish env / test).
 *   PUBLISH_SUBSTRATE=knative  → force Knative (the rollback escape hatch;
 *                                pair with a KV re-flip to restore old routing).
 *   unset (default)            → metal whenever the fleet is enabled
 *                                (isMetalEnabled), else Knative.
 *
 * Note this only decides where NEW/re-published sites are provisioned and which
 * substrate the wake/always-on ops target for the CURRENT publish. Already-live
 * sites keep serving from wherever their SERVER_BACKED edge flag points until a
 * (re)publish or the migration script (scripts/migrate-publishing-to-metal.ts)
 * flips them — so a rollback is a config flip, never a data move.
 */
export function isPublishMetalAuthoritative(): boolean {
  const override = (process.env.PUBLISH_SUBSTRATE || '').trim().toLowerCase()
  if (override === 'metal') return true
  if (override === 'knative') return false
  return isMetalEnabled()
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
