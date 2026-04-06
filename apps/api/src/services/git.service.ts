// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git Service - Local git operations for project workspaces
 *
 * Handles git initialization, commits, checkouts, and history for project directories.
 * Each project workspace is a git repository that can optionally sync to GitHub.
 *
 * Operations:
 * - initRepo: Initialize git repo in project workspace
 * - commit: Stage and commit changes
 * - checkout: Switch to a specific commit/branch
 * - getHistory: Get commit log
 * - getDiff: Get diff between commits
 * - getStatus: Get working directory status
 */

import { execSync, execFileSync, exec } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

let _gitAvailable: boolean | null = null;

/**
 * Check whether the `git` binary is available on the host.
 * Result is cached after the first probe.
 */
export function isGitAvailable(): boolean {
  if (_gitAvailable !== null) return _gitAvailable;
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}

function requireGit(): void {
  if (!isGitAvailable()) {
    throw new Error('Git is not installed. Checkpoint and version-control features require git on the host machine.');
  }
}

// =============================================================================
// Types
// =============================================================================

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  hasChanges: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: Date;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface GitDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  oldPath?: string; // For renamed files
}

export interface GitDiff {
  files: GitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface CommitOptions {
  message: string;
  author?: string;
  email?: string;
  includeUntracked?: boolean;
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_GITIGNORE = `# Dependencies
node_modules/
.bun/

# Build outputs
dist/
build/
.output/
.nitro/

# Environment
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test artifacts
coverage/
playwright-report/
test-results/

# Database (local dev)
*.db
*.db-journal
`;

const SHOGO_DIR = '.shogo';

// =============================================================================
// Git Service
// =============================================================================

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(workspacePath: string): boolean {
  return existsSync(join(workspacePath, '.git'));
}

/**
 * Initialize a git repository in the workspace.
 * Creates .gitignore and initial commit if not already a repo.
 */
export async function initRepo(
  workspacePath: string,
  options?: { defaultBranch?: string }
): Promise<{ created: boolean; branch: string }> {
  requireGit();
  const defaultBranch = options?.defaultBranch || 'main';

  if (isGitRepo(workspacePath)) {
    const branch = await getCurrentBranch(workspacePath);
    return { created: false, branch };
  }

  // Initialize git repo
  execFileSync('git', ['init', '-b', defaultBranch], { cwd: workspacePath, stdio: 'pipe' });

  // Create .gitignore if it doesn't exist
  const gitignorePath = join(workspacePath, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, DEFAULT_GITIGNORE);
  }

  // Create .shogo directory for checkpoint metadata
  const shogoDir = join(workspacePath, SHOGO_DIR);
  if (!existsSync(shogoDir)) {
    mkdirSync(shogoDir, { recursive: true });
  }

  // Configure git user for the repo (use Shogo AI as default)
  execFileSync('git', ['config', 'user.name', 'Shogo AI'], { cwd: workspacePath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'ai@shogo.dev'], { cwd: workspacePath, stdio: 'pipe' });

  // Initial commit
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'pipe' });
  
  try {
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: workspacePath, stdio: 'pipe' });
  } catch (err: any) {
    // No files to commit is OK
    if (!err.message?.includes('nothing to commit')) {
      throw err;
    }
  }

  return { created: true, branch: defaultBranch };
}

/**
 * Get current branch name.
 */
export async function getCurrentBranch(workspacePath: string): Promise<string> {
  try {
    const result = execSync('git branch --show-current', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return result.trim() || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Get the current HEAD commit SHA.
 */
export async function getHeadSha(workspacePath: string): Promise<string | null> {
  try {
    const result = execSync('git rev-parse HEAD', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get working directory status.
 */
export async function getStatus(workspacePath: string): Promise<GitStatus> {
  if (!isGitRepo(workspacePath)) {
    return {
      isRepo: false,
      branch: '',
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
      hasChanges: false,
    };
  }

  const branch = await getCurrentBranch(workspacePath);

  // Get porcelain status
  const statusOutput = execSync('git status --porcelain', {
    cwd: workspacePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of statusOutput.split('\n').filter(Boolean)) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3);

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push(filePath);
    } else if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push(filePath);
    } else if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      modified.push(filePath);
    }
  }

  // Get ahead/behind (only if there's a remote)
  let ahead = 0;
  let behind = 0;
  try {
    const aheadBehind = execSync('git rev-list --left-right --count HEAD...@{upstream}', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const [a, b] = aheadBehind.trim().split('\t').map(Number);
    ahead = a || 0;
    behind = b || 0;
  } catch {
    // No upstream configured, ignore
  }

  return {
    isRepo: true,
    branch,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    hasChanges: staged.length > 0 || modified.length > 0 || untracked.length > 0,
  };
}

/**
 * Stage and commit all changes.
 */
export async function commit(
  workspacePath: string,
  options: CommitOptions
): Promise<GitCommit | null> {
  requireGit();
  const { message, author, email, includeUntracked = true } = options;

  // Stage changes
  if (includeUntracked) {
    execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'pipe' });
  } else {
    execFileSync('git', ['add', '-u'], { cwd: workspacePath, stdio: 'pipe' });
  }

  // Check if there are changes to commit
  const status = await getStatus(workspacePath);
  if (!status.hasChanges && status.staged.length === 0) {
    return null; // Nothing to commit
  }

  // Build commit args (uses execFileSync to avoid shell injection)
  const commitArgs = ['commit', '-m', message];
  if (author && email) {
    commitArgs.push('--author', `${author} <${email}>`);
  }

  try {
    execFileSync('git', commitArgs, { cwd: workspacePath, stdio: 'pipe' });
  } catch (err: any) {
    if (err.message?.includes('nothing to commit')) {
      return null;
    }
    throw err;
  }

  // Get the commit we just created
  return await getCommit(workspacePath, 'HEAD');
}

/**
 * Get details of a specific commit.
 */
export async function getCommit(
  workspacePath: string,
  ref: string = 'HEAD'
): Promise<GitCommit | null> {
  try {
    // Null-byte delimiter avoids collisions with pipe chars in commit messages
    const format = '%H%x00%h%x00%s%x00%an%x00%ae%x00%aI';
    const info = execFileSync('git', ['log', '-1', `--format=${format}`, ref], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    const [sha, shortSha, message, author, authorEmail, dateStr] = info.split('\0');

    // Get diff stats
    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;

    try {
      // Try to get stats comparing with parent
      const stats = execFileSync('git', ['diff', '--shortstat', `${ref}^..${ref}`], {
        cwd: workspacePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      const filesMatch = stats.match(/(\d+) files? changed/);
      const addMatch = stats.match(/(\d+) insertions?\(\+\)/);
      const delMatch = stats.match(/(\d+) deletions?\(-\)/);

      filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
      additions = addMatch ? parseInt(addMatch[1], 10) : 0;
      deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch {
      // First commit has no parent - use --root to get stats
      try {
        const stats = execFileSync('git', ['diff-tree', '--shortstat', '--root', ref], {
          cwd: workspacePath,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();

        const filesMatch = stats.match(/(\d+) files? changed/);
        const addMatch = stats.match(/(\d+) insertions?\(\+\)/);

        filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
        additions = addMatch ? parseInt(addMatch[1], 10) : 0;
        deletions = 0;
      } catch {
        // Still no luck, that's OK
      }
    }

    return {
      sha,
      shortSha,
      message,
      author,
      authorEmail,
      date: new Date(dateStr),
      filesChanged,
      additions,
      deletions,
    };
  } catch {
    return null;
  }
}

/**
 * Get commit history.
 */
export async function getHistory(
  workspacePath: string,
  options?: { limit?: number; before?: string; branch?: string }
): Promise<GitCommit[]> {
  const { limit = 50, before, branch } = options || {};

  // Use record separator (ASCII 30) between commits, null byte within fields
  const format = '%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x1e';
  const args = ['log', `--format=${format}`, '-n', String(limit)];
  if (before) {
    args.push(`${before}^`);
  }
  if (branch) {
    args.push(branch);
  }

  try {
    const output = execFileSync('git', args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const commits: GitCommit[] = [];
    for (const record of output.trim().split('\x1e').filter(Boolean)) {
      const [sha, shortSha, message, author, authorEmail, dateStr] = record.trim().split('\0');
      if (!sha) continue;
      commits.push({
        sha,
        shortSha,
        message,
        author,
        authorEmail,
        date: new Date(dateStr),
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Get diff between two commits (or working directory).
 */
export async function getDiff(
  workspacePath: string,
  fromRef: string,
  toRef: string = 'HEAD'
): Promise<GitDiff> {
  try {
    const range = `${fromRef}..${toRef}`;

    // Get name-status for file list
    const nameStatus = execFileSync('git', ['diff', '--name-status', range], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // Get numstat for additions/deletions
    const numstat = execFileSync('git', ['diff', '--numstat', range], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const files: GitDiffFile[] = [];
    const statsMap = new Map<string, { additions: number; deletions: number }>();

    // Parse numstat
    for (const line of numstat.trim().split('\n').filter(Boolean)) {
      const [add, del, path] = line.split('\t');
      statsMap.set(path, {
        additions: add === '-' ? 0 : parseInt(add, 10),
        deletions: del === '-' ? 0 : parseInt(del, 10),
      });
    }

    // Parse name-status
    for (const line of nameStatus.trim().split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const statusCode = parts[0];
      const path = parts[1];
      const oldPath = parts[2]; // For renames

      let status: GitDiffFile['status'];
      switch (statusCode[0]) {
        case 'A':
          status = 'added';
          break;
        case 'D':
          status = 'deleted';
          break;
        case 'R':
          status = 'renamed';
          break;
        default:
          status = 'modified';
      }

      const stats = statsMap.get(path) || { additions: 0, deletions: 0 };
      files.push({
        path,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        oldPath: status === 'renamed' ? oldPath : undefined,
      });
    }

    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return { files, totalAdditions, totalDeletions };
  } catch {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }
}

/**
 * Checkout a specific commit or branch.
 * Creates a new branch from the commit if specified.
 */
export async function checkout(
  workspacePath: string,
  ref: string,
  options?: { createBranch?: string; force?: boolean }
): Promise<{ success: boolean; branch: string; error?: string }> {
  requireGit();
  const { createBranch, force } = options || {};

  try {
    const args = ['checkout'];
    if (force) {
      args.push('-f');
    }
    if (createBranch) {
      args.push('-b', createBranch);
    }
    args.push(ref);

    execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });

    const branch = await getCurrentBranch(workspacePath);
    return { success: true, branch };
  } catch (err: any) {
    return {
      success: false,
      branch: await getCurrentBranch(workspacePath),
      error: err.message || 'Checkout failed',
    };
  }
}

/**
 * Create a new branch.
 */
export async function createBranch(
  workspacePath: string,
  branchName: string,
  options?: { fromRef?: string; checkout?: boolean }
): Promise<{ success: boolean; error?: string }> {
  requireGit();
  const { fromRef, checkout: shouldCheckout = true } = options || {};

  try {
    const args = ['branch', branchName];
    if (fromRef) {
      args.push(fromRef);
    }

    execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });

    if (shouldCheckout) {
      execFileSync('git', ['checkout', branchName], { cwd: workspacePath, stdio: 'pipe' });
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Branch creation failed' };
  }
}

/**
 * List all branches.
 */
export async function listBranches(
  workspacePath: string
): Promise<{ name: string; isCurrent: boolean }[]> {
  try {
    const output = execSync('git branch', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        name: line.replace(/^\*?\s+/, ''),
        isCurrent: line.startsWith('*'),
      }));
  } catch {
    return [];
  }
}

/**
 * Add a remote.
 */
export async function addRemote(
  workspacePath: string,
  name: string,
  url: string
): Promise<void> {
  requireGit();
  try {
    execFileSync('git', ['remote', 'remove', name], { cwd: workspacePath, stdio: 'pipe' });
  } catch {
    // Remote doesn't exist, that's fine
  }

  execFileSync('git', ['remote', 'add', name, url], { cwd: workspacePath, stdio: 'pipe' });
}

/**
 * Push to remote.
 */
export async function push(
  workspacePath: string,
  options?: { remote?: string; branch?: string; force?: boolean; setUpstream?: boolean }
): Promise<{ success: boolean; error?: string }> {
  requireGit();
  const { remote = 'origin', branch, force, setUpstream } = options || {};

  try {
    const args = ['push'];
    if (setUpstream) {
      args.push('-u');
    }
    if (force) {
      args.push('--force');
    }
    args.push(remote);
    if (branch) {
      args.push(branch);
    }

    execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Push failed' };
  }
}

/**
 * Fetch from remote.
 */
export async function fetch(
  workspacePath: string,
  options?: { remote?: string; prune?: boolean }
): Promise<{ success: boolean; error?: string }> {
  requireGit();
  const { remote = 'origin', prune } = options || {};

  try {
    const args = ['fetch'];
    if (prune) {
      args.push('--prune');
    }
    args.push(remote);

    execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Fetch failed' };
  }
}

/**
 * Pull from remote.
 */
export async function pull(
  workspacePath: string,
  options?: { remote?: string; branch?: string; rebase?: boolean }
): Promise<{ success: boolean; error?: string }> {
  requireGit();
  const { remote = 'origin', branch, rebase } = options || {};

  try {
    const args = ['pull'];
    if (rebase) {
      args.push('--rebase');
    }
    args.push(remote);
    if (branch) {
      args.push(branch);
    }

    execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Pull failed' };
  }
}

/**
 * Save checkpoint metadata to .shogo/checkpoint.json
 */
export async function saveCheckpointMetadata(
  workspacePath: string,
  metadata: {
    id: string;
    name?: string;
    description?: string;
    createdAt: Date;
    createdBy?: string;
    includesDb: boolean;
  }
): Promise<void> {
  const shogoDir = join(workspacePath, SHOGO_DIR);
  if (!existsSync(shogoDir)) {
    mkdirSync(shogoDir, { recursive: true });
  }

  const metadataPath = join(shogoDir, 'checkpoint.json');
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Read checkpoint metadata from .shogo/checkpoint.json
 */
export async function readCheckpointMetadata(
  workspacePath: string
): Promise<Record<string, any> | null> {
  const metadataPath = join(workspacePath, SHOGO_DIR, 'checkpoint.json');
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    const content = await readFile(metadataPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
