// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-runtime boot mode helpers.
 *
 * A WORKSPACE runtime serves a merged tree of several attached projects:
 * `WORKSPACE_DIR` points at the parent `workspaces/` directory and each
 * attached project is a top-level subfolder. This differs from the
 * single-project `managed` boot in two ways the boot path must respect:
 *
 *   1. Template / tech-stack seeding must be skipped — the parent dir
 *      already contains real project subfolders; dumping a Vite + React
 *      scaffold (or running the legacy APP-layout migration) at the
 *      parent root would corrupt them. This mirrors the `external`
 *      (VS Code folder) guard.
 *   2. The `basename(WORKSPACE_DIR) === PROJECT_ID` sanity check does
 *      not apply — a workspace runtime has a `WORKSPACE_ID`, not a single
 *      `PROJECT_ID`, and `WORKSPACE_DIR` ends in the workspaces parent
 *      name, not a project id.
 *
 * Path allowance needs no special handling: every attached project is a
 * descendant of `WORKSPACE_DIR`, and `getAllowedRoots()` already admits
 * descendants of the workspace dir.
 *
 * These are pure functions so the boot decisions can be unit-tested
 * without importing the side-effectful `server.ts` boot path.
 */

export type WorkingMode = 'managed' | 'external'

/** True when the runtime was booted as a multi-project workspace runtime. */
export function isWorkspaceRuntimeMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKSPACE_RUNTIME === 'true'
}

/** The workspace id this runtime serves, if any (workspace mode only). */
export function workspaceRuntimeId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isWorkspaceRuntimeMode(env)) return null
  return env.WORKSPACE_ID || null
}

/**
 * Attached project ids for a workspace runtime, parsed from the
 * comma-separated `WORKSPACE_PROJECT_IDS` env (set by build-workspace-env.ts).
 * Returns [] for non-workspace runtimes or when unset.
 */
export function workspaceAttachedProjectIds(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isWorkspaceRuntimeMode(env)) return []
  const raw = env.WORKSPACE_PROJECT_IDS
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Whether the boot should skip managed template/tech-stack seeding and
 * the legacy APP-layout migration. True for external folder projects AND
 * workspace runtimes.
 */
export function shouldSkipManagedSeeding(opts: {
  workingMode: WorkingMode
  isWorkspaceRuntime: boolean
}): boolean {
  return opts.workingMode === 'external' || opts.isWorkspaceRuntime
}

/**
 * Whether the `basename(WORKSPACE_DIR) === PROJECT_ID` sanity check
 * should run. Skipped for external projects (by design) and for
 * workspace runtimes (no single project id).
 */
export function shouldEnforceProjectIdSanity(opts: {
  workingMode: WorkingMode
  isWorkspaceRuntime: boolean
}): boolean {
  return opts.workingMode !== 'external' && !opts.isWorkspaceRuntime
}
