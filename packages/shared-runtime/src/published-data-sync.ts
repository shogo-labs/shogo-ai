// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Published-data sync
 *
 * Server-backed published apps (SHOGO_PUBLISHED_MODE) run the project's
 * `server.tsx` backend in production, so end-user writes (e.g. a guest list
 * the app stores in `prisma/dev.db`) must survive pod restarts and
 * scale-to-zero. The source tree itself is hydrated read-only from the
 * durable git repo at the published commit — that carries the *seed* DB the
 * builder created — but anything written AFTER publish lives only in the
 * pod's ephemeral `emptyDir`.
 *
 * This module persists ONLY the writable runtime state (the SQLite DB plus
 * any upload dirs) to a dedicated object-storage bucket, separate from the
 * source archive used by the dev/preview S3Sync. It is deliberately tiny and
 * self-contained — no layered deps cache, no git interplay:
 *
 *   restore():  download `{prefix}/data.tar.gz` and overlay it onto the
 *               read-only source tree. No-op (returns false) when the
 *               archive does not exist yet (first boot uses the git seed).
 *   flush():    tar the writable paths that exist and upload the archive.
 *               Skips the upload when the content hash is unchanged.
 *   startAutoFlush(): periodic interval + a debounced fs watcher on the DB.
 *
 * Single-writer is guaranteed by the published Knative service pinning
 * `max-scale=1`, so there is never a concurrent uploader racing this one.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { watch } from 'fs'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile, rm, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import * as tar from 'tar'

/** Object key (under the subdomain prefix) holding the writable-state archive. */
const ARCHIVE_KEY = 'data.tar.gz'

/** Default debounce for the watcher-triggered flush (ms). */
const FLUSH_DEBOUNCE_MS = 4000

/**
 * Relative paths (to the workspace dir) treated as writable runtime state.
 * Only the entries that actually exist are archived, so listing a few common
 * upload locations is harmless when a given app doesn't use them.
 *
 * SQLite WAL/SHM siblings are included so a flush taken mid-transaction
 * restores to a consistent on-disk state.
 */
const DEFAULT_WRITABLE_PATHS = [
  'prisma/dev.db',
  'prisma/dev.db-wal',
  'prisma/dev.db-shm',
  'uploads',
  'public/uploads',
  'storage',
]

export interface PublishedDataSyncConfig {
  /** Object-storage bucket holding published-app writable state. */
  bucket: string
  /** Object key prefix — the published subdomain. */
  prefix: string
  /** Local workspace directory the writable paths are relative to. */
  localDir: string
  /** S3-compatible endpoint (OCI Object Storage / MinIO). */
  endpoint?: string
  /** AWS region. */
  region?: string
  /** Force path-style addressing (MinIO / OCI S3-compat). */
  forcePathStyle?: boolean
  /** Writable paths (relative to localDir) to persist. Defaults to the DB + upload dirs. */
  paths?: string[]
  /** Periodic flush interval in ms (0 disables the interval). */
  syncInterval?: number
  /** Enable the debounced fs watcher on the DB file. */
  watchEnabled?: boolean
}

export class PublishedDataSync {
  private client: S3Client
  private bucket: string
  private prefix: string
  private localDir: string
  private paths: string[]
  private syncInterval: number
  private watchEnabled: boolean

  private syncTimer: ReturnType<typeof setInterval> | null = null
  private watcher: ReturnType<typeof watch> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastUploadHash = ''
  private isFlushing = false
  private flushRequestedDuringFlush = false
  private stopped = false

  constructor(config: PublishedDataSyncConfig) {
    this.bucket = config.bucket
    this.prefix = config.prefix
    this.localDir = config.localDir
    this.paths = config.paths ?? DEFAULT_WRITABLE_PATHS
    this.syncInterval = config.syncInterval ?? 30000
    this.watchEnabled = config.watchEnabled ?? true

    const region = config.region || process.env.S3_REGION || 'us-east-1'
    const endpoint = config.endpoint || process.env.S3_ENDPOINT
    this.client = new S3Client({
      region,
      ...(endpoint && {
        endpoint,
        forcePathStyle: config.forcePathStyle ?? true,
      }),
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
          }
        : undefined,
    })

    console.log(`[PublishedDataSync] Initialized for ${this.bucket}/${this.prefix}/${ARCHIVE_KEY}`)
  }

  private get archiveKey(): string {
    return `${this.prefix}/${ARCHIVE_KEY}`
  }

  /** Writable paths that currently exist on disk (relative to localDir). */
  private existingPaths(): string[] {
    return this.paths.filter((p) => existsSync(join(this.localDir, p)))
  }

  /**
   * Download + extract the writable-state archive over the workspace tree.
   * Returns false (no error) when the archive does not exist yet.
   */
  async restore(): Promise<boolean> {
    let tmpDir: string | null = null
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.archiveKey }),
      )
      const bytes = await res.Body!.transformToByteArray()
      const buf = Buffer.from(bytes)
      this.lastUploadHash = createHash('sha256').update(buf).digest('hex')

      tmpDir = await mkdtemp(join(tmpdir(), 'shogo-pubdata-'))
      const archivePath = join(tmpDir, ARCHIVE_KEY)
      await writeFile(archivePath, buf)

      if (!existsSync(this.localDir)) mkdirSync(this.localDir, { recursive: true })
      await tar.extract({ file: archivePath, cwd: this.localDir })

      console.log(`[PublishedDataSync] Restored writable state (${buf.length} bytes) from ${this.archiveKey}`)
      return true
    } catch (err: any) {
      const code = err?.name || err?.Code || err?.$metadata?.httpStatusCode
      const notFound =
        err?.name === 'NoSuchKey' ||
        err?.Code === 'NoSuchKey' ||
        err?.$metadata?.httpStatusCode === 404
      if (notFound) {
        console.log(`[PublishedDataSync] No existing archive at ${this.archiveKey} — using source seed`)
        return false
      }
      console.warn(`[PublishedDataSync] restore() failed (${code}):`, err?.message ?? err)
      return false
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Archive the existing writable paths and upload. Skips the PUT when the
   * archive content is byte-identical to the last upload. Returns true when
   * an upload actually happened.
   */
  async flush(): Promise<boolean> {
    if (this.isFlushing) {
      this.flushRequestedDuringFlush = true
      return false
    }
    this.isFlushing = true
    let tmpDir: string | null = null
    try {
      const paths = this.existingPaths()
      if (paths.length === 0) {
        return false
      }

      tmpDir = await mkdtemp(join(tmpdir(), 'shogo-pubdata-'))
      const archivePath = join(tmpDir, ARCHIVE_KEY)
      await tar.create({ gzip: true, file: archivePath, cwd: this.localDir, portable: true }, paths)
      const buf = await readFile(archivePath)
      const hash = createHash('sha256').update(buf).digest('hex')
      if (hash === this.lastUploadHash) {
        return false
      }

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.archiveKey,
          Body: buf,
          ContentType: 'application/gzip',
          CacheControl: 'no-store',
        }),
      )
      this.lastUploadHash = hash
      console.log(`[PublishedDataSync] Flushed writable state (${buf.length} bytes) to ${this.archiveKey}`)
      return true
    } catch (err: any) {
      console.warn(`[PublishedDataSync] flush() failed:`, err?.message ?? err)
      return false
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      this.isFlushing = false
      if (this.flushRequestedDuringFlush && !this.stopped) {
        this.flushRequestedDuringFlush = false
        this.scheduleDebouncedFlush()
      }
    }
  }

  private scheduleDebouncedFlush(): void {
    if (this.stopped) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  /** Start the periodic interval + a debounced watcher on the DB file. */
  startAutoFlush(): void {
    if (this.stopped) return

    if (this.syncInterval > 0 && !this.syncTimer) {
      this.syncTimer = setInterval(() => {
        void this.flush()
      }, this.syncInterval)
      // Don't hold the event loop open on this timer alone. The timer's
      // runtime type is environment-dependent (NodeJS.Timeout vs number), so
      // guard the Node-only `unref` rather than relying on the static type.
      const timer = this.syncTimer as unknown as { unref?: () => void }
      if (typeof timer.unref === 'function') timer.unref()
    }

    if (this.watchEnabled && !this.watcher) {
      const dbDir = join(this.localDir, 'prisma')
      if (existsSync(dbDir)) {
        try {
          this.watcher = watch(dbDir, { persistent: false }, () => {
            this.scheduleDebouncedFlush()
          })
        } catch (err: any) {
          console.warn(`[PublishedDataSync] watcher init failed:`, err?.message ?? err)
        }
      }
    }
    console.log(`[PublishedDataSync] Auto-flush started (interval=${this.syncInterval}ms, watch=${this.watchEnabled})`)
  }

  /** Stop timers/watcher and run one final flush, bounded by timeoutMs. */
  async flushAndShutdown(timeoutMs = 10000): Promise<void> {
    this.stop()
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    } catch (err: any) {
      console.warn(`[PublishedDataSync] shutdown flush failed:`, err?.message ?? err)
    }
  }

  /** Stop all background activity without flushing. */
  stop(): void {
    this.stopped = true
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      try { this.watcher.close() } catch {}
      this.watcher = null
    }
  }
}

/**
 * Construct a PublishedDataSync from environment, or null when not in
 * server-backed published mode / the data bucket isn't configured.
 *
 * Reads:
 *   S3_PUBLISHED_DATA_BUCKET (or PUBLISH_DATA_BUCKET)  — the data bucket
 *   PUBLISHED_SUBDOMAIN                                — object prefix
 *   PUBLISHED_DATA_PATHS (optional, JSON string[])     — override paths
 *   S3_ENDPOINT / S3_REGION / S3_FORCE_PATH_STYLE      — endpoint config
 */
export function createPublishedDataSyncFromEnv(localDir: string): PublishedDataSync | null {
  const bucket = process.env.S3_PUBLISHED_DATA_BUCKET || process.env.PUBLISH_DATA_BUCKET
  const prefix = process.env.PUBLISHED_SUBDOMAIN
  if (!bucket || !prefix) {
    console.log(
      `[PublishedDataSync] Not configured (bucket=${bucket ?? 'unset'}, subdomain=${prefix ?? 'unset'})`,
    )
    return null
  }

  let paths: string[] | undefined
  const rawPaths = process.env.PUBLISHED_DATA_PATHS
  if (rawPaths) {
    try {
      const parsed = JSON.parse(rawPaths)
      if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string')
    } catch {
      console.warn(`[PublishedDataSync] Could not parse PUBLISHED_DATA_PATHS — using defaults`)
    }
  }

  return new PublishedDataSync({
    bucket,
    prefix,
    localDir,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    paths,
    syncInterval: parseInt(process.env.PUBLISHED_DATA_SYNC_INTERVAL || '30000', 10),
    watchEnabled: process.env.PUBLISHED_DATA_WATCH !== 'false',
  })
}
