// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Process-wide registry of live VM (QEMU) PIDs.
 *
 * The VM warm pool spawns QEMU processes that forward the guest's
 * agent port to a free host port. Historically that host port came
 * from `findFreePort(37100)` — exactly inside RuntimeManager's
 * "stale process" cleanup range. When RuntimeManager later
 * initialised (~1s after the pool started its first QEMU), its
 * `lsof | kill -9` pass treated the brand-new VM as a leftover from a
 * previous session and killed it. Observed in main.log:
 *
 *   [VMWarmPool] Reconcile: need 1 more VMs (available: 0, target: 1)
 *   [RuntimeManager] Cleaning up 1 stale process(es) on ports 37100-37900: 75951
 *   [shogo-vm] QEMU exited with code null
 *
 * → result: warm pool never has a VM ready when the first project
 * request arrives, the project request lands on host RuntimeManager
 * instead, and the user sits forever on "Connecting to agent
 * runtime..." because other frontend polling routes wait on the
 * (never-assigning) VM pool — classic split-brain.
 *
 * The registry breaks the race without moving any ports around
 * (which would otherwise require touching the build-x86_64 image
 * scripts and re-baking the qcow2). VM managers add their QEMU PID
 * here the moment `child_process.spawn` returns, and RuntimeManager's
 * cleanup queries the registry to skip any PID it owns.
 *
 * Lives in `apps/desktop/src/vm` (rather than `packages/shared-
 * runtime`) because `apps/desktop` is intentionally NOT part of the
 * pnpm/bun workspace (it ships as a standalone Electron app with its
 * own node_modules), so it cannot resolve `@shogo/shared-runtime`.
 * At runtime the api server dynamically imports `apps/desktop/src/vm`
 * (see `apps/api/src/server.ts:6571`), which lets both halves —
 * VMManagers spawning QEMU and RuntimeManager scanning ports — share
 * the same module instance and therefore the same `Set<number>`.
 *
 * The set is module-local and lives for the lifetime of the API
 * process. We do not persist across restarts — a previous-session VM
 * really is stale (its host port forwarder is dead) and should be
 * cleaned up the old way.
 */

const vmPids = new Set<number>()

/**
 * Mark `pid` as owned by an active VM. Idempotent and safe to call
 * with undefined/null/0 (silently no-ops, simplifies callers that
 * receive a freshly-spawned ChildProcess whose `.pid` may be unset on
 * spawn failure).
 *
 * Call from VM managers IMMEDIATELY after `spawn(qemu, …)` so the
 * registration happens before QEMU's first `bind(2)` on the hostfwd
 * port. The exec → child-side bind window is wide enough (kernel
 * scheduling + QEMU init) that any concurrent `lsof` pass would still
 * race correctly, but registering earlier is strictly safer.
 */
export function registerVMPid(pid: number | undefined | null): void {
  if (typeof pid !== 'number' || pid <= 0) return
  vmPids.add(pid)
}

/**
 * Remove `pid` from the registry. Call from the QEMU `exit` handler
 * and from any explicit stop/cleanup path. Idempotent.
 */
export function unregisterVMPid(pid: number | undefined | null): void {
  if (typeof pid !== 'number' || pid <= 0) return
  vmPids.delete(pid)
}

/**
 * Snapshot of currently registered VM PIDs. Returned as the live
 * `Set` (read-only typed) so callers can `.has(pid)` in tight loops
 * without re-allocating. Do NOT mutate.
 *
 * Test-only resets should use `_resetVMPidRegistry`.
 */
export function getRegisteredVMPids(): ReadonlySet<number> {
  return vmPids
}

/** Test-only: clear the registry between cases. */
export function _resetVMPidRegistry(): void {
  vmPids.clear()
}
