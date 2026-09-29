// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pod-side durable git repo store (object storage backed).
 *
 * In the pod-owned `git_only` model the agent-runtime pod is the
 * authoritative home of the project's git repo (working tree + `.git` in
 * `WORKSPACE_DIR`). Durability is the pod's responsibility: it persists
 * its own `.git` to object storage (the same `S3_WORKSPACES_BUCKET` used
 * for the dependency/source layers) under
 *
 *   `<projectId>/repo.git.tar.gz`
 *
 * and restores it on cold start. This is the git-history analogue of the
 * S3 source tarball — but it carries the full commit DAG, not just the
 * latest tree.
 *
 * No Redis lock is needed (unlike the API-side store): a project is
 * pinned to a single runtime pod at a time, so there's exactly one
 * writer. Only `.git` is stored (source-only — large/binary assets are
 * S3-offloaded separately via `large-file-sync.ts`), so the tarball
 * stays small.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, createReadStream, createWriteStream, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import {
  getShogoAgentEmail,
  getShogoAgentName,
  withShogoCommitTrailer,
} from './agent-attribution'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

export interface RepoStoreConfig {
  projectId: string
  bucket: string
  region?: string
  endpoint?: string
  logger?: Logger
}

function makeClient(cfg: RepoStoreConfig): S3Client {
  return new S3Client({
    region: cfg.region || process.env.S3_REGION || 'us-east-1',
    ...(cfg.endpoint && { endpoint: cfg.endpoint, forcePathStyle: true }),
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        }
      : undefined,
  })
}

function repoKey(projectId: string): string {
  return `${projectId}/repo.git.tar.gz`
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`)),
    )
  })
}

/**
 * Baseline ignore rules written when a workspace reaches the git layer without
 * any `.gitignore`. Desktop projects seeded by builds up to 1.14.x lost the
 * template's ignore file to a `src.includes('.git')` copy filter, so their
 * first `git add -A` committed `node_modules` (36k+ files) and every later
 * commit / restore / LFS pass walked that tree. Keep this list to the
 * directories that are never source: dependency installs and build output.
 */
export const DEFAULT_WORKSPACE_GITIGNORE = [
  '# dependencies and build output are never source',
  'node_modules',
  'dist',
  'dist-ssr',
  'dist.staging',
  '.shogo/local',
  '.shogo-pool-assignment',
  '*.log',
  '.env',
  '.env.local',
  '.env.*.local',
  '.DS_Store',
  '',
].join('\n')

/** Write {@link DEFAULT_WORKSPACE_GITIGNORE} when the workspace has no `.gitignore`. Returns true when written. */
export function ensureWorkspaceGitignore(workspaceDir: string): boolean {
  const target = join(workspaceDir, '.gitignore')
  if (existsSync(target)) return false
  try {
    writeFileSync(target, DEFAULT_WORKSPACE_GITIGNORE)
    return true
  } catch {
    return false
  }
}

const UNTRACK_DIRS = ['node_modules', 'dist', 'dist.staging']

/**
 * Repair a repo that already tracks dependency / build directories: drop them
 * from the index (files stay on disk), make sure they are ignored, and commit.
 * Cheap when nothing is tracked (one `git ls-files`), so callers can run it on
 * every bootstrap. Returns the list of directories that were untracked.
 */
export async function untrackDependencyDirs(
  workspaceDir: string,
  opts: { authorName?: string; authorEmail?: string; logger?: Logger } = {},
): Promise<string[]> {
  const logger = opts.logger ?? console
  if (!existsSync(join(workspaceDir, '.git'))) return []
  const authorName = opts.authorName ?? getShogoAgentName()
  const authorEmail = opts.authorEmail ?? getShogoAgentEmail()
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }
  const git = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = spawn('git', withShogoCommitTrailer(args, env), { cwd: workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout?.on('data', (c) => { stdout += String(c) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
    })

  try {
    const tracked: string[] = []
    for (const dir of UNTRACK_DIRS) {
      // `-z` + a single path spec: one entry is enough to know the dir is tracked.
      const res = await git(['ls-files', '-z', '--', dir])
      if (res.code === 0 && res.stdout.length > 0) tracked.push(dir)
    }
    if (tracked.length === 0) return []

    const started = Date.now()
    ensureWorkspaceGitignore(workspaceDir)
    for (const dir of tracked) {
      await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', dir])
    }
    await git(['add', '--', '.gitignore'])
    const staged = await git(['diff', '--cached', '--quiet'])
    if (staged.code !== 0) {
      await git(['commit', '-q', '-m', `chore: stop tracking ${tracked.join(', ')}`, '--no-verify'])
    }
    logger.log(`[repo-store] untracked ${tracked.join(', ')} in ${Date.now() - started}ms`)
    return tracked
  } catch (err: any) {
    logger.warn(`[repo-store] untrack dependency dirs failed: ${err?.message ?? err}`)
    return []
  }
}

/**
 * Initialize a fresh git repo in `<workspaceDir>` and commit the current
 * on-disk tree (respecting `.gitignore`). No remote, no push — durability
 * is the caller's job via {@link persistRepoToStore}. No-op when `.git`
 * already exists. This is the seed path for brand-new projects and the
 * migration path for legacy `s3`-mode projects that have no git history.
 *
 * Returns the seeded HEAD sha, or null when `.git` already existed or the
 * workspace was empty (nothing to commit — the repo is left initialized so
 * the first agent edit produces the seeding commit).
 *
 * Throws when any git step fails, after removing the `.git` it created: a
 * half-initialized repo would otherwise be exported as the project's durable
 * history (an empty repo) and block every later seed attempt.
 */
export async function seedRepoIfAbsent(
  workspaceDir: string,
  opts: { branch?: string; authorName?: string; authorEmail?: string; logger?: Logger } = {},
): Promise<string | null> {
  const logger = opts.logger ?? console
  if (existsSync(join(workspaceDir, '.git'))) return null
  const branch = opts.branch ?? 'main'
  const authorName = opts.authorName ?? getShogoAgentName()
  const authorEmail = opts.authorEmail ?? getShogoAgentEmail()
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })

  const env = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }
  const runEnv = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('git', withShogoCommitTrailer(args, env), { cwd: workspaceDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (c) => { stdout += String(c) })
      child.stderr?.on('data', (c) => { stderr += String(c) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })

  const must = async (args: string[]) => {
    const res = await runEnv(args)
    if (res.code !== 0) {
      throw new Error(`git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(0, 500)}`)
    }
    return res
  }

  try {
    // Never let the seed commit sweep up node_modules / build output. Only
    // when such a directory exists, so an empty workspace stays empty.
    if (UNTRACK_DIRS.some((d) => existsSync(join(workspaceDir, d))) && ensureWorkspaceGitignore(workspaceDir)) {
      logger.log('[repo-store] seed: wrote default .gitignore (workspace had none)')
    }
    await must(['init', '-b', branch])
    await must(['config', 'core.autocrlf', 'false'])
    await must(['config', 'core.longpaths', 'true'])
    await must(['config', 'user.name', authorName])
    await must(['config', 'user.email', authorEmail])
    await must(['add', '-A'])
    // `diff --quiet` exits 1 when there are staged changes; anything else is an error.
    const staged = await runEnv(['diff', '--cached', '--quiet'])
    if (staged.code === 0) {
      logger.log('[repo-store] seed: empty workspace, initialized empty repo')
      return null
    }
    if (staged.code !== 1) {
      throw new Error(`git diff exited ${staged.code}: ${staged.stderr.trim().slice(0, 500)}`)
    }
    await must(['commit', '-m', 'chore: seed repo from workspace', '--no-verify'])
    const head = await must(['rev-parse', 'HEAD'])
    const sha = head.stdout.trim()
    logger.log(`[repo-store] seeded local repo @ ${sha}`)
    return sha
  } catch (err: any) {
    logger.error(`[repo-store] seed failed: ${err?.message ?? err}`)
    rmSync(join(workspaceDir, '.git'), { recursive: true, force: true })
    throw err
  }
}

export interface AdoptRepoResult {
  /** HEAD after adoption, or null when the durable repo has no commits yet. */
  headSha: string | null
  /** Whether the working tree was reset to HEAD. */
  reset: boolean
  /** Ref holding tracked working-tree changes that the reset discarded, if any. */
  preservedRef: string | null
  /** Top-level paths whose hydrated tree was kept instead of reset to HEAD. */
  keptPaths?: string[]
}

/**
 * Validate the host's `keepPaths`: `'.'` (the whole tree) or top-level entry
 * names. Anything else (nested paths, `..`, absolute paths) is refused, since a
 * bad path here decides which of the user's files survive the reset.
 */
export function normalizeKeepPaths(paths: unknown): string[] {
  if (paths === undefined || paths === null) return []
  if (!Array.isArray(paths)) throw new Error('keepPaths must be an array')
  const out = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string') throw new Error('keepPaths entries must be strings')
    const name = p.replace(/\/+$/, '')
    if (name === '.') {
      out.add('.')
      continue
    }
    if (!name || name === '..' || name.includes('/') || name.includes('\\') || name === '.git') {
      throw new Error(`invalid keepPaths entry: ${JSON.stringify(p)}`)
    }
    out.add(name)
  }
  return [...out]
}

/**
 * Replace `<workspaceDir>/.git` with the durable `.git` the host extracted to
 * `<stagingDir>/.git`, then rebuild the working tree from its HEAD.
 *
 * A swap (not an overlay) because a fresh guest may already hold a throwaway
 * `.git` seeded from the template before the host's hydrate arrived; overlaying
 * an older or empty durable repo onto it would leave the template commit as
 * HEAD, and resetting to that would wipe the real source.
 *
 * The reset is what makes `.git` authoritative: the source archive can lag the
 * repo (the host exports `.git` every couple of minutes but source only on
 * suspend), and without it the next auto-commit would record the older tree as
 * a revert. Tracked changes the reset would discard are first saved under
 * `refs/shogo/pre-hydrate/<ts>` so nothing is lost if the source was newer.
 * Untracked and ignored files (databases, uploads) are left alone. An unborn
 * HEAD (durable repo with no commits) skips the reset; the next sync commits
 * the hydrated tree as the first commit.
 *
 * The repo is not always the newer side. When its exports are refused (an
 * untrusted VM, a lineage conflict) the source backup keeps advancing while
 * the repo stands still, and resetting to that HEAD rewinds the user's work
 * to wherever the repo stopped. `keepPaths` names the top-level paths the host
 * knows are newer in the hydrated source (`'.'` for the whole tree): those
 * keep their hydrated contents, committed on top of the durable HEAD.
 */
export async function adoptHydratedRepo(
  workspaceDir: string,
  stagingDir: string,
  opts: { logger?: Logger; keepPaths?: string[] } = {},
): Promise<AdoptRepoResult> {
  const logger = opts.logger ?? console
  const keep = normalizeKeepPaths(opts.keepPaths)
  const staged = join(stagingDir, '.git')
  if (!existsSync(staged)) throw new Error(`no staged .git at ${staged}`)
  const target = join(workspaceDir, '.git')
  rmSync(target, { recursive: true, force: true })
  renameSync(staged, target)
  rmSync(stagingDir, { recursive: true, force: true })

  const headSha = await getHeadSha(workspaceDir)
  if (!headSha) {
    logger.log('[repo-store] adopted durable repo with an unborn HEAD — working tree left as hydrated')
    return { headSha: null, reset: false, preservedRef: null }
  }

  const authorName = getShogoAgentName()
  const authorEmail = getShogoAgentEmail()
  const identity = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }
  const git = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('git', withShogoCommitTrailer(args, identity), {
        cwd: workspaceDir,
        env: { ...process.env, ...identity },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (c) => { stdout += String(c) })
      child.stderr?.on('data', (c) => { stderr += String(c) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })

  let preservedRef: string | null = null
  const stash = await git(['stash', 'create', 'pre-hydrate working tree'])
  const stashSha = stash.code === 0 ? stash.stdout.trim() : ''
  if (stashSha) {
    const ref = `refs/shogo/pre-hydrate/${Date.now()}`
    const saved = await git(['update-ref', ref, stashSha])
    if (saved.code !== 0) {
      throw new Error(`could not preserve working tree before reset: ${saved.stderr.trim().slice(0, 300)}`)
    }
    preservedRef = ref
  }

  if (keep.length === 0) {
    const reset = await git(['reset', '--hard', 'HEAD'])
    if (reset.code !== 0) {
      throw new Error(`git reset --hard exited ${reset.code}: ${reset.stderr.trim().slice(0, 300)}`)
    }
    logger.log(
      `[repo-store] adopted durable repo @ ${headSha}` +
        (preservedRef ? ` (differing working tree saved at ${preservedRef})` : ''),
    )
    return { headSha, reset: true, preservedRef }
  }

  // Point the index at HEAD without touching the working tree, then restore
  // only the paths the repo is authoritative for.
  const mixed = await git(['reset', '-q', 'HEAD'])
  if (mixed.code !== 0) {
    throw new Error(`git reset exited ${mixed.code}: ${mixed.stderr.trim().slice(0, 300)}`)
  }
  let restored: string[] = []
  if (!keep.includes('.')) {
    const ls = await git(['ls-tree', '-z', '--name-only', 'HEAD'])
    if (ls.code !== 0) {
      throw new Error(`git ls-tree exited ${ls.code}: ${ls.stderr.trim().slice(0, 300)}`)
    }
    restored = ls.stdout.split('\0').filter((name) => name && !keep.includes(name))
    if (restored.length) {
      const co = await git(['checkout', 'HEAD', '--', ...restored])
      if (co.code !== 0) {
        throw new Error(`git checkout HEAD exited ${co.code}: ${co.stderr.trim().slice(0, 300)}`)
      }
    }
  }
  // Commit what was kept before returning. Left uncommitted, every repo export
  // would carry the stale HEAD under a fresh timestamp, and the next cold boot
  // would take that repo for the newer side and reset the tree to it.
  const addPaths = keep.includes('.') ? ['.'] : keep.filter((p) => existsSync(join(workspaceDir, p)))
  let committedSha = headSha
  if (addPaths.length) {
    if (UNTRACK_DIRS.some((d) => existsSync(join(workspaceDir, d)))) ensureWorkspaceGitignore(workspaceDir)
    const add = await git(['add', '-A', '--', ...addPaths, ':(exclude).shogo/local'])
    if (add.code !== 0) throw new Error(`git add exited ${add.code}: ${add.stderr.trim().slice(0, 300)}`)
    const staged = await git(['diff', '--cached', '--quiet'])
    if (staged.code === 1) {
      const commit = await git(['commit', '-q', '--no-verify', '-m', 'chore: keep workspace source newer than the durable repo'])
      if (commit.code !== 0) throw new Error(`git commit exited ${commit.code}: ${commit.stderr.trim().slice(0, 300)}`)
      committedSha = (await getHeadSha(workspaceDir)) ?? headSha
    } else if (staged.code !== 0) {
      throw new Error(`git diff exited ${staged.code}: ${staged.stderr.trim().slice(0, 300)}`)
    }
  }
  logger.log(
    `[repo-store] adopted durable repo @ ${headSha}, keeping the hydrated tree for ${keep.join(', ')}` +
      (committedSha !== headSha ? ` (committed as ${committedSha})` : '') +
      (preservedRef ? ` (pre-adopt working tree saved at ${preservedRef})` : ''),
  )
  return { headSha: committedSha, reset: restored.length > 0, preservedRef, keptPaths: keep }
}

/** The caller's deadline passed before the adopt could start; nothing was touched. */
export class AdoptDeadlineError extends Error {}

/**
 * {@link adoptHydratedRepo}, but only if it can start before `deadline`.
 *
 * The host stops waiting at its deadline and from then on treats this VM's
 * tree as the one it hydrated. An adopt that starts later rewrites that tree
 * behind the host's back, so past the deadline this throws
 * {@link AdoptDeadlineError} and removes the staged repo instead. A null
 * deadline waits for `ready` without limit (the legacy contract).
 *
 * `ready` is whatever must settle before `.git` may be swapped (the guest's
 * git layer); `pause`/`resume` bracket the adopt so no sync commits mid-swap.
 */
export async function adoptHydratedRepoBefore(
  workspaceDir: string,
  stagingDir: string,
  opts: {
    deadline: number | null
    ready: Promise<unknown>
    pause?: () => unknown
    resume?: () => unknown
    logger?: Logger
    keepPaths?: string[]
  },
): Promise<AdoptRepoResult> {
  const keepPaths = normalizeKeepPaths(opts.keepPaths)
  const { deadline } = opts
  const decline = () => {
    rmSync(stagingDir, { recursive: true, force: true })
    return new AdoptDeadlineError('deadline passed before the repo could be adopted')
  }
  if (deadline === null) {
    await opts.ready.catch(() => {})
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = await Promise.race([
      opts.ready.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))
      }),
    ])
    clearTimeout(timer)
    if (!ready || Date.now() >= deadline) throw decline()
  }
  await opts.pause?.()
  try {
    if (deadline !== null && Date.now() >= deadline) throw decline()
    return await adoptHydratedRepo(workspaceDir, stagingDir, { logger: opts.logger, keepPaths })
  } finally {
    opts.resume?.()
  }
}

/** Resolve the current HEAD sha, or null when HEAD is unborn / not a repo. */
export async function getHeadSha(workspaceDir: string): Promise<string | null> {
  if (!existsSync(join(workspaceDir, '.git'))) return null
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (c) => { out += String(c) })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? out.trim() || null : null))
  })
}

/**
 * Create an annotated tag at `ref` (default HEAD) in the pod's repo. The tag
 * name is validated so it can't smuggle CLI args. Returns the tagged sha, or
 * throws on git failure. Used by the publish flow (publish-as-tag) — the pod
 * owns the repo, so the tag is created here and persisted to object storage.
 */
export async function createTagLocal(
  workspaceDir: string,
  name: string,
  opts: { message?: string; ref?: string; force?: boolean; authorName?: string; authorEmail?: string } = {},
): Promise<string | null> {
  if (!existsSync(join(workspaceDir, '.git'))) return null
  const { message, ref = 'HEAD', force = false } = opts
  const tagRe = /^[0-9a-zA-Z][0-9a-zA-Z._/-]{0,199}$/
  if (!tagRe.test(name)) throw new Error(`Invalid tag name: ${name}`)
  if (!tagRe.test(ref)) throw new Error(`Invalid tag ref: ${ref}`)
  const authorName = opts.authorName ?? getShogoAgentName()
  const authorEmail = opts.authorEmail ?? getShogoAgentEmail()
  const env = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }
  const args = ['tag', '-a']
  if (force) args.push('-f')
  args.push('-m', message || name, name, ref)
  await run('git', args, { cwd: workspaceDir, env: { ...process.env, ...env } })
  return getHeadSha(workspaceDir)
}

/**
 * Delete a tag in the pod's repo. Used by the publish flow to move/remove the
 * stable `published/<subdomain>` pointer (on subdomain change / unpublish).
 * Idempotent: deleting a tag that doesn't exist is NOT an error — returns
 * `false` rather than throwing. The caller re-persists `.git` afterward.
 */
export async function deleteTagLocal(workspaceDir: string, name: string): Promise<boolean> {
  if (!existsSync(join(workspaceDir, '.git'))) return false
  const tagRe = /^[0-9a-zA-Z][0-9a-zA-Z._/-]{0,199}$/
  if (!tagRe.test(name)) throw new Error(`Invalid tag name: ${name}`)
  try {
    await run('git', ['tag', '-d', name], { cwd: workspaceDir })
    return true
  } catch {
    // Missing tag (git exits non-zero) — fine for an idempotent delete.
    return false
  }
}

/** Build a {@link RepoStoreConfig} from the runtime env, or null when unset. */
export function repoStoreConfigFromEnv(logger?: Logger): RepoStoreConfig | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  const projectId = process.env.PROJECT_ID
  if (!bucket || !projectId) return null
  return {
    projectId,
    bucket,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    logger,
  }
}

/** Whether a durable repo object exists for this project. */
export async function repoExistsInStore(cfg: RepoStoreConfig): Promise<boolean> {
  const client = makeClient(cfg)
  try {
    await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: repoKey(cfg.projectId) }))
    return true
  } catch {
    return false
  }
}

/**
 * Pack `<workspaceDir>/.git` to `destPath`. Shared by the guest's direct
 * persist and the metal `/pool/export-repo` path (host uploads the bytes).
 * Returns null when `.git` is absent.
 */
export async function packRepoArchive(
  workspaceDir: string,
  destPath: string,
  opts: { excludeLfsObjects?: boolean } = {},
): Promise<{ bytes: number } | null> {
  if (!existsSync(join(workspaceDir, '.git'))) return null
  // `--exclude` must precede the `.git` operand. Paths are matched as they
  // appear in the archive (`.git/lfs/objects/...`).
  const tarArgs = ['-czf', destPath, '-C', workspaceDir]
  if (opts.excludeLfsObjects) tarArgs.push('--exclude=.git/lfs/objects')
  tarArgs.push('.git')
  await run('tar', tarArgs)
  return { bytes: statSync(destPath).size }
}

/**
 * Persist `<workspaceDir>/.git` to object storage. Called after each
 * local commit and at shutdown. No-op when `.git` is absent.
 *
 * In Git LFS mode the large object bytes live in their own object-storage
 * namespace (`<projectId>/lfs/objects/...`, uploaded via `git lfs push`), so
 * pass `excludeLfsObjects: true` to keep the local `.git/lfs/objects` cache
 * OUT of the tarball and stop it bloating every hydrate. Callers should only
 * set this once the LFS push has succeeded — otherwise the bytes would exist
 * nowhere durable, so the safe fallback is to leave them in the tarball.
 */
export async function persistRepoToStore(
  workspaceDir: string,
  cfg: RepoStoreConfig,
  opts: { excludeLfsObjects?: boolean } = {},
): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const logger = cfg.logger ?? console
  if (!existsSync(join(workspaceDir, '.git'))) {
    return { ok: true, changed: false, reason: 'no-local-git' }
  }
  const client = makeClient(cfg)
  const tmpFile = join(tmpdir(), `repo-${cfg.projectId}-${randomUUID()}.tar.gz`)
  try {
    const packed = await packRepoArchive(workspaceDir, tmpFile, opts)
    if (!packed) return { ok: true, changed: false, reason: 'no-local-git' }
    // Upload a Buffer, NOT a `createReadStream`. Under the bun runtime
    // (`bun run src/server.ts`) a streaming fs body to the OCI S3-compatible
    // endpoint never completes — the PutObject promise hangs forever, so the
    // afterCommit durability path silently stalls and no `repo.git.tar.gz` is
    // ever written. Reading the (source-only, LFS/offload-excluded, small)
    // tarball into memory mirrors S3Sync's proven upload path.
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: repoKey(cfg.projectId),
        Body: readFileSync(tmpFile),
        ContentType: 'application/gzip',
      }),
    )
    return { ok: true, changed: true }
  } catch (err: any) {
    logger.warn(`[repo-store] persist failed for ${cfg.projectId}: ${err?.message ?? err}`)
    return { ok: false, changed: false, reason: err?.message ?? 'persist-failed' }
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

/**
 * Restore `<workspaceDir>/.git` from object storage and reconstruct the
 * working tree (`git reset --hard HEAD`). No-op when `.git` is already
 * present (warm reuse) or no durable object exists yet (brand-new / legacy
 * project — caller seeds via `git init`).
 */
export async function restoreRepoFromStore(
  workspaceDir: string,
  cfg: RepoStoreConfig,
): Promise<{ ok: boolean; restored: boolean; reason?: string }> {
  const logger = cfg.logger ?? console
  if (existsSync(join(workspaceDir, '.git'))) {
    return { ok: true, restored: false, reason: 'already-local' }
  }
  const client = makeClient(cfg)
  let body: Readable
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: repoKey(cfg.projectId) }))
    if (!res.Body) return { ok: true, restored: false, reason: 'empty-body' }
    body = res.Body as Readable
  } catch {
    return { ok: true, restored: false, reason: 'no-remote-repo' }
  }

  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })
  const tmpFile = join(tmpdir(), `repo-${cfg.projectId}-${randomUUID()}.tar.gz`)
  try {
    await pipeline(body, createWriteStream(tmpFile))
    await run('tar', ['-xzf', tmpFile, '-C', workspaceDir])
    // Reconstruct the working tree from HEAD. Untracked/gitignored files
    // (S3-offloaded large assets restored separately) are preserved.
    try {
      await run('git', ['reset', '--hard', 'HEAD'], { cwd: workspaceDir })
    } catch {
      /* unborn HEAD — leave tree as-is */
    }
    logger.log(`[repo-store] restored durable repo for ${cfg.projectId}`)
    return { ok: true, restored: true }
  } catch (err: any) {
    logger.warn(`[repo-store] restore failed for ${cfg.projectId}: ${err?.message ?? err}`)
    return { ok: false, restored: false, reason: err?.message ?? 'extract-failed' }
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}
