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
