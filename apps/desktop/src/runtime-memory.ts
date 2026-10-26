// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Default per-project RAM ceiling in MB, scaled to the host machine's total
 * memory instead of a flat number.
 *
 * The prior flat 2048MB default was sized like a constrained shared cloud
 * pod, not a developer's own machine. A single project's runtime (bun +
 * vite/esbuild watchers + tsserver + pyright + Composio, etc.) routinely
 * sits above 2GB RSS during normal use, and the RSS watchdog restarts the
 * runtime the moment it's breached. With a ceiling that tight, a genuinely
 * larger workload re-breaches within seconds of every respawn, producing an
 * infinite kill-and-restart loop — which surfaces to the user as a
 * persistent "Connection interrupted / Reconnecting" banner that looks
 * exactly like a real network outage even though the network is fine the
 * whole time (confirmed via a real user's `main.log`: the local
 * agent-runtime was restarting every ~15-30s forever, each time hitting the
 * flat 2048MB ceiling before it even finished starting the language
 * servers).
 *
 * Scales to 40% of total system RAM, floored at 3072MB (comfortably above
 * the old flat default) and capped at 8192MB (so one project can't starve
 * the rest of the machine, or other concurrently-open projects, on very
 * high-RAM boxes).
 *
 * Deliberately dependency-free (no `electron`, no `os`) so it's trivially
 * unit-testable and can be called from both the main process (config.ts)
 * and local-server.ts's config-read fallback without pulling in Electron.
 */
export function computeDefaultRuntimeMemoryMB(totalMemMB: number): number {
  if (!Number.isFinite(totalMemMB) || totalMemMB <= 0) return 3072
  return Math.min(8192, Math.max(3072, Math.floor(totalMemMB * 0.4)))
}

/**
 * Budget for the commands the agent runs (`exec`), which is a different thing
 * from the runtime's own leak ceiling above.
 *
 * The runtime ceiling exists to restart a leaked vite/tsserver. A command is
 * the user's workload — a model, a build, a test suite — and borrowing the
 * 8192-capped ceiling for it killed a 40B INT4 model (22.5 GB resident) on a
 * 128 GB Mac (SHO-203). So the command budget is sized from the machine, not
 * from the runtime: half of RAM, or everything above the 8 GB the rest of the
 * app may need, whichever is larger.
 *
 * `max(50% of RAM, RAM - 8192)` gives 128 GB → 120 GB, 64 GB → 56 GB,
 * 32 GB → 24 GB, 16 GB → 8 GB. The 50% floor is deliberate: sized as
 * `RAM - 8192` alone, a 16 GB laptop would leave every command 8 GB while
 * half the machine sits idle.
 *
 * Deliberately dependency-free, like the rest of this module.
 */
export function computeDefaultExecMemoryMB(totalMemMB: number): number {
  if (!Number.isFinite(totalMemMB) || totalMemMB <= 0) return 8192
  const total = Math.floor(totalMemMB)
  return Math.max(Math.floor(total * 0.5), total - 8192)
}

/** A settings value for the command budget: explicit MB, or scaled to the host. */
export type ExecMemorySetting = number | 'auto'

/** Explicit budgets below this are a footgun, not a preference. */
export const EXEC_MEMORY_MIN_MB = 1024

/**
 * The MB the guard enforces for `'auto'` / an explicit number. An explicit
 * value is clamped to `[1024, totalMemMB]` — above the machine's RAM the limit
 * could never trip before the OS killed the command with no message, which is
 * the bug this replaces.
 */
export function resolveExecMemoryMB(
  setting: ExecMemorySetting | undefined,
  totalMemMB: number,
): number {
  if (setting === undefined || setting === 'auto') return computeDefaultExecMemoryMB(totalMemMB)
  if (!Number.isFinite(setting) || setting <= 0) return computeDefaultExecMemoryMB(totalMemMB)
  const total = Number.isFinite(totalMemMB) && totalMemMB > 0 ? Math.floor(totalMemMB) : 0
  const ceiling = total > 0 ? total : Math.max(setting, EXEC_MEMORY_MIN_MB)
  return Math.min(Math.max(Math.round(setting), EXEC_MEMORY_MIN_MB), ceiling)
}

/** Read a stored/handed-in setting, falling back to `'auto'` for anything else. */
export function normalizeExecMemoryMB(value: unknown): ExecMemorySetting {
  if (value === 'auto') return 'auto'
  const n = typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 'auto'
}

export type HostTier = 'low' | 'standard' | 'high'

/** Classify the host once so every local process applies the same budget. */
export function computeHostTier(totalMemMB: number, cpuCount = 8): HostTier {
  if (!Number.isFinite(totalMemMB) || totalMemMB <= 0) return 'low'
  if (totalMemMB <= 8192 || cpuCount <= 4) return 'low'
  if (totalMemMB >= 32768 && cpuCount >= 8) return 'high'
  return 'standard'
}

export function resolveHostTier(
  env: Record<string, string | undefined>,
  totalMemMB: number,
  cpuCount = 8,
): HostTier {
  const explicit = env.SHOGO_HOST_TIER
  if (explicit === 'low' || explicit === 'standard' || explicit === 'high') return explicit
  return computeHostTier(totalMemMB, cpuCount)
}
