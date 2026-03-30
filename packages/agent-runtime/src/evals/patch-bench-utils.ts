// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared utilities for patch-based benchmarks (SWE-bench, FeatureBench).
 *
 * Provides repo caching, workspace preparation, workspace cleanup,
 * and git-diff patch extraction — the identical workflow shared by
 * any benchmark that grades agent output as a unified diff.
 */

import { execSync } from 'child_process'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHOGO_WORKSPACE_FILES = [
  '.mcp.json', 'AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md',
  'MEMORY.md', 'TOOLS.md', 'CLAUDE.md', 'BOOT.md',
]

const SHOGO_WORKSPACE_DIRS = ['.shogo', 'memory']

const GIT_TIMEOUT = 120_000
const GIT_MAX_BUFFER = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Bare-repo cache
// ---------------------------------------------------------------------------

/**
 * Clone a GitHub repo as a bare repo into the cache directory.
 * Returns the path to the bare clone. No-ops if already cached.
 */
export function ensureRepoCache(repo: string, repoCache: string): string {
  const safeName = repo.replace('/', '__')
  const bareDir = resolve(repoCache, safeName)

  if (existsSync(bareDir)) return bareDir

  console.log(`  Cloning ${repo} (bare) into cache...`)
  mkdirSync(repoCache, { recursive: true })
  execSync(`git clone --bare "https://github.com/${repo}.git" "${bareDir}"`, {
    timeout: 600_000,
    stdio: 'inherit',
  })
  return bareDir
}

// ---------------------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------------------

/**
 * Remove a workspace directory, retrying up to 3 times for stale file locks.
 */
export function cleanWorkspaceDir(workDir: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!existsSync(workDir)) return
    try { rmSync(workDir, { recursive: true, force: true }) } catch {}
    if (existsSync(workDir)) {
      try { execSync(`rm -rf "${workDir}"`, { stdio: 'pipe', timeout: 10_000 }) } catch {}
    }
  }
}

export interface PrepWorkspaceOpts {
  workerId: number
  repo: string
  baseCommit: string
  repoCache: string
  workspaceRoot: string
  verbose?: boolean
}

/**
 * Clone from bare cache at the given commit. Returns the new workspace path.
 */
export function prepWorkspace(opts: PrepWorkspaceOpts): string {
  const workDir = resolve(opts.workspaceRoot, `w${opts.workerId}`)
  cleanWorkspaceDir(workDir)

  const bareDir = ensureRepoCache(opts.repo, opts.repoCache)

  if (opts.verbose) {
    console.log(`      [prep] Cloning from cache at ${opts.baseCommit.slice(0, 8)}...`)
  }

  execSync(`git clone "${bareDir}" "${workDir}"`, {
    timeout: 120_000,
    stdio: 'pipe',
  })

  execSync(`git checkout ${opts.baseCommit}`, {
    cwd: workDir,
    timeout: 30_000,
    stdio: 'pipe',
  })

  return workDir
}

// ---------------------------------------------------------------------------
// Workspace cleanup (pre-patch extraction)
// ---------------------------------------------------------------------------

/**
 * Remove Shogo workspace files + optional junk file patterns before
 * extracting a clean diff.
 */
export function cleanupWorkspaceFiles(repoDir: string, junkPatterns?: string[]): void {
  if (junkPatterns && junkPatterns.length > 0) {
    try {
      const globs = junkPatterns.map(p => `'${p}'`).join(' ')
      execSync(`git checkout -- ${globs}`, {
        cwd: repoDir, timeout: 10_000, stdio: 'pipe',
      })
    } catch {}
    try {
      for (const pattern of junkPatterns) {
        execSync(`git clean -f -- ${pattern}`, {
          cwd: repoDir, timeout: 10_000, stdio: 'pipe',
        })
      }
    } catch {}
  }

  for (const file of SHOGO_WORKSPACE_FILES) {
    try { execSync(`git checkout -- "${file}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' }) } catch {}
    try { execSync(`git clean -f -- "${file}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' }) } catch {}
  }
  for (const dir of SHOGO_WORKSPACE_DIRS) {
    try { execSync(`git clean -fd -- "${dir}"`, { cwd: repoDir, timeout: 5_000, stdio: 'pipe' }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Patch extraction
// ---------------------------------------------------------------------------

export interface ExtractPatchOpts {
  junkPatterns?: string[]
  maxRetries?: number
}

/**
 * Extract a unified diff of changes the agent made.
 * Cleans up workspace files first, then tries tracked + untracked diffs.
 */
export function extractPatch(repoDir: string, opts?: ExtractPatchOpts): string {
  const maxRetries = opts?.maxRetries ?? 2

  cleanupWorkspaceFiles(repoDir, opts?.junkPatterns)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tracked = execSync('git diff', {
        cwd: repoDir,
        timeout: GIT_TIMEOUT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: GIT_MAX_BUFFER,
      }).trim()

      if (tracked) return tracked

      try {
        execSync('git add -A', { cwd: repoDir, timeout: GIT_TIMEOUT, stdio: 'pipe' })
        const staged = execSync('git diff --cached', {
          cwd: repoDir, timeout: GIT_TIMEOUT, encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER,
        }).trim()
        execSync('git reset HEAD', { cwd: repoDir, timeout: GIT_TIMEOUT, stdio: 'pipe' })
        return staged
      } catch { return '' }
    } catch (err: any) {
      console.warn(`      [patch] git diff attempt ${attempt}/${maxRetries} failed: ${err.message}`)
      if (attempt < maxRetries) {
        try { execSync('sleep 2', { timeout: 5_000, stdio: 'pipe' }) } catch {}
      }
    }
  }

  console.warn(`      [patch] all ${maxRetries} attempts failed`)
  return ''
}
