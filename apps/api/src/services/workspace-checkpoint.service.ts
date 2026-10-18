// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project auto-checkpoint for workspace (merged-tree) chat turns.
 *
 * In a workspace runtime several projects are mounted as subfolders under
 * one runtime, so a single chat turn can edit files across multiple
 * projects. Each project already has its own git repo at
 * `workspaces/<projectId>` (the checkpoint model is project-scoped — see
 * `checkpoint.service.ts`), so the right behaviour is: after a turn, snapshot
 * each attached project that actually changed, independently.
 *
 * Unlike `project-chat.ts` (which inspects the streamed tool calls to decide
 * whether to checkpoint a single project), we use **git dirtiness per
 * project** as the signal. That's robust without parsing the SSE stream and
 * naturally scopes each checkpoint to exactly the project whose tree the
 * agent touched. Gitignored build output (`dist/`, `node_modules/`) doesn't
 * count as a change, so untouched projects stay clean and uncheckpointed.
 *
 * The first turn that runs initialises a repo for any not-yet-tracked project
 * and records a baseline checkpoint of its current tree; subsequent turns
 * only checkpoint projects with real source changes.
 *
 * External (VS Code-style) projects are never auto-committed — that's the
 * user's own repo. We skip them before even initialising a repo so we never
 * drop a `.git` into a folder we don't own. The same goes for a **managed**
 * project whose folder turns out to be a checkout of someone else's repo (a
 * hand-made clone): the folder has an `origin` but no `GitHubConnection`, so we
 * report `skipped-foreign-repo` and leave its git state byte-identical.
 *
 * All work is best-effort and per-project isolated: one project's failure
 * never blocks another's checkpoint, and the whole thing is fire-and-forget
 * from the chat proxy's perspective.
 */

import { existsSync } from 'fs'
import { join } from 'path'

import { prisma } from '../lib/prisma'
import * as gitService from './git.service'
import * as checkpointService from './checkpoint.service'

export type AutoCheckpointStatus =
  | 'checkpointed'
  | 'baselined'
  | 'clean'
  | 'skipped-missing'
  | 'skipped-external'
  | 'skipped-foreign-repo'
  | 'skipped-no-git'
  | 'error'

/** The project columns that decide whether Shogo may commit into its folder. */
export interface AutoCheckpointProjectMeta {
  workingMode: string | null
  /** A `GitHubConnection` row means the repo was handed to Shogo. */
  hasGithubConnection: boolean
}

export interface AutoCheckpointResult {
  projectId: string
  status: AutoCheckpointStatus
  checkpointId?: string
  error?: string
}

export interface AutoCheckpointWorkspaceOptions {
  /** Absolute path to the `workspaces/` parent; project i lives at `<dir>/<id>`. */
  workspacesDir: string
  /** Commit message for change checkpoints (existing repo, dirty tree). */
  message?: string
  /**
   * Commit message used when a never-tracked project gets its first repo +
   * baseline checkpoint. Kept distinct so the panel doesn't misattribute an
   * untouched project's baseline to an AI edit.
   */
  baselineMessage?: string

  // ── Injection seams (tests) ───────────────────────────────────────────
  _existsSync?: (p: string) => boolean
  _isGitAvailable?: () => boolean
  _isGitRepo?: (p: string) => boolean
  _initRepo?: (p: string) => Promise<unknown>
  _getStatus?: (p: string) => Promise<{ hasChanges: boolean }>
  _getOriginRemoteUrl?: (p: string) => Promise<string | null>
  _createCheckpoint?: (opts: {
    projectId: string
    workspacePath: string
    message: string
    isAutomatic: boolean
  }) => Promise<{ id: string }>
  _loadProjectMeta?: (ids: string[]) => Promise<Map<string, AutoCheckpointProjectMeta>>
}

async function defaultLoadProjectMeta(
  ids: string[],
): Promise<Map<string, AutoCheckpointProjectMeta>> {
  const rows = (await prisma.project.findMany({
    where: { id: { in: ids } },
    select: { id: true, workingMode: true, githubConnection: { select: { id: true } } },
  })) as unknown as Array<{
    id: string
    workingMode: string | null
    githubConnection: { id: string } | null
  }>
  return new Map(
    rows.map((r) => [
      r.id,
      { workingMode: r.workingMode, hasGithubConnection: !!r.githubConnection },
    ]),
  )
}

/**
 * Snapshot every attached project that changed during a workspace chat turn.
 * Returns a per-project result array (never throws — failures are captured
 * as `status: 'error'`).
 */
export async function autoCheckpointWorkspaceProjects(
  projectIds: string[],
  opts: AutoCheckpointWorkspaceOptions,
): Promise<AutoCheckpointResult[]> {
  const existsSyncFn = opts._existsSync ?? existsSync
  const isGitAvailable = opts._isGitAvailable ?? gitService.isGitAvailable
  const isGitRepo = opts._isGitRepo ?? gitService.isGitRepo
  const initRepo = opts._initRepo ?? ((p: string) => gitService.initRepo(p))
  const getStatus = opts._getStatus ?? ((p: string) => gitService.getStatus(p))
  const getOriginRemoteUrl =
    opts._getOriginRemoteUrl ?? ((p: string) => gitService.getOriginRemoteUrl(p))
  const createCheckpoint = opts._createCheckpoint ?? checkpointService.createCheckpoint
  const loadProjectMeta = opts._loadProjectMeta ?? defaultLoadProjectMeta

  const ids = [...new Set(projectIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return []

  if (!isGitAvailable()) {
    return ids.map((projectId) => ({ projectId, status: 'skipped-no-git' as const }))
  }

  const projectMeta = await loadProjectMeta(ids).catch(
    () => new Map<string, AutoCheckpointProjectMeta>(),
  )
  const changeMessage = opts.message ?? 'AI: workspace edit'
  const baselineMessage = opts.baselineMessage ?? 'Workspace baseline'
  const results: AutoCheckpointResult[] = []

  for (const projectId of ids) {
    try {
      const meta = projectMeta.get(projectId)

      // External projects are the user's own repo — never auto-commit, and
      // never drop a `.git` into a folder we don't own.
      if (meta?.workingMode === 'external') {
        results.push({ projectId, status: 'skipped-external' })
        continue
      }

      const workspacePath = join(opts.workspacesDir, projectId)
      if (!existsSyncFn(workspacePath)) {
        results.push({ projectId, status: 'skipped-missing' })
        continue
      }

      // A folder that is a checkout of someone else's repo (a manual clone, or
      // any repo whose `origin` a human configured) is never committed into —
      // not even to `initRepo`, which would edit its tracked `.gitignore`,
      // untrack build output and rewrite `.git/config`'s `user.*`. A
      // `GitHubConnection` row means the repo was handed to Shogo.
      if (!meta?.hasGithubConnection) {
        const originUrl = await getOriginRemoteUrl(workspacePath)
        if (originUrl) {
          results.push({ projectId, status: 'skipped-foreign-repo' })
          continue
        }
      }

      // A never-tracked project gets a repo + a one-time baseline checkpoint
      // (so users have a restore point). `initRepo` itself commits the
      // initial tree, leaving it clean — so we can't rely on a post-init
      // dirty check; we record the baseline unconditionally via
      // createCheckpoint (its commit==null branch captures the HEAD commit
      // idempotently). Existing repos use the dirtiness guard so untouched
      // projects aren't re-checkpointed every turn.
      const wasRepo = isGitRepo(workspacePath)
      if (!wasRepo) {
        await initRepo(workspacePath)
      } else {
        const status = await getStatus(workspacePath)
        if (!status.hasChanges) {
          results.push({ projectId, status: 'clean' })
          continue
        }
      }

      const checkpoint = await createCheckpoint({
        projectId,
        workspacePath,
        message: wasRepo ? changeMessage : baselineMessage,
        isAutomatic: true,
      })
      results.push({
        projectId,
        status: wasRepo ? 'checkpointed' : 'baselined',
        checkpointId: checkpoint.id,
      })
    } catch (err: any) {
      results.push({ projectId, status: 'error', error: err?.message ?? String(err) })
    }
  }

  return results
}
