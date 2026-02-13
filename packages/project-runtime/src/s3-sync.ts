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
 * - Upload changed files to S3 periodically (as zip, safety net)
 * - Event-driven sync: file watcher triggers debounced upload on changes
 * - Explicit sync trigger via triggerSync() for critical write operations
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

/** Default debounce delay for event-driven sync (ms) */
const SYNC_DEBOUNCE_MS = 3000

export class S3Sync {
  private client: S3Client
  private config: Omit<Required<S3SyncConfig>, 'endpoint'> & { endpoint?: string }
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
  private isUploading: boolean = false
  private uploadRequestedDuringUpload: boolean = false

  constructor(config: S3SyncConfig) {
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix,
      localDir: config.localDir,
      endpoint: config.endpoint || process.env.S3_ENDPOINT,
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

      // Extract archive
      const extractStart = Date.now()
      
      // For AWS SDK v3, convert the response body to a byte array ONCE
      // (the stream can only be consumed once - calling transformToByteArray twice
      // causes "The stream has already been transformed" error)
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
   *
   * Uses an upload lock to prevent concurrent uploads. If called while an
   * upload is already in progress, it will be re-run after the current upload
   * finishes (to capture any changes made during the upload).
   */
  async uploadAll(deleteOrphans: boolean = false): Promise<SyncStats> {
    // Prevent concurrent uploads - if one is running, flag for re-run after it finishes
    if (this.isUploading) {
      console.log(`[S3Sync] Upload already in progress, will re-run after completion`)
      this.uploadRequestedDuringUpload = true
      return this.getStats()
    }

    this.isUploading = true
    this.uploadRequestedDuringUpload = false

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

      // Clear pending uploads before archiving (any changes after this point
      // will trigger a new debounced sync)
      this.pendingUploads.clear()

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
    } finally {
      this.isUploading = false

      // If another upload was requested while we were uploading, run it now
      if (this.uploadRequestedDuringUpload) {
        this.uploadRequestedDuringUpload = false
        console.log(`[S3Sync] Re-running upload (changes occurred during previous upload)`)
        // Use setImmediate to avoid deep recursion
        setTimeout(() => this.uploadAll(false), 0)
      }
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
   *
   * The watcher triggers a debounced upload on every source file change.
   * This means files are synced to S3 within ~3 seconds of modification,
   * dramatically reducing the data-loss window compared to the 30s periodic sync.
   *
   * The periodic sync (startPeriodicSync) acts as a safety net for any
   * changes the watcher might miss.
   */
  startWatcher(): void {
    if (!this.config.watchEnabled) {
      console.log(`[S3Sync] File watcher disabled`)
      return
    }

    // If watcher is already running, don't start another one
    if (this.watcher) {
      console.log(`[S3Sync] File watcher already running`)
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

    console.log(`[S3Sync] Starting file watcher on ${this.config.localDir} (debounce: ${SYNC_DEBOUNCE_MS}ms)`)

    try {
      this.watcher = watch(
        this.config.localDir,
        { recursive: true },
        (eventType, filename) => {
          try {
            if (!filename || this.shouldExclude(filename)) return

            // Skip node_modules and dist changes for debounced sync triggers.
            // These are large directories that change during bun install / vite build,
            // not during AI file edits. They'll be captured by the periodic sync.
            if (filename.startsWith('node_modules/') || filename.startsWith('dist/')) return

            // Mark that we have pending changes
            this.pendingUploads.add(filename)

            // Debounced upload: resets on every change, fires SYNC_DEBOUNCE_MS
            // after the last change. This batches rapid successive writes
            // (e.g., AI writing multiple files) into a single upload.
            if (this.uploadDebounceTimer) {
              clearTimeout(this.uploadDebounceTimer)
            }
            this.uploadDebounceTimer = setTimeout(() => {
              const pendingCount = this.pendingUploads.size
              if (pendingCount > 0) {
                console.log(`[S3Sync] 📦 File changes detected (${pendingCount} files), triggering sync...`)
                this.uploadAll(false).catch(err => {
                  console.error(`[S3Sync] Debounced upload failed:`, err)
                })
              }
            }, SYNC_DEBOUNCE_MS)
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
   * Explicitly trigger an S3 sync (debounced).
   *
   * Call this after critical file write operations (e.g., template copy,
   * agent file writes, build output) to ensure changes are persisted promptly.
   * Uses the same debounce mechanism as the file watcher to batch rapid calls.
   *
   * @param immediate - If true, skips debounce and uploads immediately.
   */
  triggerSync(immediate: boolean = false): void {
    if (immediate) {
      console.log(`[S3Sync] 📦 Immediate sync triggered`)
      this.uploadAll(false).catch(err => {
        console.error(`[S3Sync] Immediate sync failed:`, err)
      })
      return
    }

    // Debounced trigger (same as watcher)
    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
    }
    this.uploadDebounceTimer = setTimeout(() => {
      console.log(`[S3Sync] 📦 Explicit sync triggered`)
      this.uploadAll(false).catch(err => {
        console.error(`[S3Sync] Explicit sync upload failed:`, err)
      })
    }, SYNC_DEBOUNCE_MS)
  }

  /**
   * Get sync statistics.
   */
  getStats(): SyncStats {
    return { ...this.stats }
  }

  /**
   * Check if there are pending changes waiting to be synced.
   */
  hasPendingChanges(): boolean {
    return this.pendingUploads.size > 0 || this.uploadDebounceTimer !== null
  }

  /**
   * Shutdown: stop all timers and watchers.
   */
  shutdown(): void {
    this.stopPeriodicSync()
    this.stopWatcher()
    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
      this.uploadDebounceTimer = null
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
 *
 * CRITICAL: If the download fails for ANY reason (not just auth errors),
 * we must NOT start the uploader/watcher. Otherwise, the default template
 * files get uploaded to S3, overwriting the user's actual project data.
 *
 * Starts both periodic sync (30s safety net) and file watcher (debounced event-driven sync).
 * The watcher is started for ALL projects, including new ones, to catch the first
 * file writes (e.g., template copy, AI code generation).
 */
export async function initializeS3Sync(localDir: string): Promise<{ sync: S3Sync, downloadSucceeded: boolean } | null> {
  const sync = createS3SyncFromEnv(localDir)

  if (!sync) {
    return null
  }

  // Download and extract archive from S3
  const downloadStats = await sync.downloadAll()
  
  // If there were ANY download errors, do NOT start uploading.
  // This prevents the catastrophic scenario where:
  // 1. Download fails (e.g., stream error, network issue)
  // 2. Entrypoint has already copied the default template
  // 3. Watcher detects template files and uploads them to S3
  // 4. User's actual project data in S3 gets overwritten with template
  if (downloadStats.errors.length > 0) {
    console.warn('[S3Sync] Download had errors - starting sync in UPLOAD-ONLY-AFTER-DELAY mode')
    console.warn('[S3Sync] Errors:', downloadStats.errors)
    
    // Check if these are permission/config errors (completely disable sync)
    const hasCriticalError = downloadStats.errors.some(err => 
      err.includes('AccessDenied') || 
      err.includes('NoSuchBucket') ||
      err.includes('InvalidAccessKeyId') ||
      err.includes('SignatureDoesNotMatch')
    )
    
    if (hasCriticalError) {
      console.warn('[S3Sync] Critical auth/config error - S3 sync completely disabled')
      return null
    }
    
    // For non-critical errors (stream errors, network issues):
    // Return the sync instance but DON'T start watcher/periodic sync yet.
    // The caller (server.ts) should retry the download or start sync later
    // after verifying the project state is correct.
    console.warn('[S3Sync] Non-critical download error - sync instance created but NOT started')
    console.warn('[S3Sync] Caller must explicitly start sync after verifying project state')
    return { sync, downloadSucceeded: false }
  }

  // Download succeeded (or no archive existed for new project) - safe to start sync
  const isNewProject = downloadStats.downloaded === 0

  // Start periodic sync (30s safety net - catches anything the watcher misses)
  sync.startPeriodicSync()

  // Always start file watcher - including for new projects.
  // This ensures the first file writes (template copy, AI code generation)
  // trigger an immediate debounced sync to S3, rather than waiting up to 30s.
  sync.startWatcher()

  if (isNewProject) {
    console.log('[S3Sync] New project - watcher will capture first file writes')
  }

  return { sync, downloadSucceeded: true }
}
