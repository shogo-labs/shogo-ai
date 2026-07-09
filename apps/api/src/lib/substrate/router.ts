// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Substrate router — picks the ProjectSubstrate that OWNS a project's runtime,
 * mirroring the metal-eligibility gate used by resolveProjectPodUrl. This is the
 * generalization of that resolver's cascade to the whole lifecycle interface, so
 * callers do `(await getProjectSubstrate(id)).stop(id)` instead of branching on
 * isKubernetes()/metal themselves.
 *
 * Backends are imported lazily (dynamic import) exactly like resolve-pod-url so
 * the k8s/metal dependencies aren't pulled until first use — preserving the
 * cold-start cost shape. Test-only `_`-prefixed overrides inject the probes and
 * substrate instances (same convention as ResolvePodUrlOpts).
 */

import type { ProjectSubstrate, Resources } from './types'
import { SubstrateUnsupportedError } from './types'
import {
  isMetalEnabled as metalEnabled,
  isMetalEligibleProject as metalEligible,
} from '../metal-eligibility'
import { isPublishMetalAuthoritative as publishMetalAuthoritative } from '../publish-substrate-config'

export interface SubstrateRouterOpts {
  _isKubernetes?: () => boolean
  _isMetalEnabled?: () => boolean
  _isMetalEligible?: (projectId: string) => boolean
  /** Publish-substrate authority probe (getPublishSubstrate). */
  _isPublishMetalAuthoritative?: () => boolean
  _metalSubstrate?: ProjectSubstrate
  _knativeSubstrate?: ProjectSubstrate
}

function defaultIsKubernetes(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST
}

async function makeMetalSubstrate(): Promise<ProjectSubstrate> {
  const { MetalSubstrate } = await import('./metal-substrate')
  return new MetalSubstrate()
}

async function makeKnativeSubstrate(): Promise<ProjectSubstrate> {
  const { KnativeSubstrate } = await import('./knative-substrate')
  const { getKnativeProjectManager, resolveKnativePodUrl } = await import('../knative-project-manager')
  return new KnativeSubstrate(getKnativeProjectManager() as any, resolveKnativePodUrl)
}

/**
 * The substrate that owns `projectId` today. Metal when the project is metal-
 * eligible (rollout allowlist / percentage / metal-only / drain), else Knative.
 * Note: this is intentionally the "primary owner" decision — the drain-mode
 * "still has a live Knative pod" refinement lives in resolveProjectPodUrl for
 * the hot URL path; lifecycle ops (stop/destroy) target the owning substrate,
 * and `destroyProjectRuntime` covers both to be leak-proof during a cutover.
 */
export async function getProjectSubstrate(projectId: string, opts: SubstrateRouterOpts = {}): Promise<ProjectSubstrate> {
  const isMetalEnabled = opts._isMetalEnabled ?? (() => metalEnabled())
  const isMetalEligible = opts._isMetalEligible ?? ((id: string) => metalEligible(id))
  if (isMetalEnabled() && isMetalEligible(projectId)) {
    return opts._metalSubstrate ?? (await makeMetalSubstrate())
  }
  return opts._knativeSubstrate ?? (await makeKnativeSubstrate())
}

/**
 * The substrate that OWNS a project's PUBLISHED site for a NEW (re)publish.
 *
 * Distinct from getProjectSubstrate (preview/dev routing): publishing is metal-
 * authoritative fleet-wide once the metal fleet is enabled — it does NOT follow
 * the graduated per-project preview rollout (METAL_ROLLOUT_PERCENT / allowlist),
 * because the published path is a single always-on-metal target. See
 * isPublishMetalAuthoritative for the precedence (incl. the PUBLISH_SUBSTRATE
 * rollback/force override).
 *
 * This picks where a publish/republish PROVISIONS the site and which substrate
 * the wake/always-on ops target. Teardown of the OTHER substrate on a cutover is
 * handled by unpublishProjectEverywhere so nothing leaks.
 */
export async function getPublishSubstrate(projectId: string, opts: SubstrateRouterOpts = {}): Promise<ProjectSubstrate> {
  const authoritative = opts._isPublishMetalAuthoritative ?? (() => publishMetalAuthoritative())
  if (authoritative()) {
    return opts._metalSubstrate ?? (await makeMetalSubstrate())
  }
  return opts._knativeSubstrate ?? (await makeKnativeSubstrate())
}

/**
 * Tear down a project's runtime on EVERY substrate, best-effort. Used on project
 * DELETE: during a drain/cutover a project can have BOTH a Knative ksvc and a
 * metal snapshot, so destroying only the "owner" would leak the other (ksvc +
 * DomainMapping, or NVMe/S3 snapshot bytes). A no-op off Kubernetes (desktop/VM
 * teardown is handled by the runtime manager + VM pool in the delete hook).
 */
export async function destroyProjectRuntime(projectId: string, opts: SubstrateRouterOpts = {}): Promise<void> {
  const isK8s = opts._isKubernetes ?? defaultIsKubernetes
  if (!isK8s()) return

  const isMetalEnabled = opts._isMetalEnabled ?? (() => metalEnabled())
  const jobs: Promise<void>[] = []

  // Only touch metal when it's enabled (or an instance is injected for a test) —
  // avoids importing/booting the metal controller in pure-Knative deployments.
  if (opts._metalSubstrate || isMetalEnabled()) {
    const metal = opts._metalSubstrate ?? (await makeMetalSubstrate())
    jobs.push(
      metal.destroy(projectId).catch((e) => {
        console.warn(`[substrate] metal destroy ${projectId} failed: ${(e as any)?.message ?? e}`)
      }),
    )
  }

  const knative = opts._knativeSubstrate ?? (await makeKnativeSubstrate())
  jobs.push(
    knative.destroy(projectId).catch((e) => {
      console.warn(`[substrate] knative destroy ${projectId} failed: ${(e as any)?.message ?? e}`)
    }),
  )

  await Promise.all(jobs)
}

/**
 * Resize a project on its owning substrate. Surfaces SubstrateUnsupportedError
 * when the substrate can't do per-project sizing (metal today), so callers can
 * return a clean 501/409 instead of silently no-op'ing.
 */
export async function resizeProjectRuntime(projectId: string, resources: Resources, opts: SubstrateRouterOpts = {}): Promise<void> {
  const substrate = await getProjectSubstrate(projectId, opts)
  if (!substrate.resize) throw new SubstrateUnsupportedError('resize', substrate.kind)
  await substrate.resize(projectId, resources)
}

/**
 * Tear down a project's PUBLISHED site on EVERY substrate, best-effort. Like
 * destroyProjectRuntime, this is leak-proof during a drain/cutover: a project
 * that changed substrates could have BOTH a Knative published ksvc + DomainMapping
 * AND a metal published microVM + placement, so unpublishing only the "owner"
 * would leak the other. A no-op off Kubernetes.
 */
export async function unpublishProjectEverywhere(
  projectId: string,
  subdomain: string,
  opts: SubstrateRouterOpts = {},
): Promise<void> {
  const isK8s = opts._isKubernetes ?? defaultIsKubernetes
  if (!isK8s()) return

  const isMetalEnabled = opts._isMetalEnabled ?? (() => metalEnabled())
  const jobs: Promise<void>[] = []

  if (opts._metalSubstrate || isMetalEnabled()) {
    const metal = opts._metalSubstrate ?? (await makeMetalSubstrate())
    jobs.push(
      metal.unpublish(projectId, subdomain).catch((e) => {
        console.warn(`[substrate] metal unpublish ${projectId} failed: ${(e as any)?.message ?? e}`)
      }),
    )
  }

  const knative = opts._knativeSubstrate ?? (await makeKnativeSubstrate())
  jobs.push(
    knative.unpublish(projectId, subdomain).catch((e) => {
      console.warn(`[substrate] knative unpublish ${projectId} failed: ${(e as any)?.message ?? e}`)
    }),
  )

  await Promise.all(jobs)
}
