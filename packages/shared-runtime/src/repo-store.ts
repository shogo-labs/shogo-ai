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
import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'fs'
import { unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
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
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`)),
    )
  })
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
 */
export async function seedRepoIfAbsent(
  workspaceDir: string,
  opts: { branch?: string; authorName?: string; authorEmail?: string; logger?: Logger } = {},
): Promise<string | null> {
  const logger = opts.logger ?? console
  if (existsSync(join(workspaceDir, '.git'))) return null
  const branch = opts.branch ?? 'main'
  const authorName = opts.authorName ?? 'Shogo Agent'
  const authorEmail = opts.authorEmail ?? 'agent-runtime@shogo.ai'
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true })

  const env = {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  }
  const runEnv = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('git', args, { cwd: workspaceDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += String(c) })
      child.stderr.on('data', (c) => { stderr += String(c) })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })

  try {
    await runEnv(['init', '-b', branch])
    await runEnv(['config', 'core.autocrlf', 'false'])
    await runEnv(['config', 'core.longpaths', 'true'])
    await runEnv(['config', 'user.name', authorName])
    await runEnv(['config', 'user.email', authorEmail])
    await runEnv(['add', '-A'])
    const staged = await runEnv(['diff', '--cached', '--quiet'])
    if (staged.code === 0) {
      logger.log('[repo-store] seed: empty workspace, initialized empty repo')
      return null
    }
    await runEnv(['commit', '-m', 'chore: seed repo from workspace', '--no-verify'])
    const head = await runEnv(['rev-parse', 'HEAD'])
    const sha = head.code === 0 ? head.stdout.trim() : null
    logger.log(`[repo-store] seeded local repo @ ${sha ?? '?'}`)
    return sha
  } catch (err: any) {
    logger.warn(`[repo-store] seed failed: ${err?.message ?? err}`)
    return null
  }
}

/** Resolve the current HEAD sha, or null when HEAD is unborn / not a repo. */
export async function getHeadSha(workspaceDir: string): Promise<string | null> {
  if (!existsSync(join(workspaceDir, '.git'))) return null
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += String(c) })
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
  const authorName = opts.authorName ?? 'Shogo Agent'
  const authorEmail = opts.authorEmail ?? 'agent-runtime@shogo.ai'
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
    // `--exclude` must precede the `.git` operand. Paths are matched as they
    // appear in the archive (`.git/lfs/objects/...`).
    const tarArgs = ['-czf', tmpFile, '-C', workspaceDir]
    if (opts.excludeLfsObjects) tarArgs.push('--exclude=.git/lfs/objects')
    tarArgs.push('.git')
    await run('tar', tarArgs)
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: repoKey(cfg.projectId),
        Body: createReadStream(tmpFile),
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
