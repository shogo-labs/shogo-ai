// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Super-admin override for Docker `sandbox-exec` isolation
 * (`packages/agent-runtime/src/sandbox-exec.ts`).
 *
 * Mirrors the `agent-model.*` PlatformSetting pattern (see
 * `setAgentModeOverrides` in server.ts): a super admin sets a value via
 * `PUT /api/admin/settings/sandbox-exec`, it's persisted to the
 * `platform_settings` table under `runtime.sandbox_exec_enabled`, held
 * in memory here for zero-latency reads, and injected as the
 * `SANDBOX_EXEC_ENABLED` env var into every spawned agent-runtime
 * (host, Kubernetes warm-pool, and metal — see
 * `apps/api/src/lib/runtime/build-project-env.ts`,
 * `build-workspace-env.ts`, and `runtime/manager.ts`).
 *
 * `null` means "no admin override" — the runtime falls back to its own
 * heuristic (`KUBERNETES_SERVICE_HOST` detection) in
 * `packages/agent-runtime/src/sandbox-exec.ts`.
 */

export const SANDBOX_EXEC_SETTING_KEY = 'runtime.sandbox_exec_enabled'

let sandboxExecOverride: boolean | null = null

export function getSandboxExecOverride(): boolean | null {
  return sandboxExecOverride
}

export function setSandboxExecOverride(value: boolean | null): void {
  sandboxExecOverride = value
}

/** Load the persisted override from `platform_settings` into memory. Call once at boot. */
export async function loadSandboxExecOverride(): Promise<void> {
  try {
    const { prisma } = await import('./prisma')
    const row = await prisma.platformSetting.findUnique({ where: { key: SANDBOX_EXEC_SETTING_KEY } })
    if (row) {
      sandboxExecOverride = row.value === 'true'
      console.log(`[SandboxExec] Loaded admin override: ${sandboxExecOverride}`)
    }
  } catch (err: any) {
    console.log('[SandboxExec] No admin override loaded (non-fatal):', err.message)
  }
}
