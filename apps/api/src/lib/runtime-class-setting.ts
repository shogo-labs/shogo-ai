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

export function getDockerClassOverride(): boolean | null {
  return dockerClassOverride
}

export function setDockerClassOverride(value: boolean | null): void {
  dockerClassOverride = value
}

/** True if the Docker-capable project class may be assigned/created right now. */
export function isDockerClassEnabled(): boolean {
  if (dockerClassOverride !== null) return dockerClassOverride
  return process.env.DOCKER_CLASS_ENABLED === 'true'
}

/** Load the persisted override from `platform_settings` into memory. Call once at boot. */
export async function loadDockerClassOverride(): Promise<void> {
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.platformSetting.findUnique({ where: { key: DOCKER_CLASS_SETTING_KEY } })
    if (row) {
      dockerClassOverride = row.value === 'true'
      console.log(`[RuntimeClass] Loaded docker-class admin override: ${dockerClassOverride}`)
    }
  } catch (err: any) {
    console.log('[RuntimeClass] No docker-class override loaded (non-fatal):', err.message)
  }
}
