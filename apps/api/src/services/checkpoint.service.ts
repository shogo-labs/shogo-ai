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

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { writeFile, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { prisma } from '../lib/prisma';
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
}

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

// =============================================================================
// Checkpoint Service
// =============================================================================

/**
 * Create a new checkpoint (snapshot) of the project state.
 */
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

  // Ensure workspace exists
  if (!existsSync(workspacePath)) {
    throw new Error(`Workspace not found: ${workspacePath}`);
  }

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

  // Create git commit
  const commit = await gitService.commit(workspacePath, {
    message,
    includeUntracked: true,
  });

  if (!commit) {
    // No changes to commit - get the latest commit instead
    const headCommit = await gitService.getCommit(workspacePath, 'HEAD');
    if (!headCommit) {
      throw new Error('No commits in repository and no changes to commit');
    }

    // Check if we already have a checkpoint for this commit
    const existingCheckpoint = await prisma.projectCheckpoint.findFirst({
      where: { projectId, commitSha: headCommit.sha },
    });

    if (existingCheckpoint) {
      return {
        id: existingCheckpoint.id,
        commitSha: existingCheckpoint.commitSha,
        branch: existingCheckpoint.branch,
        name: existingCheckpoint.name,
        description: existingCheckpoint.description,
        message: existingCheckpoint.commitMessage,
        filesChanged: existingCheckpoint.filesChanged,
        additions: existingCheckpoint.additions,
        deletions: existingCheckpoint.deletions,
        includesDb: existingCheckpoint.includesDb,
        isAutomatic: existingCheckpoint.isAutomatic,
        createdAt: existingCheckpoint.createdAt,
      };
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
        includesDb: includeDatabase,
        filesChanged: headCommit.filesChanged,
        additions: headCommit.additions,
        deletions: headCommit.deletions,
        isAutomatic,
        createdBy,
      },
    });

    // Auto-sync to GitHub if connected (fire-and-forget)
    syncAfterCheckpoint(projectId, workspacePath).catch(() => {});

    return {
      id: checkpoint.id,
      commitSha: checkpoint.commitSha,
      branch: checkpoint.branch,
      name: checkpoint.name,
      description: checkpoint.description,
      message: checkpoint.commitMessage,
      filesChanged: checkpoint.filesChanged,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
      includesDb: checkpoint.includesDb,
      isAutomatic: checkpoint.isAutomatic,
      createdAt: checkpoint.createdAt,
    };
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
      includesDb: includeDatabase,
      filesChanged: commit.filesChanged,
      additions: commit.additions,
      deletions: commit.deletions,
      isAutomatic,
      createdBy,
    },
  });

  // Auto-sync to GitHub if connected (fire-and-forget)
  syncAfterCheckpoint(projectId, workspacePath).catch(() => {});

  return {
    id: checkpoint.id,
    commitSha: checkpoint.commitSha,
    branch: checkpoint.branch,
    name: checkpoint.name,
    description: checkpoint.description,
    message: checkpoint.commitMessage,
    filesChanged: checkpoint.filesChanged,
    additions: checkpoint.additions,
    deletions: checkpoint.deletions,
    includesDb: checkpoint.includesDb,
    isAutomatic: checkpoint.isAutomatic,
    createdAt: checkpoint.createdAt,
  };
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

  return checkpoints.map((c) => ({
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
  }));
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

  return {
    id: checkpoint.id,
    commitSha: checkpoint.commitSha,
    branch: checkpoint.branch,
    name: checkpoint.name,
    description: checkpoint.description,
    message: checkpoint.commitMessage,
    filesChanged: checkpoint.filesChanged,
    additions: checkpoint.additions,
    deletions: checkpoint.deletions,
    includesDb: checkpoint.includesDb,
    isAutomatic: checkpoint.isAutomatic,
    createdAt: checkpoint.createdAt,
  };
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

  return {
    id: checkpoint.id,
    commitSha: checkpoint.commitSha,
    branch: checkpoint.branch,
    name: checkpoint.name,
    description: checkpoint.description,
    message: checkpoint.commitMessage,
    filesChanged: checkpoint.filesChanged,
    additions: checkpoint.additions,
    deletions: checkpoint.deletions,
    includesDb: checkpoint.includesDb,
    isAutomatic: checkpoint.isAutomatic,
    createdAt: checkpoint.createdAt,
  };
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

  // Checkout the target commit
  const result = await gitService.checkout(workspacePath, checkpoint.commitSha, {
    force: true,
  });

  if (!result.success) {
    return {
      success: false,
      previousCheckpoint: {
        id: checkpoint.id,
        commitSha: checkpoint.commitSha,
        branch: checkpoint.branch,
        name: checkpoint.name,
        description: checkpoint.description,
        message: checkpoint.commitMessage,
        filesChanged: checkpoint.filesChanged,
        additions: checkpoint.additions,
        deletions: checkpoint.deletions,
        includesDb: checkpoint.includesDb,
        isAutomatic: checkpoint.isAutomatic,
        createdAt: checkpoint.createdAt,
      },
      newCheckpoint: preRollbackCheckpoint,
      error: result.error || 'Git checkout failed',
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

  // Create a "rollback" checkpoint to mark this point in history
  let newCheckpoint: CheckpointResult | null = null;
  try {
    // Switch back to main branch with the rolled-back files
    await gitService.checkout(workspacePath, checkpoint.branch, { force: true });

    // Reset to the checkpoint commit
    execSync(`git reset --hard ${checkpoint.commitSha}`, {
      cwd: workspacePath,
      stdio: 'pipe',
    });

    // Create a new commit marking the rollback
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

  return {
    success: true,
    previousCheckpoint: {
      id: checkpoint.id,
      commitSha: checkpoint.commitSha,
      branch: checkpoint.branch,
      name: checkpoint.name,
      description: checkpoint.description,
      message: checkpoint.commitMessage,
      filesChanged: checkpoint.filesChanged,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
      includesDb: checkpoint.includesDb,
      isAutomatic: checkpoint.isAutomatic,
      createdAt: checkpoint.createdAt,
    },
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
  options?: { keepCount?: number; keepDays?: number }
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
 */
export async function syncAfterCheckpoint(
  projectId: string,
  workspacePath: string
): Promise<void> {
  try {
    // Check if project has a GitHub connection with sync enabled
    const connection = await prisma.gitHubConnection.findUnique({
      where: { projectId },
    });

    if (!connection || !connection.syncEnabled) {
      return; // No connection or sync disabled -- nothing to do
    }

    // Lazy import github service to avoid loading jsonwebtoken when not needed
    const githubService = await import('./github.service');

    if (!githubService.isConfigured()) {
      return; // GitHub App not configured on this server
    }

    // Push in the background (fire-and-forget)
    githubService.pushToGitHub(projectId, workspacePath).catch((err) => {
      console.warn('[Checkpoint] Auto-sync to GitHub failed:', err.message);
    });
  } catch (err: any) {
    console.warn('[Checkpoint] syncAfterCheckpoint error:', err.message);
  }
}
