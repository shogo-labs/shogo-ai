// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checkpoint Service - Manage project state snapshots
 *
 * Coordinates git operations with database records to provide
 * a complete checkpoint/rollback system for projects.
 *
 * Operations:
 * - createCheckpoint: Save current state as a named checkpoint
 * - listCheckpoints: Get checkpoint history for a project
 * - getCheckpoint: Get details of a specific checkpoint
 * - rollback: Restore project to a previous checkpoint
 * - getDiff: Compare checkpoint with current state
 */

import { execSync } from '@shogo/shared-runtime/child-process';
import { existsSync, mkdirSync } from 'fs';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../lib/prisma';
import { markProjectTurnsReverted } from '../lib/proxy-capture';
import * as gitService from './git.service';

// =============================================================================
// Types
// =============================================================================

export interface CreateCheckpointOptions {
  projectId: string;
  workspacePath: string;
  message: string;
  name?: string;
  description?: string;
  includeDatabase?: boolean;
  isAutomatic?: boolean;
  createdBy?: string;
  /**
   * Force how the snapshot is recorded, overriding the project/env rule.
   * `ref` never touches the checked-out branch; `branch` is the historical
   * commit-on-HEAD behaviour (local-only projects).
   */
  mode?: CheckpointMode;
}

/**
 * How a checkpoint's snapshot is recorded.
 *
 * - `branch`: a real commit on the project branch (what every checkpoint did
 *   before 2026-10-19). Correct for local-only projects, where the commit
 *   history *is* the feature the user browses.
 * - `ref`: a `commit-tree` snapshot pinned by `refs/shogo/checkpoints/**`, so
 *   a project whose branch belongs to the user (a `GitHubConnection`) never
 *   gains an `AI: …` commit and nothing is ever pushed for a checkpoint.
 */
export type CheckpointMode = 'branch' | 'ref';

export interface CheckpointResult {
  id: string;
  commitSha: string;
  branch: string;
  name: string | null;
  description: string | null;
  message: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  includesDb: boolean;
  isAutomatic: boolean;
  createdAt: Date;
  /** Where `commitSha` lives. Absent on results built by older callers. */
  mode?: CheckpointMode;
  /** The ref pinning a `ref`-mode snapshot; null for `branch`-mode rows. */
  refName?: string | null;
}

export interface RollbackOptions {
  projectId: string;
  workspacePath: string;
  checkpointId: string;
  includeDatabase?: boolean;
  createdBy?: string;
}

export interface RollbackResult {
  success: boolean;
  previousCheckpoint: CheckpointResult;
  newCheckpoint: CheckpointResult | null;
  error?: string;
}

export interface CheckpointDiff {
  checkpointId: string;
  commitSha: string;
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
  }>;
  totalAdditions: number;
  totalDeletions: number;
}

// =============================================================================
// Configuration
// =============================================================================

const SHOGO_DIR = '.shogo';
const DB_SNAPSHOT_FILE = 'database.sql.gz';

/** The `ProjectCheckpoint` columns every result mapping reads. */
type CheckpointRow = {
  id: string;
  commitSha: string;
  branch: string;
  name: string | null;
  description: string | null;
  commitMessage: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  includesDb: boolean;
  isAutomatic: boolean;
  createdAt: Date;
  mode?: string | null;
  refName?: string | null;
};

/** Map a row to the public result shape — one place, so `mode`/`refName` never drift. */
function toCheckpointResult(c: CheckpointRow): CheckpointResult {
  return {
    id: c.id,
    commitSha: c.commitSha,
    branch: c.branch,
    name: c.name,
    description: c.description,
    message: c.commitMessage,
    filesChanged: c.filesChanged,
    additions: c.additions,
    deletions: c.deletions,
    includesDb: c.includesDb,
    isAutomatic: c.isAutomatic,
    createdAt: c.createdAt,
    mode: c.mode === 'ref' ? 'ref' : 'branch',
    refName: c.refName ?? null,
  };
}

// =============================================================================
// Checkpoint Service
// =============================================================================

/**
 * Create a new checkpoint (snapshot) of the project state.
 */
/**
 * Typed error thrown when a checkpoint operation is attempted on a
 * `workingMode='external'` project. Routes that catch this should
 * surface it to the UI as a 409 with `code: 'checkpoints_disabled_in_external_mode'`
 * so the CheckpointsPanel renders the "use your own git" banner.
 */
export class CheckpointsDisabledError extends Error {
  readonly code = 'checkpoints_disabled_in_external_mode' as const
  constructor() {
    super(
      'Auto-checkpointing is disabled for external (folder-linked) projects. ' +
        "Use your own git workflow inside the linked folder — Shogo doesn't manage the repo.",
    )
    this.name = 'CheckpointsDisabledError'
  }
}

/**
 * Typed error thrown when the project's folder is a checkout of someone else's
 * git repository (a manual `git clone`, or any repo whose `origin` a human
 * configured) and there is no `GitHubConnection` handing it to Shogo.
 *
 * Routes surface this as a 409 with `code: 'checkpoints_disabled_foreign_repo'`
 * so the panel renders the same "use your own git" banner as external mode.
 * Thrown BEFORE `initRepo`, so the tracked `.gitignore`, the index and
 * `.git/config`'s `user.*` are never touched.
 */
export class CheckpointsDisabledForeignRepoError extends Error {
  readonly code = 'checkpoints_disabled_foreign_repo' as const
  readonly originUrl: string
  constructor(originUrl: string) {
    super(
      `This project's folder is a checkout of another git repository (${originUrl}), ` +
        "so Shogo won't commit into it. Use your own git — or connect the repo to Shogo " +
        'so Shogo manages its history.',
    )
    this.name = 'CheckpointsDisabledForeignRepoError'
    this.originUrl = originUrl
  }
}

/** The project columns that decide checkpoint ownership. */
type CheckpointOwnershipProject = {
  workingMode?: string | null
  githubConnection?: { id: string } | null
  /** `Project.settings` — carries the per-project `checkpointMode` override. */
  settings?: unknown
} | null

/**
 * Ownership gate: Shogo only commits into a repo it owns.
 *
 * Ownership is decided from the repo itself, not `workingMode`. A project with
 * no `origin` remote (every fresh `initRepo`) is ours; a project with a
 * `GitHubConnection` row handed its repo to Shogo (`github_connect`); anything
 * else is someone else's repo and must never be committed to.
 *
 * Must run BEFORE `gitService.initRepo()` — that call is not a no-op on an
 * existing repo: it appends to the tracked `.gitignore`, `git rm --cached`s
 * build output, and overwrites repo-local `user.name` / `user.email` (which is
 * exactly what made auto-checkpoint commits fail the CLA check on a clone).
 */
async function assertRepoOwnedByShogo(
  project: CheckpointOwnershipProject,
  workspacePath: string,
): Promise<void> {
  if (project?.githubConnection) return
  const originUrl = await gitService.getOriginRemoteUrl(workspacePath)
  if (originUrl) throw new CheckpointsDisabledForeignRepoError(originUrl)
}

/**
 * Decide how a checkpoint for this project should be recorded.
 *
 * Precedence, highest first:
 *   1. `SHOGO_CHECKPOINT_MODE` — the operator kill switch (`branch` restores
 *      the pre-SHO-61 behaviour everywhere without a code change);
 *   2. `settings.checkpointMode` — a per-project override, which outranks a
 *      caller's hint because it is the project owner's explicit choice;
 *   3. an explicit `requested` mode from a caller that already knows the
 *      project (the workspace auto-checkpoint passes `ref` for a connected
 *      project);
 *   4. the default rule: `ref` when the project has a `GitHubConnection` (the
 *      branch is the user's, so Shogo must not commit to it), `branch`
 *      otherwise (local-only projects keep the commit-history UX).
 */
export function resolveCheckpointMode(
  project: CheckpointOwnershipProject,
  requested?: CheckpointMode,
): CheckpointMode {
  const envMode = process.env.SHOGO_CHECKPOINT_MODE?.trim().toLowerCase();
  if (envMode === 'ref' || envMode === 'branch') return envMode;

  const settings = project?.settings && typeof project.settings === 'object'
    ? (project.settings as Record<string, unknown>)
    : null;
  const pinned = typeof settings?.checkpointMode === 'string'
    ? settings.checkpointMode.trim().toLowerCase()
    : '';
  if (pinned === 'ref' || pinned === 'branch') return pinned;

  if (requested === 'ref' || requested === 'branch') return requested;

  return project?.githubConnection ? 'ref' : 'branch';
}

/**
 * Idempotently record a `ProjectCheckpoint` row for an ALREADY-EXISTING commit
 * (identified by SHA) WITHOUT performing any git operations. This is the
 * lightweight counterpart to {@link createCheckpoint} for callers that already
 * hold a durable commit and just need the metadata row:
 *   - the runtime pod after a local commit (internal `checkpoints/record` API)
 *   - the publish flow after it tags the deployed HEAD
 *
 * Dedupes on `(projectId, commitSha)` so pod retries / re-publishes never
 * create duplicate rows. Returns the row id (and whether it already existed),
 * or null when `commitSha` is not a plausible git object id.
 */
export async function recordCheckpointForCommit(
  projectId: string,
  commitSha: string,
  opts: {
    name?: string | null;
    commitMessage?: string;
    branch?: string;
    filesChanged?: number;
    additions?: number;
    deletions?: number;
    includesDb?: boolean;
    isAutomatic?: boolean;
    createdBy?: string | null;
  } = {},
): Promise<{ id: string; deduped: boolean } | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) return null;

  const existing = await prisma.projectCheckpoint.findFirst({
    where: { projectId, commitSha },
    select: { id: true },
  });
  if (existing) return { id: existing.id, deduped: true };

  const row = await prisma.projectCheckpoint.create({
    data: {
      projectId,
      name: opts.name ?? null,
      commitSha,
      commitMessage:
        opts.commitMessage && opts.commitMessage.trim() ? opts.commitMessage : '(no message)',
      branch: opts.branch && opts.branch.trim() ? opts.branch : 'main',
      includesDb: opts.includesDb ?? false,
      filesChanged: opts.filesChanged ?? 0,
      additions: opts.additions ?? 0,
      deletions: opts.deletions ?? 0,
      isAutomatic: opts.isAutomatic ?? true,
      createdBy: opts.createdBy ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, deduped: false };
}

export async function createCheckpoint(
  options: CreateCheckpointOptions
): Promise<CheckpointResult> {
  const {
    projectId,
    workspacePath,
    message,
    name,
    description,
    includeDatabase = false,
    isAutomatic = false,
    createdBy,
  } = options;

  // Defense-in-depth gate. The chat-turn caller in project-chat.ts also
  // checks `project.workingMode !== 'external'` before calling, but we
  // re-validate here so any future caller (e.g. publish, /checkpoints
  // POST) doesn't accidentally write commits into the user's repo.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workingMode: true, githubConnection: { select: { id: true } }, settings: true },
  });
  if ((project as { workingMode?: string } | null)?.workingMode === 'external') {
    throw new CheckpointsDisabledError();
  }

  // Ensure workspace exists
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace not found: ${workspacePath}`);
  }

  // Ownership gate — see assertRepoOwnedByShogo. Runs before initRepo so a
  // repo we don't own keeps its `.gitignore`, index and `user.*` intact.
  await assertRepoOwnedByShogo(project as CheckpointOwnershipProject, workspacePath);

  // Initialize git repo if needed
  const { branch } = await gitService.initRepo(workspacePath);

  // Prepare .shogo directory
  const shogoDir = join(workspacePath, SHOGO_DIR);
  if (!existsSync(shogoDir)) {
    mkdirSync(shogoDir, { recursive: true });
  }

  // Include database snapshot if requested
  if (includeDatabase) {
    await createDatabaseSnapshot(workspacePath, projectId);
  }

  // Decide how to record the snapshot. `ref` projects (every project with a
  // GitHubConnection) get a commit pinned by refs/shogo/checkpoints/**, so the
  // branch the user has checked out never gains an "AI: …" commit and
  // syncAfterCheckpoint has nothing new to push. `branch` keeps the historical
  // commit-on-HEAD behaviour for local-only projects.
  const mode = resolveCheckpointMode(project as CheckpointOwnershipProject, options.mode);

  let commit: { sha: string; message: string; filesChanged: number; additions: number; deletions: number } | null =
    null;
  let refName: string | null = null;
  if (mode === 'ref') {
    const snapshot = await gitService.snapshotTree(workspacePath, { message, branch });
    if (snapshot) {
      refName = snapshot.refName;
      commit = {
        sha: snapshot.sha,
        message: snapshot.message,
        filesChanged: snapshot.filesChanged,
        additions: snapshot.additions,
        deletions: snapshot.deletions,
      };
    }
  } else {
    commit = await gitService.commit(workspacePath, {
      message,
      includeUntracked: true,
    });
  }

  if (!commit) {
    // No changes since HEAD (or an unchanged working tree for a ref project):
    // reuse the latest commit rather than inventing an empty snapshot.
    const headCommit = await gitService.getCommit(workspacePath, 'HEAD');
    if (!headCommit) {
      throw new Error('No commits in repository and no changes to commit');
    }

    // Check if we already have a checkpoint for this commit
    const existingCheckpoint = await prisma.projectCheckpoint.findFirst({
      where: { projectId, commitSha: headCommit.sha },
    });

    if (existingCheckpoint) {
      return toCheckpointResult(existingCheckpoint);
    }

    // Create checkpoint record for existing commit (use stats from the commit)
    const checkpoint = await prisma.projectCheckpoint.create({
      data: {
        projectId,
        name,
        description,
        commitSha: headCommit.sha,
        commitMessage: message || headCommit.message,
        branch,
        // A HEAD commit is a real branch commit no matter which mode the
        // project is in, so record it honestly as a `branch` row.
        mode: 'branch',
        refName: null,
        includesDb: includeDatabase,
        filesChanged: headCommit.filesChanged,
        additions: headCommit.additions,
        deletions: headCommit.deletions,
        isAutomatic,
        createdBy,
      },
    });

    // Auto-sync to GitHub if connected (fire-and-forget)
    syncAfterCheckpoint(projectId).catch(() => {});

    return toCheckpointResult(checkpoint);
  }

  // Save checkpoint metadata locally
  await gitService.saveCheckpointMetadata(workspacePath, {
    id: 'pending', // Will be updated after DB insert
    name,
    description,
    createdAt: new Date(),
    createdBy,
    includesDb: includeDatabase,
  });

  // Create checkpoint record in database
  const checkpoint = await prisma.projectCheckpoint.create({
    data: {
      projectId,
      name,
      description,
      commitSha: commit.sha,
      commitMessage: message,
      branch,
      mode,
      refName,
      includesDb: includeDatabase,
      filesChanged: commit.filesChanged,
      additions: commit.additions,
      deletions: commit.deletions,
      isAutomatic,
      createdBy,
    },
  });

  // Auto-sync to GitHub if connected (fire-and-forget). A ref snapshot is not
  // on the branch, so there is nothing for the push to publish — skip it
  // entirely instead of waking the GitHub client on every chat turn.
  if (mode === 'branch') {
    syncAfterCheckpoint(projectId).catch(() => {});
  }

  return toCheckpointResult(checkpoint);
}

/**
 * List checkpoints for a project.
 */
export async function listCheckpoints(
  projectId: string,
  options?: { limit?: number; before?: string }
): Promise<CheckpointResult[]> {
  const { limit = 50, before } = options || {};

  const whereClause: any = { projectId };
  if (before) {
    const beforeCheckpoint = await prisma.projectCheckpoint.findUnique({
      where: { id: before },
    });
    if (beforeCheckpoint) {
      whereClause.createdAt = { lt: beforeCheckpoint.createdAt };
    }
  }

  const checkpoints = await prisma.projectCheckpoint.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return checkpoints.map(toCheckpointResult);
}

/**
 * Get a specific checkpoint by ID.
 */
export async function getCheckpoint(
  checkpointId: string
): Promise<CheckpointResult | null> {
  const checkpoint = await prisma.projectCheckpoint.findUnique({
    where: { id: checkpointId },
  });

  if (!checkpoint) {
    return null;
  }

  return toCheckpointResult(checkpoint);
}

/**
 * Get checkpoint by commit SHA.
 */
export async function getCheckpointByCommit(
  projectId: string,
  commitSha: string
): Promise<CheckpointResult | null> {
  const checkpoint = await prisma.projectCheckpoint.findFirst({
    where: { projectId, commitSha },
  });

  if (!checkpoint) {
    return null;
  }

  return toCheckpointResult(checkpoint);
}

/**
 * Rollback a project to a specific checkpoint.
 */
export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const { projectId, workspacePath, checkpointId, includeDatabase, createdBy } = options;

  // Get the target checkpoint
  const checkpoint = await prisma.projectCheckpoint.findUnique({
    where: { id: checkpointId },
  });

  if (!checkpoint) {
    return {
      success: false,
      previousCheckpoint: null as any,
      newCheckpoint: null,
      error: 'Checkpoint not found',
    };
  }

  if (checkpoint.projectId !== projectId) {
    return {
      success: false,
      previousCheckpoint: null as any,
      newCheckpoint: null,
      error: 'Checkpoint does not belong to this project',
    };
  }

  // Same ownership gate as createCheckpoint, and for a stronger reason: the
  // pre-rollback checkpoint would commit, and `checkout --force` +
  // `read-tree -u --reset` would rewrite a working tree we don't own.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workingMode: true, githubConnection: { select: { id: true } } },
  });
  if ((project as { workingMode?: string } | null)?.workingMode === 'external') {
    throw new CheckpointsDisabledError();
  }
  await assertRepoOwnedByShogo(project as CheckpointOwnershipProject, workspacePath);

  // Create a pre-rollback checkpoint to preserve current state
  let preRollbackCheckpoint: CheckpointResult | null = null;
  try {
    const status = await gitService.getStatus(workspacePath);
    if (status.hasChanges) {
      preRollbackCheckpoint = await createCheckpoint({
        projectId,
        workspacePath,
        message: `Auto-save before rollback to "${checkpoint.name || checkpoint.commitSha.substring(0, 7)}"`,
        name: 'Pre-rollback auto-save',
        isAutomatic: true,
        includeDatabase: includeDatabase && checkpoint.includesDb,
        createdBy,
      });
    }
  } catch (err) {
    console.warn('[Checkpoint] Failed to create pre-rollback checkpoint:', err);
  }

  // Make sure HEAD is on the project branch. Unlike the old flow we never
  // detach onto the checkpoint commit — keeping the branch ref at its current
  // tip is what lets us preserve the commits made after the checkpoint.
  //
  // Ref snapshots skip this: their whole point is that HEAD never moved, so
  // forcing a checkout would drag the working tree (and a possibly different
  // branch) around for no reason. `read-tree` below restores the tree in place.
  if (checkpoint.mode !== 'ref') {
    const result = await gitService.checkout(workspacePath, checkpoint.branch, {
      force: true,
    });

    if (!result.success) {
      return {
        success: false,
        previousCheckpoint: toCheckpointResult(checkpoint),
        newCheckpoint: preRollbackCheckpoint,
        error: result.error || 'Git checkout failed',
      };
    }
  }

  // Restore the working tree + index to the checkpoint's tree WITHOUT moving
  // the branch ref. `git read-tree -u --reset <sha>` performs the same index
  // and working-tree update as `git reset --hard`, but it leaves HEAD pointing
  // at the current branch tip. For a branch checkpoint the post-rollback
  // checkpoint then records a single revert commit on top of the existing
  // history, so none of the commits made after the checkpoint are deleted; for
  // a ref checkpoint it records a new snapshot and the branch tip stays put.
  try {
    execSync(`git read-tree -u --reset ${checkpoint.commitSha}`, {
      cwd: workspacePath,
      stdio: 'pipe',
    });
  } catch (err: any) {
    return {
      success: false,
      previousCheckpoint: toCheckpointResult(checkpoint),
      newCheckpoint: preRollbackCheckpoint,
      error: err?.message || 'Failed to restore checkpoint tree',
    };
  }

  // Restore database if checkpoint includes it and user requested it
  if (includeDatabase && checkpoint.includesDb) {
    try {
      await restoreDatabaseSnapshot(workspacePath, projectId);
    } catch (err: any) {
      console.error('[Checkpoint] Database restore failed:', err);
      // Continue - file rollback succeeded even if DB restore failed
    }
  }

  // Commit the rolled-back tree as a new checkpoint. Because HEAD still points
  // at the old branch tip, this records a single commit whose diff is the
  // inverse of every change made since the checkpoint — a revert, not a
  // history rewrite.
  let newCheckpoint: CheckpointResult | null = null;
  try {
    newCheckpoint = await createCheckpoint({
      projectId,
      workspacePath,
      message: `Rollback to "${checkpoint.name || checkpoint.commitSha.substring(0, 7)}"`,
      name: `Rollback to ${checkpoint.name || checkpoint.commitSha.substring(0, 7)}`,
      description: `Restored from checkpoint created at ${checkpoint.createdAt.toISOString()}`,
      includeDatabase: includeDatabase && checkpoint.includesDb,
      createdBy,
    });
  } catch (err) {
    console.warn('[Checkpoint] Failed to create post-rollback checkpoint:', err);
  }

  void markProjectTurnsReverted(projectId, checkpoint.createdAt).catch((err) => {
    console.warn('[Checkpoint] Failed to mark proxy turns as reverted:', err);
  });

  return {
    success: true,
    previousCheckpoint: toCheckpointResult(checkpoint),
    newCheckpoint,
  };
}

/**
 * Get diff between a checkpoint and current state (or another checkpoint).
 */
export async function getDiff(
  workspacePath: string,
  checkpointId: string,
  toCheckpointId?: string
): Promise<CheckpointDiff | null> {
  const fromCheckpoint = await prisma.projectCheckpoint.findUnique({
    where: { id: checkpointId },
  });

  if (!fromCheckpoint) {
    return null;
  }

  let toRef = 'HEAD';
  if (toCheckpointId) {
    const toCheckpoint = await prisma.projectCheckpoint.findUnique({
      where: { id: toCheckpointId },
    });
    if (toCheckpoint) {
      toRef = toCheckpoint.commitSha;
    }
  }

  // A pre-ref (mode='branch') row points at a commit reachable only from the
  // branch. Pin it on first touch so a later rewrite of that branch — a
  // force-push from the user's own git, a rebase, `git gc` — cannot make the
  // row's diff unreadable.
  if (fromCheckpoint.mode !== 'ref' && !fromCheckpoint.refName) {
    await gitService.ensureLegacyCheckpointRef(workspacePath, fromCheckpoint.commitSha);
  }

  const diff = await gitService.getDiff(workspacePath, fromCheckpoint.commitSha, toRef);

  return {
    checkpointId: fromCheckpoint.id,
    commitSha: fromCheckpoint.commitSha,
    files: diff.files,
    totalAdditions: diff.totalAdditions,
    totalDeletions: diff.totalDeletions,
  };
}

/**
 * Get the current git status for a project workspace.
 */
export async function getProjectStatus(workspacePath: string) {
  return gitService.getStatus(workspacePath);
}

/**
 * Initialize git repository for a project if not already initialized.
 */
export async function ensureGitRepo(workspacePath: string): Promise<void> {
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  await gitService.initRepo(workspacePath);
}

// =============================================================================
// Database Snapshot Helpers
// =============================================================================

/**
 * Create a database snapshot and save it to .shogo/database.sql.gz
 */
async function createDatabaseSnapshot(
  workspacePath: string,
  projectId: string
): Promise<void> {
  const shogoDir = join(workspacePath, SHOGO_DIR);
  const snapshotPath = join(shogoDir, DB_SNAPSHOT_FILE);

  // Get database URL from environment
  const dbUrl = process.env.PROJECTS_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[Checkpoint] No database URL configured, skipping DB snapshot');
    return;
  }

  try {
    // Parse database URL to extract credentials
    const url = new URL(dbUrl);
    const host = url.hostname;
    const port = url.port || '5432';
    const user = url.username;
    const password = url.password;
    const database = url.pathname.slice(1); // Remove leading /

    const env = {
      ...process.env,
      PGHOST: host,
      PGPORT: port,
      PGUSER: user,
      PGPASSWORD: password,
    };

    // Create compressed dump
    execSync(`pg_dump ${database} | gzip > "${snapshotPath}"`, {
      env,
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024, // 100MB
    });

    console.log(`[Checkpoint] Database snapshot saved to ${snapshotPath}`);
  } catch (err: any) {
    console.error('[Checkpoint] Database snapshot failed:', err.message);
    // Remove partial snapshot file
    try {
      await unlink(snapshotPath);
    } catch {}
    throw err;
  }
}

/**
 * Restore database from .shogo/database.sql.gz snapshot
 */
async function restoreDatabaseSnapshot(
  workspacePath: string,
  projectId: string
): Promise<void> {
  const snapshotPath = join(workspacePath, SHOGO_DIR, DB_SNAPSHOT_FILE);

  if (!existsSync(snapshotPath)) {
    console.warn('[Checkpoint] No database snapshot found, skipping restore');
    return;
  }

  const dbUrl = process.env.PROJECTS_DATABASE_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[Checkpoint] No database URL configured, skipping DB restore');
    return;
  }

  try {
    const url = new URL(dbUrl);
    const host = url.hostname;
    const port = url.port || '5432';
    const user = url.username;
    const password = url.password;
    const database = url.pathname.slice(1);

    const env = {
      ...process.env,
      PGHOST: host,
      PGPORT: port,
      PGUSER: user,
      PGPASSWORD: password,
      PGDATABASE: database,
    };

    // Restore from compressed dump
    execSync(`gunzip -c "${snapshotPath}" | psql -q`, {
      env,
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024,
    });

    console.log(`[Checkpoint] Database restored from ${snapshotPath}`);
  } catch (err: any) {
    console.error('[Checkpoint] Database restore failed:', err.message);
    throw err;
  }
}

/**
 * Delete old checkpoints beyond a retention limit.
 * Keeps at least the specified number of checkpoints per project.
 */
export async function pruneCheckpoints(
  projectId: string,
  options?: { keepCount?: number; keepDays?: number; workspacePath?: string }
): Promise<number> {
  const { keepCount = 100, keepDays = 30 } = options || {};

  // Get all checkpoints ordered by creation date
  const checkpoints = await prisma.projectCheckpoint.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });

  if (checkpoints.length <= keepCount) {
    return 0; // Nothing to prune
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);

  // Keep the most recent `keepCount` checkpoints
  // Also keep any named checkpoints within the retention period
  const toDelete = checkpoints.slice(keepCount).filter((c) => {
    // Keep named checkpoints within retention period
    if (c.name && c.createdAt > cutoffDate) {
      return false;
    }
    return true;
  });

  if (toDelete.length === 0) {
    return 0;
  }

  // Drop the refs that pinned deleted snapshots. Without this, refs/shogo/**
  // keeps every pruned snapshot reachable and `git gc` can never reclaim the
  // objects. Best-effort: a missing workspace or an already-deleted ref must
  // not stop the row delete (that would re-prune the same rows forever).
  const workspacePath = options?.workspacePath;
  if (workspacePath) {
    for (const row of toDelete) {
      // A legacy (mode='branch') row has no ref of its own, but getDiff pins
      // one under legacy/<sha> the first time it reads the row. Drop that pin
      // too; deleting a ref that was never created is a no-op.
      const refName = row.refName
        ?? `${gitService.CHECKPOINT_REF_PREFIX}/legacy/${row.commitSha}`;
      await gitService.deleteCheckpointRef(workspacePath, refName);
    }
  }

  const deleteIds = toDelete.map((c) => c.id);
  await prisma.projectCheckpoint.deleteMany({
    where: { id: { in: deleteIds } },
  });

  return deleteIds.length;
}

// =============================================================================
// GitHub Auto-Sync
// =============================================================================

/**
 * Auto-push to GitHub after a checkpoint is created.
 * Only pushes if the project has a GitHub connection with syncEnabled=true.
 * Uses lazy import to avoid hard dependency on github.service / jsonwebtoken.
 * This is fire-and-forget -- errors are logged but do not propagate.
 *
 * The push runs in the project's runtime, which owns the branch being pushed.
 */
export async function syncAfterCheckpoint(projectId: string): Promise<void> {
  try {
    // Check if project has a GitHub connection with sync enabled
    const connection = await prisma.gitHubConnection.findUnique({
      where: { projectId },
    });

    if (!connection || !connection.syncEnabled) {
      return; // No connection or sync disabled -- nothing to do
    }

    // Desktop never pushes from here. The guard lets the desktop bundle
    // dead-code-eliminate the GitHub client and its Redis-backed
    // dependencies (see local-bundle-integrity.test.ts).
    // Lazy import github service to avoid loading jsonwebtoken when not needed
    const githubService = process.env.SHOGO_LOCAL_MODE !== 'true' ? await import('./github.service') : null;
    if (!githubService) return;

    // App connections need the server-side GitHub App; token connections don't.
    if (connection.authType !== 'token' && !githubService.isConfigured()) {
      return;
    }

    // Push in the background (fire-and-forget)
    const { runtimeGitHubWorkspace } = await import('./github-workspace');
    githubService.pushToGitHub(projectId, runtimeGitHubWorkspace(projectId)).catch((err) => {
      console.warn('[Checkpoint] Auto-sync to GitHub failed:', err.message);
    });
  } catch (err: any) {
    console.warn('[Checkpoint] syncAfterCheckpoint error:', err.message);
  }
}
