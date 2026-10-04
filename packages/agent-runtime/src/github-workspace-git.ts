// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub remote operations on a project's workspace, run inside the runtime
 * that owns the files (the API pod has no copy of the workspace).
 *
 * The token reaches git only through `GIT_CONFIG_*` env (an `extraheader`
 * scoped to https://github.com/), so it is never written into `.git/config`,
 * a remote URL, or argv.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type GitHubWorkspaceOp = 'connect' | 'push' | 'pull'

export interface GitHubWorkspaceOpInput {
  op: GitHubWorkspaceOp
  repoOwner: string
  repoName: string
  /** Remote default branch; `connect` adopts it, `pull` rebases onto it. */
  defaultBranch?: string
  token: string
}

export interface GitHubWorkspaceOpResult {
  ok: boolean
  error?: string
  branch?: string
  sha?: string | null
  /**
   * `connect` outcome: `adopted` (the workspace now matches the remote
   * branch), `kept` (local history already contains the remote branch, or
   * the remote is empty), or `diverged` (both sides have commits the other
   * lacks; nothing was changed).
   */
  connect?: 'adopted' | 'kept' | 'diverged'
  /** Branch holding the workspace's previous commits when `connect` replaced unrelated history. */
  backupBranch?: string
  /** Commits sent (`push`) or received (`pull`). */
  commits?: number
}

/**
 * Shogo runtime state that is never project source. Listed in the clone's
 * `.git/info/exclude` so it stays out of the user's repository without
 * editing their `.gitignore`.
 */
export const SHOGO_RUNTIME_EXCLUDES = [
  '.tech-stack',
  '.shogo/local/',
  '.shogo/logs/',
  '.shogo/install-marker',
  '.shogo/build-output*',
  '.shogo/vite-watch.pid',
  '.shogo/vite.watch.config.ts',
  '.shogo-pool-assignment',
  'node_modules/',
  'dist.staging/',
  'dist.publish.staging/',
]

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/
const GIT_TIMEOUT_MS = 5 * 60 * 1000

export function githubGitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function githubRemoteUrl(repoOwner: string, repoName: string): string {
  return `https://github.com/${repoOwner}/${repoName}.git`
}

interface GitRun {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') })
      },
    )
  })
}

async function gitOk(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env)
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`)
  }
  return r.stdout.trim()
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : null
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0
}

async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
}

async function ensureRepo(cwd: string, defaultBranch: string): Promise<void> {
  if (existsSync(join(cwd, '.git'))) return
  await gitOk(cwd, ['init', '-b', defaultBranch])
}

async function setOrigin(cwd: string, url: string): Promise<void> {
  const remotes = (await git(cwd, ['remote'])).stdout.split('\n').map((r) => r.trim())
  if (remotes.includes('origin')) {
    const existing = await git(cwd, ['config', '--get', 'remote.origin.url'])
    if (existing.stdout.trim() !== url) await gitOk(cwd, ['remote', 'set-url', 'origin', url])
    return
  }
  await gitOk(cwd, ['remote', 'add', 'origin', url])
}

const SAVE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Shogo',
  GIT_AUTHOR_EMAIL: 'agent@shogo.ai',
  GIT_COMMITTER_NAME: 'Shogo',
  GIT_COMMITTER_EMAIL: 'agent@shogo.ai',
}

function ensureRuntimeExcludes(cwd: string): void {
  const infoDir = join(cwd, '.git', 'info')
  const excludePath = join(infoDir, 'exclude')
  mkdirSync(infoDir, { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8').split('\n').map((l) => l.trim()) : []
  const missing = SHOGO_RUNTIME_EXCLUDES.filter((p) => !existing.includes(p))
  if (!missing.length) return
  const lead = existing.length && existing[existing.length - 1] !== '' ? '\n' : ''
  appendFileSync(excludePath, `${lead}# Shogo runtime state\n${missing.join('\n')}\n`)
}

/** Commit uncommitted files; returns true when it made a commit. */
async function commitPendingWork(cwd: string, message: string): Promise<boolean> {
  const status = await gitOk(cwd, ['status', '--porcelain'])
  if (!status) return false
  await gitOk(cwd, ['add', '-A'])
  await gitOk(cwd, ['commit', '--no-verify', '-m', message], SAVE_IDENTITY)
  return true
}

async function countCommits(cwd: string, range: string): Promise<number> {
  const r = await git(cwd, ['rev-list', '--count', range])
  return r.code === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0
}

async function connect(cwd: string, input: GitHubWorkspaceOpInput, env: Record<string, string>): Promise<GitHubWorkspaceOpResult> {
  const remoteBranch = input.defaultBranch || 'main'
  await ensureRepo(cwd, remoteBranch)
  ensureRuntimeExcludes(cwd)
  await setOrigin(cwd, githubRemoteUrl(input.repoOwner, input.repoName))
  await gitOk(cwd, ['fetch', '--prune', 'origin'], env)
  await commitPendingWork(cwd, 'Save workspace before connecting GitHub')

  const remoteRef = `refs/remotes/origin/${remoteBranch}`
  const remoteSha = await revParse(cwd, remoteRef)
  const localSha = await revParse(cwd, 'HEAD')
  const branch = (await currentBranch(cwd)) || remoteBranch

  if (!remoteSha) {
    return { ok: true, connect: 'kept', branch, sha: localSha }
  }
  if (localSha && (await isAncestor(cwd, remoteSha, localSha))) {
    await git(cwd, ['branch', `--set-upstream-to=origin/${remoteBranch}`])
    return { ok: true, connect: 'kept', branch, sha: localSha }
  }
  const unrelated = localSha ? (await git(cwd, ['merge-base', localSha, remoteSha])).code !== 0 : true
  const fastForward = localSha ? await isAncestor(cwd, localSha, remoteSha) : true
  if (!unrelated && !fastForward) {
    return {
      ok: true,
      connect: 'diverged',
      branch,
      sha: localSha,
      error: `Local ${branch} and origin/${remoteBranch} have both moved; pull or push to reconcile.`,
    }
  }

  // The remote is authoritative. Keep unrelated local history (usually a
  // template scaffold) reachable on a backup branch instead of dropping it.
  let backupBranch: string | undefined
  if (localSha && unrelated) {
    backupBranch = `shogo/pre-connect-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`
    await gitOk(cwd, ['branch', '-f', backupBranch, localSha])
  }
  await gitOk(cwd, ['checkout', '-f', '-B', remoteBranch, remoteRef])
  await git(cwd, ['branch', `--set-upstream-to=origin/${remoteBranch}`])
  return { ok: true, connect: 'adopted', branch: remoteBranch, sha: remoteSha, backupBranch }
}

/** Commit the workspace's pending edits, then push its branch. */
async function push(cwd: string, env: Record<string, string>): Promise<GitHubWorkspaceOpResult> {
  const branch = await currentBranch(cwd)
  if (!branch) return { ok: false, error: 'HEAD is detached; check out a branch before pushing.' }
  ensureRuntimeExcludes(cwd)
  await commitPendingWork(cwd, 'Update from Shogo')
  await gitOk(cwd, ['fetch', 'origin'], env)
  const remoteRef = `refs/remotes/origin/${branch}`
  const commits = await countCommits(cwd, (await revParse(cwd, remoteRef)) ? `${remoteRef}..HEAD` : 'HEAD')
  await gitOk(cwd, ['push', '-u', 'origin', branch], env)
  return { ok: true, branch, sha: await revParse(cwd, 'HEAD'), commits }
}

async function pull(cwd: string, input: GitHubWorkspaceOpInput, env: Record<string, string>): Promise<GitHubWorkspaceOpResult> {
  const branch = input.defaultBranch || (await currentBranch(cwd)) || 'main'
  ensureRuntimeExcludes(cwd)
  const before = await revParse(cwd, 'HEAD')
  await gitOk(cwd, ['pull', '--rebase', '--autostash', 'origin', branch], env)
  const remoteRef = `refs/remotes/origin/${branch}`
  const commits = before && (await revParse(cwd, remoteRef)) ? await countCommits(cwd, `${before}..${remoteRef}`) : 0
  return { ok: true, branch: (await currentBranch(cwd)) || branch, sha: await revParse(cwd, 'HEAD'), commits }
}

export function validateGitHubWorkspaceOpInput(input: Partial<GitHubWorkspaceOpInput>): string | null {
  if (input.op !== 'connect' && input.op !== 'push' && input.op !== 'pull') return 'op must be connect, push, or pull'
  if (!input.repoOwner || !OWNER_RE.test(input.repoOwner)) return 'invalid repoOwner'
  if (!input.repoName || !REPO_RE.test(input.repoName) || input.repoName.startsWith('.')) return 'invalid repoName'
  if (input.defaultBranch && !BRANCH_RE.test(input.defaultBranch)) return 'invalid defaultBranch'
  if (!input.token || typeof input.token !== 'string') return 'token is required'
  return null
}

/** Run one GitHub remote operation in `cwd`. Never throws. */
export async function runGitHubWorkspaceOp(
  cwd: string,
  input: GitHubWorkspaceOpInput,
): Promise<GitHubWorkspaceOpResult> {
  const invalid = validateGitHubWorkspaceOpInput(input)
  if (invalid) return { ok: false, error: invalid }
  if (!existsSync(cwd)) return { ok: false, error: `Workspace directory ${cwd} does not exist` }
  const env = githubGitAuthEnv(input.token)
  try {
    if (input.op === 'connect') return await connect(cwd, input, env)
    if (input.op === 'push') return await push(cwd, env)
    return await pull(cwd, input, env)
  } catch (err: any) {
    return { ok: false, error: redactToken(err?.message ?? String(err), input.token) }
  }
}

/**
 * Stop the merged-root workspace repo from tracking a member folder that now
 * has its own repository: ignore it via `.git/info/exclude` and drop it from
 * the root index (files stay on disk). The member's history lives in its own
 * `.git` from here on.
 */
export async function detachMemberFromRootRepo(rootDir: string, memberDir: string): Promise<void> {
  if (!existsSync(join(rootDir, '.git')) || !existsSync(join(memberDir, '.git'))) return
  const rel = memberDir.startsWith(`${rootDir}/`) ? memberDir.slice(rootDir.length + 1) : null
  if (!rel || rel.includes('..')) return
  const infoDir = join(rootDir, '.git', 'info')
  const excludePath = join(infoDir, 'exclude')
  const entry = `/${rel}/`
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (!existing.split('\n').includes(entry)) {
    mkdirSync(infoDir, { recursive: true })
    appendFileSync(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`)
  }
  await git(rootDir, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', rel])
}

function redactToken(message: string, token: string): string {
  return token ? message.split(token).join('***') : message
}
