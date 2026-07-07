// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Sticky-drain cutover helper.
 *
 * During the production cutover to the metal microVM substrate we run in
 * "drain mode" (SHOGO_METAL_DRAIN_MODE): every project is metal-eligible, BUT a
 * project that still has a LIVE Knative pod keeps being served from Knative
 * until that pod turns off (idle scale-to-zero). New opens — and any project
 * whose Knative pod is already gone — route to metal with no Knative fallback,
 * so the old fleet drains without ever spinning back up and without ever
 * dual-running the same project across substrates.
 *
 * The liveness probe here is DELIBERATELY non-mutating: `getStatus()` is a plain
 * K8s GET on the Knative Service and does NOT wake a scaled-to-zero pod. We only
 * yield to a pod that is `exists && ready && replicas > 0`.
 *
 * Kept in its own tiny module (only a dynamic import of the heavy Knative
 * manager, and only when actually in drain mode) so both `resolveProjectPodUrl`
 * and the bespoke `/sandbox/url` metal branch can share one decision.
 */

import { isMetalDrainMode } from './metal-eligibility'

export interface KnativeLiveStatus {
  exists: boolean
  ready: boolean
  replicas: number
  url: string | null
}

export type KnativeStatusProbe = (projectId: string) => Promise<KnativeLiveStatus>

/**
 * Default non-mutating Knative liveness probe. Uses `getStatus()` (a K8s GET on
 * the Service) which resolves the DB-mapped/promoted service name and returns
 * `url` for the actual serving Service — so a promoted warm-pod project yields
 * to its real URL, not the `project-{id}` convention.
 */
export async function defaultKnativeStatus(projectId: string): Promise<KnativeLiveStatus> {
  const { getKnativeProjectManager } = await import('./knative-project-manager')
  const s = await getKnativeProjectManager().getStatus(projectId)
  return { exists: s.exists, ready: s.ready, replicas: s.replicas ?? 0, url: s.url ?? null }
}

/**
 * True when this project has a live Knative pod to yield to under drain mode.
 * Returns the pod URL to serve, or null to route the open to metal.
 *
 * Only meaningful in drain mode; returns null otherwise. Callers should gate on
 * `isKubernetes()` before relying on this. A probe FAILURE propagates — callers
 * MUST treat it as retryable and NOT route to metal or start a Knative pod on an
 * unknown state (either could dual-run the project across substrates).
 */
export async function drainLiveKnativeUrl(
  projectId: string,
  probe: KnativeStatusProbe = defaultKnativeStatus,
): Promise<string | null> {
  if (!isMetalDrainMode()) return null
  const s = await probe(projectId)
  return s.exists && s.ready && s.replicas > 0 && s.url ? s.url : null
}
