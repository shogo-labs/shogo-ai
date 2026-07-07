// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure, env-only gating for the `metal` microVM substrate. Kept in its own
 * module (no OTel / prisma / buildProjectEnv imports) so resolveProjectPodUrl
 * can call it on every request without pulling the heavy controller — that is
 * only imported dynamically once a project is actually eligible.
 */

/**
 * Metal-only mode: when on, EVERY project is served by the metal microVM
 * substrate and Knative is not used at all — there is no per-project choice and
 * no silent fallback (a metal miss surfaces as a retryable 503 while the VM
 * resumes/boots). This is the "staging runs on metal instead of Knative" switch.
 * It implies `isMetalEnabled()` and makes every project eligible.
 */
export function isMetalAllProjects(): boolean {
  return process.env.SHOGO_METAL_ALL_PROJECTS === 'true'
}

/**
 * Sticky-drain cutover mode: EVERY project is metal-eligible, but a project that
 * already has a LIVE Knative pod keeps being served from Knative until that pod
 * turns off (idle scale-to-zero) — see resolveProjectPodUrl. New opens (and any
 * project whose Knative pod is gone) go to metal with NO Knative fallback, so
 * the old fleet drains without ever spinning back up. This is the production
 * cutover switch; metal-only mode (SHOGO_METAL_ALL_PROJECTS) is the harder
 * variant with no Knative yielding at all.
 *
 * Like metal-only it implies `isMetalEnabled()` and makes every project
 * eligible, and it is authoritative on a metal miss (no fall-through to Knative
 * for a project that has no live pod).
 */
export function isMetalDrainMode(): boolean {
  return process.env.SHOGO_METAL_DRAIN_MODE === 'true'
}

/**
 * Global kill-switch. Off → resolveProjectPodUrl never touches metal.
 * Metal-only mode (SHOGO_METAL_ALL_PROJECTS) and drain mode
 * (SHOGO_METAL_DRAIN_MODE) both imply enabled.
 */
export function isMetalEnabled(): boolean {
  return process.env.SHOGO_METAL_ENABLED === 'true' || isMetalAllProjects() || isMetalDrainMode()
}

/**
 * Authoritative modes never silently fall through to Knative on a metal miss:
 * metal-only always, and drain mode for a project with no live Knative pod (the
 * live-pod short-circuit happens before the metal resolve, so by the time a
 * drain-mode metal miss surfaces, Knative is not an option we want to recreate).
 */
export function isMetalAuthoritative(): boolean {
  return isMetalAllProjects() || isMetalDrainMode()
}

let allowlistCache: { raw: string; set: Set<string> } | null = null
function allowlist(): Set<string> {
  const raw = process.env.METAL_PROJECT_ALLOWLIST || ''
  if (!allowlistCache || allowlistCache.raw !== raw) {
    allowlistCache = { raw, set: new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) }
  }
  return allowlistCache.set
}

/** Stable 0–99 bucket for a project id (FNV-1a), for percentage rollout. */
export function rolloutBucket(projectId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < projectId.length; i++) {
    h ^= projectId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 100
}

/**
 * Per-project gate: allowlisted projects always route to metal; otherwise a
 * stable percentage rollout (METAL_ROLLOUT_PERCENT, default 0 = allowlist-only)
 * so metal can be graduated free/micro → all-us without a redeploy.
 */
export function isMetalEligibleProject(projectId: string): boolean {
  if (!projectId) return false
  // Metal-only and drain cutover modes: every project is eligible, no
  // allowlist/percentage (drain still yields to a live Knative pod at resolve).
  if (isMetalAllProjects() || isMetalDrainMode()) return true
  if (allowlist().has(projectId)) return true
  const pct = parseInt(process.env.METAL_ROLLOUT_PERCENT || '0', 10)
  if (pct <= 0) return false
  if (pct >= 100) return true
  return rolloutBucket(projectId) < pct
}
