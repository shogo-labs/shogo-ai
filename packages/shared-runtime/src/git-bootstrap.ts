// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cold-start git bootstrap for agent-runtime pods.
 *
 * In `git_only` / `dual_shadow` mode the durable source of truth for a
 * project's source tree is the git repo persisted to object storage and
 * served by the API's smart-HTTP backend (see
 * `apps/api/src/routes/git-http.ts` + `services/git-repo-store.ts`).
 *
 * On a cold start the pod's `WORKSPACE_DIR` is populated from the S3
 * dependency/source layers but has no `.git`. Before
 * {@link GitWorkspaceSync} can push per-turn deltas it needs a working
 * tree wired to the cloud remote with the durable history reachable.
 * This module reconciles the two:
 *
 *   - Durable repo EXISTS  → `git init`, fetch the remote, `reset --hard`
 *     onto it so history + tracked source match the cloud. Untracked /
 *     gitignored files (e.g. S3-offloaded large assets) are preserved.
 *   - Durable repo EMPTY   → `git init`, commit the current on-disk tree
 *     (respecting `.gitignore`), and push to SEED the durable repo. This
 *     is the migration path for the legacy `s3`-mode projects that have
 *     no git history yet.
 *
 * Mirrors the bearer-via-`-c http.extraHeader` approach used by
 * `git-sync.ts` / the worker's `git-cloner.ts` so the runtime token never
 * lands in argv as a URL secret.
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

const GIT_TIMEOUT_MS = 5 * 60 * 1000

interface SpawnResult {
  exitCode: number
  stdout: string
  stderr: string
}

function spawnGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
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

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
  const r = await spawnGit(args, cwd, env)
  if (r.exitCode !== 0) {
    throw new Error(`git ${args[0]} exited ${r.exitCode}: ${(r.stderr || '').slice(0, 500)}`)
  }
  return r
}

function buildGitUrl(cloudApiUrl: string, projectId: string): string {
  const base = cloudApiUrl.replace(/\/+$/, '')
  return `${base}/api/projects/${projectId}/git`
}

export interface EnsureWorkspaceRepoConfig {
  workspaceDir: string
  cloudApiUrl: string
  runtimeAuthSecret: string
  projectId: string
  branch?: string
  authorName?: string
  authorEmail?: string
  logger?: Logger
}

export interface EnsureWorkspaceRepoResult {
  /** True when `.git` already existed (warm reuse). */
  preexisting: boolean
  /** True when the durable repo was fetched onto the working tree. */
  cloned: boolean
  /** True when we seeded a brand-new durable repo from the on-disk tree. */
  seeded: boolean
  /** Resolved HEAD sha after bootstrap, when known. */
  headSha?: string
}

/**
 * Ensure `<workspaceDir>` is a git working tree wired to the cloud
 * remote, hydrating history from the durable repo or seeding it.
 *
 * Idempotent and safe to call on every cold start. Throws only on
 * unexpected git failures; callers should treat a throw as "fall back to
 * S3-only durability for this session" rather than crashing the pod.
 */
export async function ensureWorkspaceRepo(
  cfg: EnsureWorkspaceRepoConfig,
): Promise<EnsureWorkspaceRepoResult> {
  const {
    workspaceDir,
    cloudApiUrl,
    runtimeAuthSecret,
    projectId,
    branch = 'main',
    authorName = 'Shogo Agent',
    authorEmail = 'agent-runtime@shogo.ai',
    logger = console,
  } = cfg

  if (existsSync(join(workspaceDir, '.git'))) {
    const head = await spawnGit(['rev-parse', 'HEAD'], workspaceDir).catch(() => null)
    return {
      preexisting: true,
      cloned: false,
      seeded: false,
      headSha: head?.exitCode === 0 ? head.stdout.trim() : undefined,
    }
  }

  const url = buildGitUrl(cloudApiUrl, projectId)
  const header = `http.extraHeader=Authorization: Bearer ${runtimeAuthSecret}`
  const identEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }

  // Fresh repo wired to checkpoint-safe defaults (matches the API's
  // git.service.initRepo config so history is byte-stable across sides).
  await git(['init', '-b', branch], workspaceDir)
  await git(['config', 'core.autocrlf', 'false'], workspaceDir)
  await git(['config', 'core.longpaths', 'true'], workspaceDir)
  await git(['config', 'user.name', authorName], workspaceDir)
  await git(['config', 'user.email', authorEmail], workspaceDir)

  // Try to fetch the durable history. An empty/absent remote returns a
  // clean exit with no FETCH_HEAD; a real network error throws.
  let remoteHasHistory = false
  try {
    await git(['-c', header, 'fetch', '--no-tags', url, branch], workspaceDir, identEnv)
    remoteHasHistory = true
  } catch (err: any) {
    // `fetch` of an unborn/empty remote branch fails with "couldn't find
    // remote ref" — that's the seed path, not a hard error. Anything else
    // (auth, network) we still treat as "seed from disk" so the pod can
    // make forward progress; the push below will surface a real failure.
    logger.warn(`[git-bootstrap] fetch ${branch} returned no history: ${err?.message ?? err}`)
  }

  if (remoteHasHistory) {
    // Reset onto the durable tip. `reset --hard` updates tracked files but
    // leaves untracked/gitignored files (S3-offloaded large assets) intact.
    await git(['reset', '--hard', 'FETCH_HEAD'], workspaceDir, identEnv)
    const head = await spawnGit(['rev-parse', 'HEAD'], workspaceDir).catch(() => null)
    logger.log(`[git-bootstrap] hydrated ${projectId} from durable repo @ ${head?.stdout.trim() ?? '?'}`)
    return {
      preexisting: false,
      cloned: true,
      seeded: false,
      headSha: head?.exitCode === 0 ? head.stdout.trim() : undefined,
    }
  }

  // Seed path: commit the current on-disk tree (respecting .gitignore) and
  // push to create the durable repo.
  await git(['add', '-A'], workspaceDir, identEnv)
  const diff = await spawnGit(['diff', '--cached', '--quiet'], workspaceDir, identEnv)
  if (diff.exitCode === 0) {
    // Nothing to commit (empty workspace). Leave the repo initialized; the
    // first agent edit will produce the seeding commit via GitWorkspaceSync.
    logger.log(`[git-bootstrap] ${projectId}: empty workspace, initialized empty repo`)
    return { preexisting: false, cloned: false, seeded: false }
  }
  await git(['commit', '-m', 'chore: seed durable repo from workspace', '--no-verify'], workspaceDir, identEnv)
  try {
    await git(['-c', header, 'push', url, `${branch}:${branch}`], workspaceDir, identEnv)
  } catch (err: any) {
    logger.warn(`[git-bootstrap] seed push failed (will retry via GitWorkspaceSync): ${err?.message ?? err}`)
  }
  const head = await spawnGit(['rev-parse', 'HEAD'], workspaceDir).catch(() => null)
  logger.log(`[git-bootstrap] seeded durable repo for ${projectId} @ ${head?.stdout.trim() ?? '?'}`)
  return {
    preexisting: false,
    cloned: false,
    seeded: true,
    headSha: head?.exitCode === 0 ? head.stdout.trim() : undefined,
  }
}
