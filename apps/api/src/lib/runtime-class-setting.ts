// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform gate for the Docker-capable ("Tier 2") project class.
 *
 * Mirrors the `sandbox-exec-setting.ts` pattern: a super admin flips
 * `PUT /api/admin/settings/docker-class`, it's persisted to the
 * `platform_settings` table under `runtime.docker_class_enabled`, held in
 * memory here for zero-latency reads, and consulted by:
 *   - the project-creation / stack-switch path, before it will accept a
 *     stack whose `TechStackMeta.runtime.vmClass === 'docker'`;
 *   - `build-project-env.ts`, before it emits `SHOGO_RUNTIME_CLASS=docker`.
 *
 * Off by default: the metal fleet has no docker-class VM pool until Phase 1
 * (metal-agent class plumbing) and Phase 0 (dockerd-in-guest validation on
 * real hardware) both land and are verified on a staging host. Flipping this
 * on before then would accept `docker-compose` projects onto standard VMs
 * with no dockerd, no `vmClass`-aware placement, and no extra disk headroom.
 *
 * `DOCKER_CLASS_ENABLED` env var is a deploy-time fallback for environments
 * without a `platform_settings` table (e.g. a fresh local DB) — the DB
 * override, once set, always wins.
 */

export const DOCKER_CLASS_SETTING_KEY = 'runtime.docker_class_enabled'

let dockerClassOverride: boolean | null = null
// Bumped on every direct write so an in-flight DB refresh that started before
// the write can't overwrite it with the pre-write value.
let overrideGeneration = 0

export function getDockerClassOverride(): boolean | null {
  return dockerClassOverride
}

export function setDockerClassOverride(value: boolean | null): void {
  dockerClassOverride = value
  overrideGeneration++
}

/** True if the Docker-capable project class may be assigned/created right now. */
export function isDockerClassEnabled(): boolean {
  if (dockerClassOverride !== null) return dockerClassOverride
  return process.env.DOCKER_CLASS_ENABLED === 'true'
}

/**
 * Stacks that need a docker-class VM. Kept as an id list (not a registry
 * import) so callers whose tests mock `@shogo/shared-runtime` still load.
 * `docker-compose` is the only such stack.
 */
const DOCKER_STACK_IDS = new Set(['docker-compose'])

/**
 * Message to show when someone tries to create or switch to a Docker stack
 * while the platform gate is off. Null when the stack is fine to use.
 */
export function dockerClassBlockedMessage(techStackId: string | null | undefined): string | null {
  if (!techStackId || !DOCKER_STACK_IDS.has(techStackId)) return null
  if (isDockerClassEnabled()) return null
  return 'Docker projects are not available on this server yet.'
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000
let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Sync the in-memory override with `platform_settings`. Safe to call repeatedly.
 *
 * A missing row resets the override to null, so clearing the setting (`PUT`
 * with `enabled: null`) takes effect everywhere and falls back to the env var.
 * On a read error the last known value is kept rather than flipping the gate.
 */
export async function loadDockerClassOverride(): Promise<void> {
  const startedAt = overrideGeneration
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.platformSetting.findUnique({ where: { key: DOCKER_CLASS_SETTING_KEY } })
    if (overrideGeneration !== startedAt) return
    const next = row ? row.value === 'true' : null
    if (next !== dockerClassOverride) {
      dockerClassOverride = next
      console.log(`[RuntimeClass] docker-class admin override is now: ${next}`)
    }
  } catch (err: any) {
    console.log('[RuntimeClass] docker-class override refresh failed (keeping last value):', err.message)
  }
}

/**
 * Re-sync from the DB on an interval so every API instance converges on the
 * value written by `PUT /api/admin/settings/docker-class`, not only the
 * instance that handled the write. Idempotent.
 */
export function startDockerClassOverrideRefresh(intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => loadDockerClassOverride(), intervalMs)
  refreshTimer.unref?.()
}

export function stopDockerClassOverrideRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}
