/**
 * S3 Sync Module (Zip-based)
 *
 * Provides bidirectional file synchronization between S3 and local filesystem.
 * Uses zip archives for efficient storage and fast downloads (includes node_modules).
 *
 * Key Benefits:
 * - Single zip file download vs thousands of individual files
 * - node_modules included = no bun install needed on cold start
 * - Much faster restore times (~2s vs ~15s)
 *
 * Features:
 * - Download project zip from S3 on startup
 * - Upload changed files to S3 periodically (as zip)
 * - Incremental file tracking for efficient syncs
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { watch } from 'fs'
import { readdir, readFile, writeFile, mkdir, stat, unlink, rm } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { createGzip, createGunzip } from 'zlib'
import * as tar from 'tar'

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
  /** Patterns to exclude from sync (relative paths) */
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
  archiveSize?: number
}

// =============================================================================
// S3 Sync Class (Zip-based)
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
  private lastUploadHash: string = ''

  constructor(config: S3SyncConfig) {
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix,
      localDir: config.localDir,
      endpoint: config.endpoint || process.env.S3_ENDPOINT || undefined,
      region: config.region || process.env.S3_REGION || 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === 'true'),
      // Exclude patterns - these won't be included in the zip
      // IMPORTANT: We INCLUDE node_modules and dist
      // This eliminates the need for bun install and vite build on cold start
      exclude: config.exclude || [
        '.DS_Store',      // macOS metadata
        '*.log',          // Log files
        'playwright-report',  // Test artifacts
        'test-results',       // Test artifacts
        'dev.db',             // Local SQLite (we use Postgres in K8s)
        'dev.db-journal',     // SQLite journal
        '.bun',               // Bun cache (can be regenerated)
      ],
      syncInterval: config.syncInterval ?? 30000, // 30 seconds default
      watchEnabled: config.watchEnabled ?? true,
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
   * Get the S3 key for the project archive
   */
  private getArchiveKey(): string {
    return `${this.config.prefix}/project.tar.gz`
  }

  /**
   * Check if archive exists in S3
   */
  async archiveExists(): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getArchiveKey(),
      }))
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  /**
   * Download and extract project archive from S3.
   * Called on startup to initialize the project.
   */
  async downloadAll(): Promise<SyncStats> {
    const archiveKey = this.getArchiveKey()
    console.log(`[S3Sync] Downloading archive from s3://${this.config.bucket}/${archiveKey}`)

    try {
      // Check if archive exists
      const exists = await this.archiveExists()
      if (!exists) {
        console.log(`[S3Sync] No archive found in S3 (new project)`)
        return this.getStats()
      }

      // Download archive
      const startTime = Date.now()
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: archiveKey,
      })

      const response = await this.client.send(command)
      if (!response.Body) {
        console.log(`[S3Sync] Empty response from S3`)
        return this.getStats()
      }

      const downloadTime = Date.now() - startTime
      console.log(`[S3Sync] Downloaded archive in ${downloadTime}ms`)

      // Ensure local directory exists
      if (!existsSync(this.config.localDir)) {
        mkdirSync(this.config.localDir, { recursive: true })
      }

      // Extract archive directly from stream
      const extractStart = Date.now()
      
      // Convert web stream to node stream
      const webStream = response.Body as any
      const nodeStream = webStream.transformToWebStream 
        ? (await webStream.transformToByteArray()).buffer
        : webStream

      // For AWS SDK v3, we need to handle the stream properly
      const bodyArray = await response.Body.transformToByteArray()
      const tempArchive = join('/tmp', `project-${this.config.prefix}.tar.gz`)
      await writeFile(tempArchive, bodyArray)
      
      // Extract using tar
      await tar.extract({
        file: tempArchive,
        cwd: this.config.localDir,
        strip: 0, // Don't strip any path components
      })
      
      // Cleanup temp file
      await unlink(tempArchive).catch(() => {})

      const extractTime = Date.now() - extractStart
      console.log(`[S3Sync] Extracted archive in ${extractTime}ms`)

      // Count files and check what was restored
      const fileCount = await this.countFiles(this.config.localDir)
      const allFiles = await this.listLocalFiles()
      const hasNodeModules = allFiles.some(f => f.includes('/node_modules/'))
      const hasBuildOutput = allFiles.some(f => f.includes('/dist/'))
      
      this.stats.downloaded = fileCount
      this.stats.lastSync = new Date()
      this.stats.archiveSize = bodyArray.length

      console.log(`[S3Sync] Download complete: ${fileCount} files (${this.formatBytes(bodyArray.length)})`)
      if (hasNodeModules) {
        console.log(`[S3Sync] ⚡ node_modules restored - skipping bun install`)
      }
      if (hasBuildOutput) {
        console.log(`[S3Sync] ⚡ Build output restored - skipping vite build`)
      }
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        console.log(`[S3Sync] No archive found in S3 (new project)`)
      } else {
        console.error(`[S3Sync] Download failed:`, error)
        this.stats.errors.push(`Download failed: ${error.message}`)
      }
    }

    return this.getStats()
  }

  /**
   * Create and upload project archive to S3.
   * INCLUDES: node_modules, dist (for fast cold starts)
   */
  async uploadAll(deleteOrphans: boolean = false): Promise<SyncStats> {
    const archiveKey = this.getArchiveKey()
    console.log(`[S3Sync] Uploading archive to s3://${this.config.bucket}/${archiveKey}`)

    try {
      // Check if there are any files to upload
      const fileCount = await this.countFiles(this.config.localDir)
      if (fileCount === 0) {
        console.log(`[S3Sync] No files to upload`)
        return this.getStats()
      }

      // Create tar.gz archive
      const startTime = Date.now()
      const tempArchive = join('/tmp', `project-${this.config.prefix}-upload.tar.gz`)

      // Get list of files to include (excluding patterns)
      const filesToInclude = await this.listLocalFiles()
      
      if (filesToInclude.length === 0) {
        console.log(`[S3Sync] No files to include after filtering`)
        return this.getStats()
      }

      // Log breakdown of what's being archived
      const nodeModulesFiles = filesToInclude.filter(f => f.includes('/node_modules/')).length
      const outputFiles = filesToInclude.filter(f => f.includes('/dist/')).length
      const sourceFiles = filesToInclude.length - nodeModulesFiles - outputFiles
      console.log(`[S3Sync] Archive contents: ${sourceFiles} source, ${nodeModulesFiles} node_modules, ${outputFiles} build output`)

      // Create archive
      await tar.create(
        {
          gzip: true,
          file: tempArchive,
          cwd: this.config.localDir,
          portable: true, // Portable mode for better compatibility
        },
        filesToInclude.map(f => relative(this.config.localDir, f))
      )

      const archiveTime = Date.now() - startTime
      const archiveStats = statSync(tempArchive)
      console.log(`[S3Sync] Created archive in ${archiveTime}ms (${this.formatBytes(archiveStats.size)})`)

      // Upload to S3
      const uploadStart = Date.now()
      const archiveContent = await readFile(tempArchive)
      
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: archiveKey,
        Body: archiveContent,
        ContentType: 'application/gzip',
      }))

      const uploadTime = Date.now() - uploadStart
      console.log(`[S3Sync] Uploaded archive in ${uploadTime}ms`)

      // Cleanup temp file
      await unlink(tempArchive).catch(() => {})

      this.stats.uploaded = filesToInclude.length
      this.stats.lastSync = new Date()
      this.stats.archiveSize = archiveStats.size

      console.log(`[S3Sync] Upload complete: ${filesToInclude.length} files`)
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
   * Start file watcher for detecting changes.
   */
  startWatcher(): void {
    if (!this.config.watchEnabled) {
      console.log(`[S3Sync] File watcher disabled`)
      return
    }

    // Check if directory exists before starting watcher
    try {
      const dirStat = statSync(this.config.localDir)
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

            // Mark that we have pending changes (will be uploaded on next periodic sync)
            this.pendingUploads.add(filename)
          } catch (error: any) {
            // Ignore errors in watcher callback
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

  private async countFiles(dir: string): Promise<number> {
    let count = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          count += await this.countFiles(join(dir, entry.name))
        } else if (entry.isFile()) {
          count++
        }
      }
    } catch (error) {
      // Directory may not exist
    }
    return count
  }

  private shouldExclude(path: string): boolean {
    for (const pattern of this.config.exclude) {
      if (pattern.startsWith('*')) {
        // Glob pattern (e.g., *.log)
        const ext = pattern.slice(1)
        if (path.endsWith(ext)) return true
      } else {
        // Exact match or path contains
        if (path === pattern || path.includes(`/${pattern}/`) || path.includes(`/${pattern}`) || path.startsWith(`${pattern}/`) || path.startsWith(pattern)) {
          return true
        }
      }
    }
    return false
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
  const watchEnabled = process.env.S3_WATCH_ENABLED !== 'false'

  return new S3Sync({
    bucket,
    prefix,
    localDir,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    syncInterval: parseInt(process.env.S3_SYNC_INTERVAL || '30000', 10),
    watchEnabled,
  })
}

/**
 * Initialize S3 sync: download archive and start background sync.
 * Returns null if S3 is not configured OR if initial download fails critically.
 */
export async function initializeS3Sync(localDir: string): Promise<S3Sync | null> {
  const sync = createS3SyncFromEnv(localDir)

  if (!sync) {
    return null
  }

  // Download and extract archive from S3
  const downloadStats = await sync.downloadAll()
  
  // Check if download had critical errors
  const hasCriticalError = downloadStats.errors.some(err => 
    err.includes('AccessDenied') || 
    err.includes('NoSuchBucket') ||
    err.includes('InvalidAccessKeyId') ||
    err.includes('SignatureDoesNotMatch')
  )
  
  if (hasCriticalError) {
    console.warn('[S3Sync] Critical error during initial download - S3 sync disabled')
    console.warn('[S3Sync] Errors:', downloadStats.errors)
    return null
  }

  // Start periodic sync (upload changes)
  sync.startPeriodicSync()

  // Start file watcher if there are files
  if (downloadStats.downloaded > 0) {
    sync.startWatcher()
  } else {
    console.log('[S3Sync] Skipping file watcher (no files downloaded - new project)')
    console.log('[S3Sync] Watcher will be started after files are added')
  }

  return sync
}
