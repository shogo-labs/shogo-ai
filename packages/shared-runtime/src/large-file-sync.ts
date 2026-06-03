// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hybrid large-file offload for `git_only` projects.
 *
 * Git is great for text/source but terrible for large binary assets:
 * committing them bloats every clone/hydrate and the durable `.git`
 * tarball. The legacy S3 tar was content-blind (large assets rode along,
 * latest-only) and there is no Git LFS in the codebase.
 *
 * This module keeps git small by classifying any file larger than
 * `LARGE_FILE_BYTES` (default 5 MB) as an "offloaded asset":
 *
 *   1. The file is git-excluded via `.git/info/exclude` (a local exclude
 *      that doesn't touch the user's `.gitignore`), so `git add -A`
 *      never stages it.
 *   2. The bytes are uploaded per-file to object storage under
 *      `<projectId>/assets/<relpath>` (a namespace distinct from the
 *      S3Sync dependency/source layers).
 *   3. On cold start the offloaded set is restored into the working tree
 *      alongside the git clone so the pod sees a complete tree.
 *
 * Semantics (intentional, matches today's S3 behavior): offloaded files
 * are latest-only and don't appear in the git graph/diff. Checkpoints and
 * publish tags pin the *source* commit; the asset snapshot is whatever S3
 * holds. True large-file versioning (Git LFS) is deferred.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative, sep } from 'path'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

/** Default size threshold above which a file is offloaded to S3. */
export const DEFAULT_LARGE_FILE_BYTES = 5 * 1024 * 1024

/** Directories never walked for large-file classification. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.bun',
  '.npm',
  '.cache',
  '.expo',
  '.expo-shared',
  '.metro-cache',
])

const MANAGED_EXCLUDE_HEADER = '# >>> shogo large-file offload (managed) >>>'
const MANAGED_EXCLUDE_FOOTER = '# <<< shogo large-file offload (managed) <<<'

export function largeFileThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.LARGE_FILE_BYTES || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LARGE_FILE_BYTES
}

export interface LargeFileSyncConfig {
  workspaceDir: string
  projectId: string
  bucket: string
  region?: string
  endpoint?: string
  thresholdBytes?: number
  logger?: Logger
}

function makeClient(cfg: LargeFileSyncConfig): S3Client {
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

function assetKey(projectId: string, relPath: string): string {
  // Normalize to forward slashes for S3 keys regardless of platform.
  return `${projectId}/assets/${relPath.split(sep).join('/')}`
}

function assetPrefix(projectId: string): string {
  return `${projectId}/assets/`
}

/**
 * Recursively classify files larger than the threshold. Returns POSIX-ish
 * relative paths (using the platform separator; normalized at the S3 key
 * boundary).
 */
export function classifyLargeFiles(workspaceDir: string, thresholdBytes: number): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        const abs = join(dir, entry.name)
        let size = 0
        try {
          size = statSync(abs).size
        } catch {
          continue
        }
        if (size > thresholdBytes) {
          out.push(relative(workspaceDir, abs))
        }
      }
    }
  }
  walk(workspaceDir)
  return out
}

/**
 * Rewrite the managed block of `.git/info/exclude` so the offloaded files
 * are never staged by `git add -A`. Leaves any user-authored content in
 * the file untouched.
 */
function updateGitExclude(workspaceDir: string, relPaths: string[]): void {
  const excludePath = join(workspaceDir, '.git', 'info', 'exclude')
  if (!existsSync(join(workspaceDir, '.git', 'info'))) {
    // No git repo (or unusual layout) — nothing to exclude.
    return
  }
  let existing = ''
  try {
    existing = readFileSync(excludePath, 'utf-8')
  } catch {
    existing = ''
  }
  // Strip any prior managed block.
  const start = existing.indexOf(MANAGED_EXCLUDE_HEADER)
  if (start !== -1) {
    const end = existing.indexOf(MANAGED_EXCLUDE_FOOTER)
    if (end !== -1) {
      existing = existing.slice(0, start) + existing.slice(end + MANAGED_EXCLUDE_FOOTER.length)
    }
  }
  existing = existing.replace(/\n{3,}/g, '\n\n').trimEnd()

  const block = relPaths.length
    ? [
        MANAGED_EXCLUDE_HEADER,
        ...relPaths.map((p) => `/${p.split(sep).join('/')}`),
        MANAGED_EXCLUDE_FOOTER,
      ].join('\n')
    : ''

  const next = [existing, block].filter(Boolean).join('\n\n') + '\n'
  writeFileSync(excludePath, next)
}

/**
 * Sync the current large-file set to object storage: upload new/changed
 * assets, prune assets no longer present, and refresh the git-exclude
 * block. Best-effort — logs and continues on per-file errors.
 */
export async function syncLargeFiles(cfg: LargeFileSyncConfig): Promise<{ uploaded: number; pruned: number }> {
  const logger = cfg.logger ?? console
  const threshold = cfg.thresholdBytes ?? largeFileThreshold()
  const client = makeClient(cfg)

  const relPaths = classifyLargeFiles(cfg.workspaceDir, threshold)
  updateGitExclude(cfg.workspaceDir, relPaths)

  const desiredKeys = new Set(relPaths.map((p) => assetKey(cfg.projectId, p)))

  // Upload current set.
  let uploaded = 0
  for (const rel of relPaths) {
    const abs = join(cfg.workspaceDir, rel)
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: assetKey(cfg.projectId, rel),
          Body: createReadStream(abs),
        }),
      )
      uploaded++
    } catch (err: any) {
      logger.warn(`[large-file-sync] upload failed for ${rel}: ${err?.message ?? err}`)
    }
  }

  // Prune assets that no longer exist locally.
  let pruned = 0
  try {
    let token: string | undefined
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: assetPrefix(cfg.projectId),
          ContinuationToken: token,
        }),
      )
      for (const obj of res.Contents ?? []) {
        if (obj.Key && !desiredKeys.has(obj.Key)) {
          await client
            .send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: obj.Key }))
            .then(() => { pruned++ })
            .catch((err) => logger.warn(`[large-file-sync] prune failed for ${obj.Key}: ${err?.message ?? err}`))
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
  } catch (err: any) {
    logger.warn(`[large-file-sync] prune scan failed: ${err?.message ?? err}`)
  }

  if (uploaded || pruned) {
    logger.log(`[large-file-sync] ${cfg.projectId}: uploaded=${uploaded} pruned=${pruned} (threshold=${threshold}B)`)
  }
  return { uploaded, pruned }
}

/**
 * Restore all offloaded assets for the project into the working tree.
 * Called on cold start after the git clone so the pod sees a complete
 * tree. Best-effort.
 */
export async function restoreLargeFiles(cfg: LargeFileSyncConfig): Promise<{ restored: number }> {
  const logger = cfg.logger ?? console
  const client = makeClient(cfg)
  const prefix = assetPrefix(cfg.projectId)
  let restored = 0

  try {
    let token: string | undefined
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      )
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue
        const rel = obj.Key.slice(prefix.length)
        if (!rel) continue
        const dest = join(cfg.workspaceDir, ...rel.split('/'))
        try {
          mkdirSync(dirname(dest), { recursive: true })
          const got = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: obj.Key }))
          if (got.Body) {
            await pipeline(got.Body as Readable, createWriteStream(dest))
            restored++
          }
        } catch (err: any) {
          logger.warn(`[large-file-sync] restore failed for ${rel}: ${err?.message ?? err}`)
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
  } catch (err: any) {
    logger.warn(`[large-file-sync] restore scan failed: ${err?.message ?? err}`)
  }

  if (restored) logger.log(`[large-file-sync] ${cfg.projectId}: restored ${restored} offloaded asset(s)`)
  return { restored }
}

/**
 * Build a {@link LargeFileSyncConfig} from the agent-runtime env, or null
 * when object storage isn't configured for this pod.
 */
export function largeFileSyncConfigFromEnv(
  workspaceDir: string,
  logger?: Logger,
): LargeFileSyncConfig | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  const projectId = process.env.PROJECT_ID
  if (!bucket || !projectId) return null
  return {
    workspaceDir,
    projectId,
    bucket,
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    thresholdBytes: largeFileThreshold(),
    logger,
  }
}
