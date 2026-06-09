// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-chat git worktree management for agent-runtime.
 *
 * When the project-level `gitWorktreesEnabled` beta flag is on, every chat
 * session operates on its own branch (`shogo/chat/<chatSessionId>`) checked
 * out in a sibling worktree that shares the project's single `.git` object
 * store. `main` (the default branch) stays checked out in the canonical
 * workspace directory and only changes via merges.
 *
 * Design notes
 * ------------
 * - Worktrees are *derived* state. Only branches are durable (they live as
 *   refs in the shared `.git`, which `git_only` mode already persists to
 *   object storage). On a cold start the runtime recreates the working
 *   directories for any chat whose status is still `active` by replaying
 *   `git worktree add` against the existing branch.
 * - Worktree directories live OUTSIDE the main working tree (a sibling
 *   `.shogo-worktrees/<chatSessionId>` dir) so they never appear in the
 *   main repo's `git status` and are never committed.
 * - All git access shells out to the host `git` binary (no simple-git /
 *   nodegit), mirroring `git-sync.ts` and the API `git.service.ts`. The
 *   same code path serves cloud pods and local `shogo-worker` runtimes, so
 *   worktrees behave identically in both environments.
 *
 * License boundary: lives in `shared-runtime` (AGPL) alongside the other
 * git plumbing (`git-sync.ts`, `git-bootstrap.ts`).
 */

import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'

/** Hard timeout for any single `git` invocation (ms). */
const GIT_TIMEOUT_MS = 60_000

/** Branch prefix for per-chat worktree branches. */
export const WORKTREE_BRANCH_PREFIX = 'shogo/chat/'

/** Directory name (sibling of the workspace) that holds linked worktrees. */
export const WORKTREE_DIR_NAME = '.shogo-worktrees'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

export interface SpawnGitResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type SpawnGitFn = (
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<SpawnGitResult>

export interface WorktreeInfo {
  chatSessionId: string
  branch: string
  path: string
  /** Whether the working directory currently exists on disk. */
  exists: boolean
}

export interface WorktreeStatus {
  chatSessionId: string
  branch: string
  path: string
  /** Number of files differing from the working tree HEAD (uncommitted). */
  dirtyFiles: number
  /** Commits the branch is ahead of the default branch. */
  ahead: number
  /** Commits the branch is behind the default branch. */
  behind: number
  /** Up to a handful of changed paths (committed vs default branch), for UI. */
  changedFiles: string[]
}

export type MergeOutcome = 'clean' | 'conflict' | 'noop'

export interface MergeResult {
  outcome: MergeOutcome
  /** Files with unresolved conflicts (when outcome === 'conflict'). */
  conflictedFiles: string[]
  /** New HEAD sha of the default branch after a successful merge. */
  mergedSha?: string
  message?: string
}

export interface WorktreeManagerConfig {
  /** Absolute path to the canonical workspace (the main git working tree). */
  mainRepoDir: string
  /** Root directory under which worktrees are created. Defaults to a sibling `.shogo-worktrees`. */
  worktreeRoot?: string
  /** Author identity for merge commits. */
  authorName?: string
  authorEmail?: string
  logger?: Logger
  /** Test seam — overrides the in-process git spawner. */
  spawnGit?: SpawnGitFn
}

const defaultSpawnGit: SpawnGitFn = (args, cwd, env) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    const err: string[] = []
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (c: string) => out.push(c))
    child.stderr.on('data', (c: string) => err.push(c))
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`))
    }, GIT_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout: out.join(''), stderr: err.join('') })
    })
  })
}

/** Validate a chat session id is safe to embed in a branch name / path. */
function assertSafeSessionId(chatSessionId: string): void {
  if (!chatSessionId || !/^[A-Za-z0-9._-]+$/.test(chatSessionId)) {
    throw new Error(`Unsafe chatSessionId for worktree: ${JSON.stringify(chatSessionId)}`)
  }
}

export class WorktreeManager {
  private readonly mainRepoDir: string
  private readonly worktreeRoot: string
  private readonly authorName: string
  private readonly authorEmail: string
  private readonly logger: Logger
  private readonly spawnGit: SpawnGitFn
  private _defaultBranch: string | null = null

  constructor(config: WorktreeManagerConfig) {
    this.mainRepoDir = config.mainRepoDir
    this.worktreeRoot = config.worktreeRoot ?? join(dirname(config.mainRepoDir), WORKTREE_DIR_NAME)
    this.authorName = config.authorName ?? 'Shogo Agent'
    this.authorEmail = config.authorEmail ?? 'agent-runtime@shogo.ai'
    this.logger = config.logger ?? console
    this.spawnGit = config.spawnGit ?? defaultSpawnGit
  }

  /** Branch name for a chat session. */
  branchFor(chatSessionId: string): string {
    assertSafeSessionId(chatSessionId)
    return `${WORKTREE_BRANCH_PREFIX}${chatSessionId}`
  }

  /** Working-directory path for a chat session's worktree. */
  pathFor(chatSessionId: string): string {
    assertSafeSessionId(chatSessionId)
    return join(this.worktreeRoot, chatSessionId)
  }

  private commitEnv(): NodeJS.ProcessEnv {
    return {
      GIT_AUTHOR_NAME: this.authorName,
      GIT_AUTHOR_EMAIL: this.authorEmail,
      GIT_COMMITTER_NAME: this.authorName,
      GIT_COMMITTER_EMAIL: this.authorEmail,
    }
  }

  private async git(args: string[], cwd: string = this.mainRepoDir): Promise<SpawnGitResult> {
    return this.spawnGit(args, cwd, this.commitEnv())
  }

  private async gitOk(args: string[], cwd: string = this.mainRepoDir): Promise<string> {
    const r = await this.git(args, cwd)
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${r.exitCode}: ${(r.stderr || '').slice(0, 500)}`)
    }
    return r.stdout
  }

  /** Resolve the repository's default branch (cached). */
  async getDefaultBranch(): Promise<string> {
    if (this._defaultBranch) return this._defaultBranch
    // Prefer the symbolic ref of origin/HEAD if a remote exists.
    const sym = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (sym.exitCode === 0) {
      const name = sym.stdout.trim().replace(/^origin\//, '')
      if (name) { this._defaultBranch = name; return name }
    }
    // Fall back to the currently checked-out branch in the main repo.
    const head = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = head.stdout.trim()
    if (branch && branch !== 'HEAD') {
      this._defaultBranch = branch
      return branch
    }
    // Last resort: common defaults.
    for (const candidate of ['main', 'master']) {
      const r = await this.git(['rev-parse', '--verify', '--quiet', candidate])
      if (r.exitCode === 0) { this._defaultBranch = candidate; return candidate }
    }
    this._defaultBranch = 'main'
    return 'main'
  }

  /**
   * Ensure a worktree + branch exist for the given chat session. Idempotent:
   * recreates the working directory if it was pruned (cold start) but the
   * branch still exists.
   */
  async ensureWorktree(chatSessionId: string): Promise<WorktreeInfo> {
    const branch = this.branchFor(chatSessionId)
    const path = this.pathFor(chatSessionId)

    // Already registered and present on disk?
    const existing = (await this.listWorktrees()).find(w => w.chatSessionId === chatSessionId)
    if (existing?.exists) return existing

    mkdirSync(this.worktreeRoot, { recursive: true })

    const defaultBranch = await this.getDefaultBranch()
    const branchExists = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0

    // Prune any stale worktree metadata pointing at a missing directory.
    await this.git(['worktree', 'prune'])

    if (branchExists) {
      // Branch survived a cold start — just re-attach the working directory.
      await this.gitOk(['worktree', 'add', path, branch])
    } else {
      // New chat — branch off the default branch.
      await this.gitOk(['worktree', 'add', '-b', branch, path, defaultBranch])
    }

    this.logger.log(`[WorktreeManager] worktree ready: ${branch} -> ${path}`)
    return { chatSessionId, branch, path, exists: true }
  }

  /**
   * List managed branches (`shogo/chat/*`) that still exist in the shared
   * `.git`. After a cold start the working directories are gone but the
   * branches survive in the persisted object store, so this is the source of
   * truth for which worktrees to recreate.
   */
  async listManagedBranches(): Promise<string[]> {
    const r = await this.git([
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/${WORKTREE_BRANCH_PREFIX}*`,
    ])
    if (r.exitCode !== 0) return []
    return r.stdout
      .split('\n')
      .map(l => l.trim())
      .filter(b => b.startsWith(WORKTREE_BRANCH_PREFIX))
  }

  /**
   * Recreate the working directories for every managed branch. Called on
   * runtime cold start so in-flight chats keep their isolated trees. Merged
   * chats whose branch was deleted are naturally skipped.
   */
  async recreateWorktrees(): Promise<WorktreeInfo[]> {
    const branches = await this.listManagedBranches()
    const out: WorktreeInfo[] = []
    for (const branch of branches) {
      const chatSessionId = branch.slice(WORKTREE_BRANCH_PREFIX.length)
      try {
        out.push(await this.ensureWorktree(chatSessionId))
      } catch (err) {
        this.logger.warn(`[WorktreeManager] failed to recreate worktree for ${branch}: ${String(err)}`)
      }
    }
    return out
  }

  /** List all Shogo-managed worktrees known to git. */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const r = await this.git(['worktree', 'list', '--porcelain'])
    if (r.exitCode !== 0) return []
    const blocks = r.stdout.split('\n\n').filter(Boolean)
    const result: WorktreeInfo[] = []
    for (const block of blocks) {
      const lines = block.split('\n')
      let wtPath = ''
      let branch = ''
      for (const line of lines) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim()
      }
      const shortBranch = branch.replace(/^refs\/heads\//, '')
      if (!shortBranch.startsWith(WORKTREE_BRANCH_PREFIX)) continue
      const chatSessionId = shortBranch.slice(WORKTREE_BRANCH_PREFIX.length)
      const { existsSync } = await import('fs')
      result.push({ chatSessionId, branch: shortBranch, path: wtPath, exists: existsSync(wtPath) })
    }
    return result
  }

  /** Remove a chat's worktree (and optionally delete its branch). */
  async removeWorktree(chatSessionId: string, opts?: { deleteBranch?: boolean }): Promise<void> {
    const branch = this.branchFor(chatSessionId)
    const path = this.pathFor(chatSessionId)
    await this.git(['worktree', 'remove', '--force', path])
    await this.git(['worktree', 'prune'])
    if (opts?.deleteBranch) {
      await this.git(['branch', '-D', branch])
    }
  }

  /** Compute branch status relative to the default branch. */
  async status(chatSessionId: string): Promise<WorktreeStatus | null> {
    const info = (await this.listWorktrees()).find(w => w.chatSessionId === chatSessionId)
    if (!info) return null
    const defaultBranch = await this.getDefaultBranch()

    // Uncommitted changes in the worktree.
    let dirtyFiles = 0
    if (info.exists) {
      const porcelain = await this.git(['status', '--porcelain'], info.path)
      dirtyFiles = porcelain.stdout.split('\n').filter(l => l.trim().length > 0).length
    }

    // Ahead/behind the default branch.
    let ahead = 0
    let behind = 0
    const counts = await this.git(['rev-list', '--left-right', '--count', `${defaultBranch}...${info.branch}`])
    if (counts.exitCode === 0) {
      const [b, a] = counts.stdout.trim().split(/\s+/).map(n => parseInt(n, 10) || 0)
      behind = b ?? 0
      ahead = a ?? 0
    }

    // Changed files (committed) vs default branch — capped for UI.
    const diff = await this.git(['diff', '--name-only', `${defaultBranch}...${info.branch}`])
    const changedFiles = diff.exitCode === 0
      ? diff.stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 50)
      : []

    return {
      chatSessionId,
      branch: info.branch,
      path: info.path,
      dirtyFiles,
      ahead,
      behind,
      changedFiles,
    }
  }

  /**
   * Commit any uncommitted work in the worktree so a merge sees a clean tree.
   * No-op when nothing is staged/changed.
   */
  async commitWorktree(chatSessionId: string, message: string): Promise<void> {
    const path = this.pathFor(chatSessionId)
    await this.git(['add', '-A'], path)
    const diff = await this.git(['diff', '--cached', '--quiet'], path)
    if (diff.exitCode === 0) return // nothing to commit
    await this.gitOk(['commit', '-m', message, '--no-verify'], path)
  }

  /**
   * Merge the default branch INTO the chat branch (run inside the worktree)
   * so any conflict surfaces in the chat's own working directory, where the
   * agent can resolve it. Caller advances main via {@link fastForwardMain}
   * once the branch is clean.
   */
  async mergeDefaultIntoBranch(chatSessionId: string): Promise<MergeResult> {
    const info = await this.ensureWorktree(chatSessionId)
    const defaultBranch = await this.getDefaultBranch()

    // Already up to date with default branch?
    const behind = await this.git(['rev-list', '--count', `${info.branch}..${defaultBranch}`], info.path)
    if (behind.exitCode === 0 && behind.stdout.trim() === '0') {
      return { outcome: 'noop', conflictedFiles: [] }
    }

    const merge = await this.git(
      ['merge', '--no-edit', defaultBranch],
      info.path,
    )
    if (merge.exitCode === 0) {
      return { outcome: 'clean', conflictedFiles: [] }
    }

    // Detect conflicts vs a genuine failure.
    const conflicted = await this.conflictedFiles(info.path)
    if (conflicted.length > 0) {
      return {
        outcome: 'conflict',
        conflictedFiles: conflicted,
        message: (merge.stderr || merge.stdout).slice(0, 500),
      }
    }
    throw new Error(`git merge failed: ${(merge.stderr || merge.stdout).slice(0, 500)}`)
  }

  /** Whether a merge is in progress in the session's worktree (MERGE_HEAD set). */
  async isMergeInProgress(chatSessionId: string): Promise<boolean> {
    const path = this.pathFor(chatSessionId)
    const { existsSync } = await import('fs')
    if (!existsSync(path)) return false
    const r = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], path)
    return r.exitCode === 0
  }

  /**
   * Files git still considers unmerged (index has conflict stages). Note: a
   * file is "unmerged" until it is `git add`-ed, even if the working-tree copy
   * no longer contains conflict markers — so this is a pre-staging view. Use
   * {@link unresolvedConflictFiles} to tell whether real markers remain.
   */
  async conflictedFiles(cwd: string): Promise<string[]> {
    const r = await this.git(['diff', '--name-only', '--diff-filter=U'], cwd)
    if (r.exitCode !== 0) return []
    return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  }

  /**
   * Of the unmerged files, the ones whose working-tree copy still contains
   * conflict markers (genuinely unresolved). The agent resolves conflicts by
   * editing files (removing markers) but does not stage them; we stage on its
   * behalf, so "still unmerged in the index" is NOT the same as "unresolved".
   */
  async unresolvedConflictFiles(cwd: string): Promise<string[]> {
    const unmerged = await this.conflictedFiles(cwd)
    if (unmerged.length === 0) return []
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const unresolved: string[] = []
    for (const rel of unmerged) {
      const abs = join(cwd, rel)
      if (!existsSync(abs)) { unresolved.push(rel); continue }
      let content = ''
      try { content = readFileSync(abs, 'utf-8') } catch { unresolved.push(rel); continue }
      if (/^<{7}\s|^={7}$|^>{7}\s/m.test(content)) unresolved.push(rel)
    }
    return unresolved
  }

  /**
   * Fast-forward the default branch (checked out in the main repo) to the tip
   * of the chat branch. Safe to call only after {@link mergeDefaultIntoBranch}
   * reported `clean`/`noop` and the worktree has no remaining conflicts.
   */
  async fastForwardMain(chatSessionId: string): Promise<string> {
    const branch = this.branchFor(chatSessionId)
    // The main repo dir stays checked out on the default branch, so advancing
    // it to the chat branch tip after a clean merge is a fast-forward.
    await this.gitOk(['merge', '--ff-only', branch], this.mainRepoDir)
    const head = await this.gitOk(['rev-parse', 'HEAD'], this.mainRepoDir)
    return head.trim()
  }

  /**
   * Full merge orchestration for the clean / no-conflict path:
   *   1. commit any pending work in the worktree
   *   2. merge default branch into the chat branch
   *   3. if clean/noop, fast-forward main to the branch tip
   *
   * Returns `conflict` (with files) without advancing main when the agent
   * still needs to resolve conflicts in the worktree.
   */
  async mergeBranchIntoMain(chatSessionId: string): Promise<MergeResult> {
    await this.commitWorktree(chatSessionId, `chat ${chatSessionId}: snapshot before merge`)
    const merged = await this.mergeDefaultIntoBranch(chatSessionId)
    if (merged.outcome === 'conflict') return merged
    const sha = await this.fastForwardMain(chatSessionId)
    return { outcome: merged.outcome === 'noop' ? 'clean' : merged.outcome, conflictedFiles: [], mergedSha: sha }
  }

  /**
   * Complete a merge after the agent has resolved conflicts in the worktree:
   * verifies no conflicts remain, commits the resolution, and fast-forwards
   * main. Throws if conflicts are still present.
   */
  async completeConflictedMerge(chatSessionId: string): Promise<MergeResult> {
    const path = this.pathFor(chatSessionId)
    // Genuinely-unresolved = unmerged files that still carry conflict markers.
    // (Resolved files are edited but not staged, so they read as unmerged in the
    // index until we stage them below — don't treat those as conflicts.)
    const remaining = await this.unresolvedConflictFiles(path)
    if (remaining.length > 0) {
      return { outcome: 'conflict', conflictedFiles: remaining }
    }
    // Stage the agent's resolution and commit the in-progress merge.
    const mergeHead = await this.git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], path)
    if (mergeHead.exitCode === 0) {
      await this.gitOk(['add', '-A'], path)
      await this.gitOk(['commit', '--no-edit', '--no-verify'], path)
    }
    const sha = await this.fastForwardMain(chatSessionId)
    return { outcome: 'clean', conflictedFiles: [], mergedSha: sha }
  }
}
