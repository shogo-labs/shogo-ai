/**
 * S3 Sync Module
 *
 * Provides bidirectional file synchronization between S3 and local filesystem.
 * Used by project-runtime to sync project files from/to S3 storage.
 *
 * Features:
 * - Download project files from S3 on startup
 * - Upload changed files to S3 periodically
 * - File watcher for real-time sync (optional)
 * - Supports MinIO and other S3-compatible storage
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { watch } from 'fs'
import { readdir, readFile, writeFile, mkdir, stat, unlink } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { createHash } from 'crypto'

// =============================================================================
// Types
// =============================================================================

export interface S3SyncConfig {
  /** S3 bucket name */
  bucket: string
  /** S3 prefix (usually project ID) */
  prefix: string
  /** Local directory to sync */
  localDir: string
  /** S3 endpoint URL (for MinIO) */
  endpoint?: string
  /** AWS region */
  region?: string
  /** Force path-style URLs (for MinIO) */
  forcePathStyle?: boolean
  /** Patterns to exclude from sync */
  exclude?: string[]
  /** Sync interval in milliseconds (0 to disable periodic sync) */
  syncInterval?: number
  /** Enable file watcher for real-time sync */
  watchEnabled?: boolean
}

export interface SyncStats {
  downloaded: number
  uploaded: number
  deleted: number
  errors: string[]
  lastSync: Date | null
}

interface S3Object {
  key: string
  etag?: string
  size?: number
  lastModified?: Date
}

// =============================================================================
// S3 Sync Class
// =============================================================================

export class S3Sync {
  private client: S3Client
  private config: Required<S3SyncConfig>
  private stats: SyncStats = {
    downloaded: 0,
    uploaded: 0,
    deleted: 0,
    errors: [],
    lastSync: null,
  }
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private watcher: ReturnType<typeof watch> | null = null
  private pendingUploads: Set<string> = new Set()
  private uploadDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: S3SyncConfig) {
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix,
      localDir: config.localDir,
      endpoint: config.endpoint || process.env.S3_ENDPOINT || undefined,
      region: config.region || process.env.S3_REGION || 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === 'true'),
      exclude: config.exclude || ['node_modules', '.git', '.DS_Store', '*.log', 'dist', '.output', 'build'],
      syncInterval: config.syncInterval ?? 30000, // 30 seconds default for faster sync
      watchEnabled: config.watchEnabled ?? true, // Enable by default for emptyDir support
    }

    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      } : undefined,
    })

    console.log(`[S3Sync] Initialized for ${this.config.bucket}/${this.config.prefix}`)
    if (this.config.endpoint) {
      console.log(`[S3Sync] Using custom endpoint: ${this.config.endpoint}`)
    }
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Download all files from S3 to local directory.
   * Called on startup to initialize the project.
   */
  async downloadAll(): Promise<SyncStats> {
    console.log(`[S3Sync] Downloading from s3://${this.config.bucket}/${this.config.prefix}`)

    try {
      const s3Objects = await this.listS3Objects()
      console.log(`[S3Sync] Found ${s3Objects.length} objects in S3`)

      for (const obj of s3Objects) {
        await this.downloadObject(obj)
      }

      this.stats.lastSync = new Date()
      console.log(`[S3Sync] Download complete: ${this.stats.downloaded} files`)
    } catch (error: any) {
      console.error(`[S3Sync] Download failed:`, error)
      this.stats.errors.push(`Download failed: ${error.message}`)
    }

    return this.getStats()
  }

  /**
   * Upload all local files to S3.
   * Optionally deletes files from S3 that don't exist locally.
   */
  async uploadAll(deleteOrphans: boolean = false): Promise<SyncStats> {
    console.log(`[S3Sync] Uploading to s3://${this.config.bucket}/${this.config.prefix}`)

    try {
      const localFiles = await this.listLocalFiles()
      console.log(`[S3Sync] Found ${localFiles.length} local files`)

      for (const filePath of localFiles) {
        await this.uploadFile(filePath)
      }

      if (deleteOrphans) {
        const s3Objects = await this.listS3Objects()
        const localSet = new Set(localFiles.map(f => relative(this.config.localDir, f)))

        for (const obj of s3Objects) {
          const relativePath = obj.key.replace(`${this.config.prefix}/`, '')
          if (!localSet.has(relativePath)) {
            await this.deleteS3Object(obj.key)
          }
        }
      }

      this.stats.lastSync = new Date()
      console.log(`[S3Sync] Upload complete: ${this.stats.uploaded} files`)
    } catch (error: any) {
      console.error(`[S3Sync] Upload failed:`, error)
      this.stats.errors.push(`Upload failed: ${error.message}`)
    }

    return this.getStats()
  }

  /**
   * Start periodic sync (upload changes to S3).
   */
  startPeriodicSync(): void {
    if (this.config.syncInterval <= 0) {
      console.log(`[S3Sync] Periodic sync disabled (interval: 0)`)
      return
    }

    console.log(`[S3Sync] Starting periodic sync every ${this.config.syncInterval / 1000}s`)

    this.syncTimer = setInterval(async () => {
      console.log(`[S3Sync] Running periodic sync...`)
      await this.uploadAll(false)
    }, this.config.syncInterval)
  }

  /**
   * Stop periodic sync.
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
      console.log(`[S3Sync] Periodic sync stopped`)
    }
  }

  /**
   * Start file watcher for real-time sync.
   */
  startWatcher(): void {
    if (!this.config.watchEnabled) {
      console.log(`[S3Sync] File watcher disabled`)
      return
    }

    // Check if directory exists before starting watcher
    try {
      const dirStat = require('fs').statSync(this.config.localDir)
      if (!dirStat.isDirectory()) {
        console.warn(`[S3Sync] Cannot start watcher: ${this.config.localDir} is not a directory`)
        return
      }
    } catch (error: any) {
      console.warn(`[S3Sync] Cannot start watcher: ${this.config.localDir} does not exist`)
      return
    }

    console.log(`[S3Sync] Starting file watcher on ${this.config.localDir}`)

    try {
      this.watcher = watch(
        this.config.localDir,
        { recursive: true },
        (eventType, filename) => {
          try {
            if (!filename || this.shouldExclude(filename)) return

            const filePath = join(this.config.localDir, filename)
            this.pendingUploads.add(filePath)

            // Debounce uploads
            if (this.uploadDebounceTimer) {
              clearTimeout(this.uploadDebounceTimer)
            }

            this.uploadDebounceTimer = setTimeout(async () => {
              const files = Array.from(this.pendingUploads)
              this.pendingUploads.clear()

              for (const file of files) {
                try {
                  const stats = await stat(file).catch(() => null)
                  if (stats?.isFile()) {
                    await this.uploadFile(file)
                  }
                } catch (error) {
                  // File may have been deleted - ignore
                }
              }
            }, 1000) // 1 second debounce
          } catch (error: any) {
            // Ignore errors in watcher callback - file may have been deleted
            console.warn(`[S3Sync] Watcher callback error (ignored):`, error.message)
          }
        }
      )
      
      // Handle watcher errors gracefully
      this.watcher.on('error', (error: Error) => {
        console.warn(`[S3Sync] File watcher error (continuing without watcher):`, error.message)
        this.stopWatcher()
      })
    } catch (error: any) {
      console.warn(`[S3Sync] Failed to start file watcher:`, error.message)
      // Don't crash - continue without file watcher
    }
  }

  /**
   * Stop file watcher.
   */
  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      console.log(`[S3Sync] File watcher stopped`)
    }
  }

  /**
   * Get sync statistics.
   */
  getStats(): SyncStats {
    return { ...this.stats }
  }

  /**
   * Shutdown: stop all timers and watchers.
   */
  shutdown(): void {
    this.stopPeriodicSync()
    this.stopWatcher()
    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async listS3Objects(): Promise<S3Object[]> {
    const objects: S3Object[] = []
    let continuationToken: string | undefined

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${this.config.prefix}/`,
        ContinuationToken: continuationToken,
      })

      const response = await this.client.send(command)

      for (const obj of response.Contents || []) {
        if (obj.Key && !obj.Key.endsWith('/')) {
          objects.push({
            key: obj.Key,
            etag: obj.ETag,
            size: obj.Size,
            lastModified: obj.LastModified,
          })
        }
      }

      continuationToken = response.NextContinuationToken
    } while (continuationToken)

    return objects
  }

  private async downloadObject(obj: S3Object): Promise<void> {
    const relativePath = obj.key.replace(`${this.config.prefix}/`, '')

    if (this.shouldExclude(relativePath)) {
      return
    }

    const localPath = join(this.config.localDir, relativePath)

    try {
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: obj.key,
      })

      const response = await this.client.send(command)
      const body = await response.Body?.transformToByteArray()

      if (body) {
        await mkdir(dirname(localPath), { recursive: true })
        await writeFile(localPath, body)
        this.stats.downloaded++
        console.log(`[S3Sync] Downloaded: ${relativePath}`)
      }
    } catch (error: any) {
      console.error(`[S3Sync] Failed to download ${obj.key}:`, error.message)
      this.stats.errors.push(`Download ${obj.key}: ${error.message}`)
    }
  }

  private async uploadFile(filePath: string): Promise<void> {
    const relativePath = relative(this.config.localDir, filePath)

    if (this.shouldExclude(relativePath)) {
      return
    }

    const s3Key = `${this.config.prefix}/${relativePath}`

    try {
      const content = await readFile(filePath)
      const contentType = this.getContentType(filePath)

      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: s3Key,
        Body: content,
        ContentType: contentType,
      })

      await this.client.send(command)
      this.stats.uploaded++
      console.log(`[S3Sync] Uploaded: ${relativePath}`)
    } catch (error: any) {
      console.error(`[S3Sync] Failed to upload ${filePath}:`, error.message)
      this.stats.errors.push(`Upload ${filePath}: ${error.message}`)
    }
  }

  private async deleteS3Object(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })

      await this.client.send(command)
      this.stats.deleted++
      console.log(`[S3Sync] Deleted from S3: ${key}`)
    } catch (error: any) {
      console.error(`[S3Sync] Failed to delete ${key}:`, error.message)
      this.stats.errors.push(`Delete ${key}: ${error.message}`)
    }
  }

  private async listLocalFiles(dir?: string): Promise<string[]> {
    const targetDir = dir || this.config.localDir
    const files: string[] = []

    try {
      const entries = await readdir(targetDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(targetDir, entry.name)
        const relativePath = relative(this.config.localDir, fullPath)

        if (this.shouldExclude(relativePath)) {
          continue
        }

        if (entry.isDirectory()) {
          const subFiles = await this.listLocalFiles(fullPath)
          files.push(...subFiles)
        } else if (entry.isFile()) {
          files.push(fullPath)
        }
      }
    } catch (error) {
      // Directory may not exist yet
    }

    return files
  }

  private shouldExclude(path: string): boolean {
    for (const pattern of this.config.exclude) {
      if (pattern.startsWith('*')) {
        // Glob pattern (e.g., *.log)
        const ext = pattern.slice(1)
        if (path.endsWith(ext)) return true
      } else {
        // Exact match or path contains
        if (path === pattern || path.includes(`/${pattern}/`) || path.includes(`/${pattern}`) || path.startsWith(`${pattern}/`)) {
          return true
        }
      }
    }
    return false
  }

  private getContentType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase()
    const types: Record<string, string> = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'ts': 'application/typescript',
      'tsx': 'application/typescript',
      'jsx': 'application/javascript',
      'json': 'application/json',
      'md': 'text/markdown',
      'txt': 'text/plain',
      'svg': 'image/svg+xml',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
    }
    return types[ext || ''] || 'application/octet-stream'
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an S3Sync instance from environment variables.
 */
export function createS3SyncFromEnv(localDir: string): S3Sync | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  const prefix = process.env.PROJECT_ID

  if (!bucket || !prefix) {
    console.log('[S3Sync] S3 sync not configured (S3_WORKSPACES_BUCKET or PROJECT_ID not set)')
    return null
  }

  // Enable file watching by default when S3 is configured
  // This is critical for emptyDir volumes where files need to sync to S3 for persistence
  const watchEnabled = process.env.S3_WATCH_ENABLED !== 'false' // Default to true

  return new S3Sync({
    bucket,
    prefix,
    localDir,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    syncInterval: parseInt(process.env.S3_SYNC_INTERVAL || '30000', 10), // 30s default for faster sync
    watchEnabled,
  })
}

/**
 * Initialize S3 sync: download files and start background sync.
 * Returns null if S3 is not configured OR if initial download fails critically.
 */
export async function initializeS3Sync(localDir: string): Promise<S3Sync | null> {
  const sync = createS3SyncFromEnv(localDir)

  if (!sync) {
    return null
  }

  // Download files from S3
  const downloadStats = await sync.downloadAll()
  
  // Check if download had critical errors (like access denied)
  // If so, don't start the watcher - it could cause crashes on incomplete directories
  const hasCriticalError = downloadStats.errors.some(err => 
    err.includes('AccessDenied') || 
    err.includes('NoSuchBucket') ||
    err.includes('InvalidAccessKeyId') ||
    err.includes('SignatureDoesNotMatch')
  )
  
  if (hasCriticalError) {
    console.warn('[S3Sync] Critical error during initial download - S3 sync disabled')
    console.warn('[S3Sync] Errors:', downloadStats.errors)
    // Don't start watcher or periodic sync - this would cause issues
    return null
  }

  // Start periodic sync (upload changes)
  sync.startPeriodicSync()

  // Only start file watcher if there are files to watch
  // For new projects (0 files), the watcher will be started later after template.copy
  // This prevents crashes when watching empty directories
  if (downloadStats.downloaded > 0) {
    sync.startWatcher()
  } else {
    console.log('[S3Sync] Skipping file watcher (no files downloaded - new project)')
    console.log('[S3Sync] Watcher will be started after files are added')
  }

  return sync
}
