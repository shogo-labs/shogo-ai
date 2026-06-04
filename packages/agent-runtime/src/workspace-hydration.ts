// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project cloud hydration for WORKSPACE runtimes.
 *
 * A single-project pod hydrates its one project into `WORKSPACE_DIR` via
 * `initializeS3Sync(WORKSPACE_DIR)` (S3 prefix = PROJECT_ID). A workspace
 * runtime pod, by contrast, serves several attached projects laid out as real
 * subfolders `<WORKSPACE_DIR>/<projectId>/` (the cloud analogue of the host's
 * symlink merged-root). Each member is stored under its OWN S3 prefix
 * (`<projectId>/…`), so we must pull each member's archive into its own
 * subfolder rather than doing a single workspace-rooted download.
 *
 * Extracted from `server.ts` as a pure, dependency-injected function so it can
 * be unit-tested without booting the side-effectful runtime server.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createS3SyncForProject } from '@shogo/shared-runtime'

/** Minimal shape we need from an S3Sync instance (kept loose for testing). */
export interface MemberSync {
  downloadAll(): Promise<unknown>
}

export interface HydrateWorkspaceMembersDeps {
  /** Factory for a per-project sync. Defaults to `createS3SyncForProject`. */
  createSync?: (localDir: string, projectId: string) => MemberSync | null
  /** Directory creator. Defaults to `mkdirSync(dir, { recursive: true })`. */
  ensureDir?: (dir: string) => void
  log?: (msg: string) => void
}

export interface HydrateWorkspaceMembersResult {
  hydrated: string[]
  skipped: string[]
  failed: string[]
  /**
   * The sync instances that downloaded successfully, keyed by project id. The
   * caller starts the periodic uploader / watcher on these and flushes them on
   * shutdown (the hydration step itself is download-only so it stays a pure,
   * easily-tested unit).
   */
  syncs: Map<string, MemberSync>
}

/**
 * Download each workspace member project's archive into
 * `<workspaceDir>/<projectId>/`. Best-effort and resilient: a failure for one
 * member (or an unconfigured S3) never aborts the others, so the pod still
 * comes up with whatever members hydrated successfully. Returns per-member
 * outcomes so callers (and tests) can assert what happened.
 */
export async function hydrateWorkspaceMembers(
  workspaceDir: string,
  projectIds: string[],
  deps: HydrateWorkspaceMembersDeps = {},
): Promise<HydrateWorkspaceMembersResult> {
  const createSync = deps.createSync ?? createS3SyncForProject
  const ensureDir = deps.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }))
  const log = deps.log ?? ((msg: string) => console.log(msg))

  const result: HydrateWorkspaceMembersResult = {
    hydrated: [],
    skipped: [],
    failed: [],
    syncs: new Map(),
  }
  // Dedupe so a project listed twice isn't downloaded twice into the same dir.
  const unique = projectIds.filter((id, i, arr) => id && arr.indexOf(id) === i)

  for (const projectId of unique) {
    const localDir = join(workspaceDir, projectId)
    try {
      ensureDir(localDir)
      const sync = createSync(localDir, projectId)
      if (!sync) {
        log(`[agent-runtime] hydrateWorkspaceMembers: S3 not configured for ${projectId} — skipping`)
        result.skipped.push(projectId)
        continue
      }
      await sync.downloadAll()
      log(`[agent-runtime] hydrateWorkspaceMembers: hydrated ${projectId} -> ${localDir}`)
      result.hydrated.push(projectId)
      result.syncs.set(projectId, sync)
    } catch (err: any) {
      log(`[agent-runtime] hydrateWorkspaceMembers: ${projectId} failed: ${err?.message ?? err}`)
      result.failed.push(projectId)
    }
  }
  return result
}
