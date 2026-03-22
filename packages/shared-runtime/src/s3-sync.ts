// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * S3 Sync Module (Layered Archive)
 *
 * Provides bidirectional file synchronization between S3 and local filesystem.
 * Uses a TWO-LAYER archive strategy to make cold starts near-instant:
 *
 * Layer 1: deps archive (node_modules/)
 *   - Keyed by hash of bun.lock (content-addressed)
 *   - Only re-uploaded when dependencies change
 *   - Shared across pod restarts with same lockfile
 *   - ~150-200MB compressed, but rarely changes
 *
 * Layer 2: project archive (source + dist + config)
 *   - Everything EXCEPT node_modules
 *   - Small (~2-10MB), updated frequently
 *   - Fast to create and extract (<2s)
 *
 * Cold start performance:
 *   Before: Download 162MB tar.gz → Extract 37K files → 72s
 *   After:  Download ~5MB tar.gz → Extract ~300 files → <2s
 *           (node_modules cached by lockfile hash, usually already present)
 *
 * Features:
 * - Content-addressed deps caching (hash of bun.lock)
 * - Small project archive for fast sync
 * - Event-driven sync: file watcher triggers debounced upload on changes
 * - Explicit sync trigger via triggerSync() for critical write operations
 * - Backward compatible: reads legacy project.tar.gz if layered archives missing
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { watch } from 'fs'
import { readdir, readFile, writeFile, mkdir, stat, unlink, rm } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { existsSync, statSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
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
  /** Whether deps were restored from cache */
  depsCacheHit?: boolean
  /** Time to extract project archive (ms) */
  projectExtractMs?: number
  /** Time to extract deps archive (ms) */
  depsExtractMs?: number
}

// =============================================================================
// S3 Sync Class (Layered Archive)
// =============================================================================

/** Default debounce delay for event-driven sync (ms) */
const SYNC_DEBOUNCE_MS = 3000

/** S3 key prefix for deps archives (shared across projects) */
const DEPS_CACHE_PREFIX = '_deps-cache'

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
  /** Track the current lockfile hash to detect dep changes */
  private currentLockfileHash: string = ''
  /** Whether deps need to be uploaded (lockfile changed since last deps upload) */
  private depsNeedUpload: boolean = false

  constructor(config: S3SyncConfig) {
    this.config = {
      bucket: config.bucket,
      prefix: config.prefix,
      localDir: config.localDir,
      endpoint: config.endpoint || process.env.S3_ENDPOINT,
      region: config.region || process.env.S3_REGION || 'us-east-1',
      forcePathStyle: config.forcePathStyle ?? (process.env.S3_FORCE_PATH_STYLE === 'true'),
      // Exclude patterns - these won't be included in archives
      exclude: config.exclude || [
        '.DS_Store',
        '*.log',
        'playwright-report',
        'test-results',
        'project/node_modules',
        '.bun',
        '.npm',
        '.cache',
      ],
      syncInterval: config.syncInterval ?? 30000, // 30 seconds default
      watchEnabled: config.watchEnabled ?? true,
    }

    this.client = new S3Client({
      region: this.config.region,
      ...(this.config.endpoint && {
        endpoint: this.config.endpoint,
        forcePathStyle: true,
      }),
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
  // S3 Key Helpers
  // ===========================================================================

  /** Legacy single-archive key (for backward compatibility) */
  private getLegacyArchiveKey(): string {
    return `${this.config.prefix}/project.tar.gz`
  }

  /** Project archive key (source + dist, no node_modules) */
  private getProjectArchiveKey(): string {
    return `${this.config.prefix}/project-src.tar.gz`
  }

  /** Deps archive key (content-addressed by lockfile hash) */
  private getDepsArchiveKey(lockfileHash: string): string {
    return `${DEPS_CACHE_PREFIX}/${lockfileHash}.tar.gz`
  }

  /** Per-project pointer to the current deps hash */
  private getDepsPointerKey(): string {
    return `${this.config.prefix}/deps-hash.txt`
  }

  // ===========================================================================
  // Lockfile Hashing
  // ===========================================================================

  /** Compute SHA-256 hash of bun.lock (or package-lock.json / yarn.lock) */
  private async computeLockfileHash(): Promise<string> {
    const lockFiles = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock']
    
    for (const lockFile of lockFiles) {
      const lockPath = join(this.config.localDir, lockFile)
      try {
        const content = await readFile(lockPath)
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
        return hash
      } catch {
        // Try next lockfile
      }
    }
    
    // Fallback: hash package.json dependencies
    try {
      const pkgPath = join(this.config.localDir, 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
      const depsKey = JSON.stringify({
        dependencies: pkg.dependencies || {},
        devDependencies: pkg.devDependencies || {},
      })
      return createHash('sha256').update(depsKey).digest('hex').slice(0, 16)
    } catch {
      // No lockfile and no package.json — use a static key
      return 'no-lockfile'
    }
  }

  // ===========================================================================
  // Archive Existence Checks
  // ===========================================================================

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }))
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }

  // ===========================================================================
  // Download (Layered)
  // ===========================================================================

  /**
   * Download and extract project from S3 using layered archives.
   * 
   * Strategy:
   * 1. Try to download project-src.tar.gz (new layered format)
   * 2. If found, also restore deps from content-addressed cache
   * 3. If not found, fall back to legacy project.tar.gz (full archive)
   * 
   * This provides backward compatibility while enabling fast cold starts
   * for projects that have been synced with the new format.
   */
  async downloadAll(): Promise<SyncStats> {
    const totalStart = Date.now()

    try {
      // Step 1: Try new layered format first
      const projectKey = this.getProjectArchiveKey()
      console.log(`[S3Sync] [downloadAll] Checking for layered archive: s3://${this.config.bucket}/${projectKey}`)
      const checkLayeredStart = Date.now()
      const hasLayeredArchive = await this.objectExists(projectKey)
      console.log(`[S3Sync] [downloadAll] Layered archive check: ${hasLayeredArchive ? 'EXISTS' : 'NOT FOUND'} (${Date.now() - checkLayeredStart}ms)`)

      if (hasLayeredArchive) {
        return await this.downloadLayered(totalStart)
      }

      // Step 2: Fall back to legacy format
      const legacyKey = this.getLegacyArchiveKey()
      console.log(`[S3Sync] [downloadAll] Checking for legacy archive: s3://${this.config.bucket}/${legacyKey}`)
      const checkLegacyStart = Date.now()
      const hasLegacyArchive = await this.objectExists(legacyKey)
      console.log(`[S3Sync] [downloadAll] Legacy archive check: ${hasLegacyArchive ? 'EXISTS' : 'NOT FOUND'} (${Date.now() - checkLegacyStart}ms)`)

      if (hasLegacyArchive) {
        console.log(`[S3Sync] Using legacy archive format (will migrate on next upload)`)
        return await this.downloadLegacy(totalStart)
      }

      // No archive at all — new project
      console.log(`[S3Sync] [downloadAll] No archive found in S3 (new project) — total check time: ${Date.now() - totalStart}ms`)
      return this.getStats()

    } catch (error: any) {
      console.error(`[S3Sync] [downloadAll] Download failed after ${Date.now() - totalStart}ms:`, error)
      this.stats.errors.push(`Download failed: ${error.message}`)
      return this.getStats()
    }
  }

  /**
   * Download using new layered format:
   * 1. Download project-src.tar.gz (small, always)
   * 2. Check deps-hash pointer → download cached deps archive if available
   */
  private async downloadLayered(totalStart: number): Promise<SyncStats> {
    console.log(`[S3Sync] [downloadLayered] ⚡ Using layered archive format (localDir=${this.config.localDir})`)

    if (!existsSync(this.config.localDir)) {
      mkdirSync(this.config.localDir, { recursive: true })
    }

    // Step 1: Download project archive (source + dist)
    const projectStart = Date.now()
    const projectKey = this.getProjectArchiveKey()
    console.log(`[S3Sync] [downloadLayered] Step 1/2: Downloading project archive from s3://${this.config.bucket}/${projectKey}`)

    const projectResponse = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: projectKey,
    }))
    const s3ResponseMs = Date.now() - projectStart
    console.log(`[S3Sync] [downloadLayered] S3 GetObject response received in ${s3ResponseMs}ms (contentLength=${projectResponse.ContentLength ?? 'unknown'})`)

    if (!projectResponse.Body) {
      console.log(`[S3Sync] [downloadLayered] Empty project archive response — aborting`)
      return this.getStats()
    }

    const streamStart = Date.now()
    const projectData = await projectResponse.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const projectDownloadMs = Date.now() - projectStart
    console.log(`[S3Sync] [downloadLayered] Project archive downloaded: ${this.formatBytes(projectData.length)} in ${projectDownloadMs}ms (stream read: ${streamMs}ms)`)

    // Extract project archive
    const extractStart = Date.now()
    const tempProject = join('/tmp', `project-${this.config.prefix}-src.tar.gz`)
    console.log(`[S3Sync] [downloadLayered] Writing temp file and extracting project archive...`)
    await writeFile(tempProject, projectData)
    const writeMs = Date.now() - extractStart
    await tar.extract({ file: tempProject, cwd: this.config.localDir, strip: 0 })
    const projectExtractMs = Date.now() - extractStart
    console.log(`[S3Sync] [downloadLayered] Project archive extracted in ${projectExtractMs}ms (write: ${writeMs}ms, tar extract: ${projectExtractMs - writeMs}ms)`)
    await unlink(tempProject).catch(() => {})
    this.stats.projectExtractMs = projectExtractMs

    // Step 2: Restore deps from cache
    const depsStart = Date.now()
    console.log(`[S3Sync] [downloadLayered] Step 2/2: Restoring deps from cache...`)
    await this.restoreDeps()
    console.log(`[S3Sync] [downloadLayered] Deps restore completed in ${Date.now() - depsStart}ms`)

    const totalMs = Date.now() - totalStart
    const countStart = Date.now()
    const projectFileCount = await this.countFilesExcluding(this.config.localDir, ['node_modules'])
    const totalFileCount = await this.countFiles(this.config.localDir)
    const countMs = Date.now() - countStart
    
    this.stats.downloaded = totalFileCount
    this.stats.lastSync = new Date()
    this.stats.archiveSize = projectData.length

    console.log(`[S3Sync] [downloadLayered] ⚡ COMPLETE in ${totalMs}ms — ${projectFileCount} source files, ${totalFileCount} total (file count took ${countMs}ms)`)
    console.log(`[S3Sync] [downloadLayered] Breakdown: s3Response=${s3ResponseMs}ms, streamRead=${streamMs}ms, extract=${projectExtractMs}ms, deps=${Date.now() - depsStart}ms`)
    return this.getStats()
  }

  /**
   * Restore node_modules from content-addressed deps cache.
   */
  private async restoreDeps(): Promise<void> {
    const restoreStart = Date.now()
    const pointerKey = this.getDepsPointerKey()
    let lockfileHash: string | null = null

    console.log(`[S3Sync] [restoreDeps] Reading deps pointer: s3://${this.config.bucket}/${pointerKey}`)
    const pointerStart = Date.now()
    try {
      const pointerResponse = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: pointerKey,
      }))
      if (pointerResponse.Body) {
        lockfileHash = (await pointerResponse.Body.transformToString()).trim()
      }
      console.log(`[S3Sync] [restoreDeps] Deps pointer read in ${Date.now() - pointerStart}ms (hash=${lockfileHash ?? 'null'})`)
    } catch (error: any) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) {
        console.warn(`[S3Sync] [restoreDeps] Error reading deps pointer (${Date.now() - pointerStart}ms):`, error.message)
      } else {
        console.log(`[S3Sync] [restoreDeps] Deps pointer not found (404) in ${Date.now() - pointerStart}ms`)
      }
    }

    if (!lockfileHash) {
      console.log(`[S3Sync] [restoreDeps] No deps cache pointer — will need bun install (total: ${Date.now() - restoreStart}ms)`)
      return
    }

    // Check if node_modules already exists and matches
    const localHash = await this.computeLockfileHash()
    if (localHash === lockfileHash && existsSync(join(this.config.localDir, 'node_modules', '.package-lock.json')) ||
        existsSync(join(this.config.localDir, 'node_modules', '.cache'))) {
      console.log(`[S3Sync] [restoreDeps] node_modules already present from previous extract — skipping download`)
    }

    // Download deps archive
    const depsKey = this.getDepsArchiveKey(lockfileHash)
    console.log(`[S3Sync] [restoreDeps] Checking deps archive existence: s3://${this.config.bucket}/${depsKey}`)
    const existsStart = Date.now()
    const depsExists = await this.objectExists(depsKey)
    console.log(`[S3Sync] [restoreDeps] Deps archive exists check: ${depsExists} (${Date.now() - existsStart}ms)`)

    if (!depsExists) {
      console.log(`[S3Sync] [restoreDeps] Deps cache miss (hash: ${lockfileHash}) — will need bun install (total: ${Date.now() - restoreStart}ms)`)
      return
    }

    console.log(`[S3Sync] [restoreDeps] ⚡ Deps cache hit (hash: ${lockfileHash}) — downloading...`)
    const depsStart = Date.now()

    const depsResponse = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: depsKey,
    }))
    const s3ResponseMs = Date.now() - depsStart
    console.log(`[S3Sync] [restoreDeps] S3 GetObject response in ${s3ResponseMs}ms (contentLength=${depsResponse.ContentLength ?? 'unknown'})`)

    if (!depsResponse.Body) {
      console.log(`[S3Sync] [restoreDeps] Empty deps response — skipping`)
      return
    }

    const streamStart = Date.now()
    const depsData = await depsResponse.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const downloadMs = Date.now() - depsStart
    console.log(`[S3Sync] [restoreDeps] Downloaded deps archive: ${this.formatBytes(depsData.length)} in ${downloadMs}ms (stream read: ${streamMs}ms)`)

    // Extract deps
    const extractStart = Date.now()
    const tempDeps = join('/tmp', `deps-${lockfileHash}.tar.gz`)
    console.log(`[S3Sync] [restoreDeps] Extracting deps archive (${this.formatBytes(depsData.length)})...`)
    await writeFile(tempDeps, depsData)
    const writeMs = Date.now() - extractStart
    await tar.extract({ file: tempDeps, cwd: this.config.localDir, strip: 0 })
    const extractMs = Date.now() - extractStart
    console.log(`[S3Sync] [restoreDeps] Deps extracted in ${extractMs}ms (write: ${writeMs}ms, tar: ${extractMs - writeMs}ms)`)
    await unlink(tempDeps).catch(() => {})

    this.stats.depsCacheHit = true
    this.stats.depsExtractMs = extractMs
    this.currentLockfileHash = lockfileHash

    console.log(`[S3Sync] [restoreDeps] ⚡ COMPLETE in ${Date.now() - restoreStart}ms (download=${downloadMs}ms, extract=${extractMs}ms)`)
  }

  /**
   * Download using legacy single-archive format (backward compatibility).
   */
  private async downloadLegacy(totalStart: number): Promise<SyncStats> {
    const archiveKey = this.getLegacyArchiveKey()
    console.log(`[S3Sync] [downloadLegacy] Downloading legacy archive from s3://${this.config.bucket}/${archiveKey}`)

    const s3Start = Date.now()
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: archiveKey,
    }))
    const s3ResponseMs = Date.now() - s3Start
    console.log(`[S3Sync] [downloadLegacy] S3 GetObject response in ${s3ResponseMs}ms (contentLength=${response.ContentLength ?? 'unknown'})`)

    if (!response.Body) {
      console.log(`[S3Sync] [downloadLegacy] Empty response from S3 — aborting`)
      return this.getStats()
    }

    const streamStart = Date.now()
    const bodyArray = await response.Body.transformToByteArray()
    const streamMs = Date.now() - streamStart
    const downloadTime = Date.now() - s3Start
    console.log(`[S3Sync] [downloadLegacy] Downloaded archive: ${this.formatBytes(bodyArray.length)} in ${downloadTime}ms (stream read: ${streamMs}ms)`)

    if (!existsSync(this.config.localDir)) {
      mkdirSync(this.config.localDir, { recursive: true })
    }

    const extractStart = Date.now()
    const tempArchive = join('/tmp', `project-${this.config.prefix}.tar.gz`)
    console.log(`[S3Sync] [downloadLegacy] Extracting archive (${this.formatBytes(bodyArray.length)})...`)
    await writeFile(tempArchive, bodyArray)
    const writeMs = Date.now() - extractStart
    await tar.extract({ file: tempArchive, cwd: this.config.localDir, strip: 0 })
    const extractTime = Date.now() - extractStart
    console.log(`[S3Sync] [downloadLegacy] Extracted in ${extractTime}ms (write: ${writeMs}ms, tar: ${extractTime - writeMs}ms)`)
    await unlink(tempArchive).catch(() => {})

    const fileCount = await this.countFiles(this.config.localDir)
    this.stats.downloaded = fileCount
    this.stats.lastSync = new Date()
    this.stats.archiveSize = bodyArray.length

    const totalMs = Date.now() - totalStart
    console.log(`[S3Sync] [downloadLegacy] COMPLETE in ${totalMs}ms: ${fileCount} files (${this.formatBytes(bodyArray.length)})`)

    this.depsNeedUpload = true
    return this.getStats()
  }

  // ===========================================================================
  // Upload (Layered)
  // ===========================================================================

  /**
   * Upload project state to S3 using layered archives.
   *
   * Always uploads: project-src.tar.gz (source + dist, no node_modules)
   * Conditionally uploads: deps archive (only when lockfile hash changes)
   *
   * Uses an upload lock to prevent concurrent uploads.
   */
  async uploadAll(deleteOrphans: boolean = false): Promise<SyncStats> {
    // Prevent concurrent uploads
    if (this.isUploading) {
      console.log(`[S3Sync] Upload already in progress, will re-run after completion`)
      this.uploadRequestedDuringUpload = true
      return this.getStats()
    }

    this.isUploading = true
    this.uploadRequestedDuringUpload = false

    try {
      // Check if there are any files to upload
      const fileCount = await this.countFiles(this.config.localDir)
      if (fileCount === 0) {
        console.log(`[S3Sync] No files to upload`)
        return this.getStats()
      }

      // Upload project archive (source + dist, NO node_modules)
      await this.uploadProjectArchive()

      // Upload deps archive if lockfile changed
      await this.uploadDepsIfNeeded()

      this.stats.lastSync = new Date()

    } catch (error: any) {
      console.error(`[S3Sync] Upload failed:`, error)
      this.stats.errors.push(`Upload failed: ${error.message}`)
    } finally {
      this.isUploading = false

      // Re-run if changes occurred during upload
      if (this.uploadRequestedDuringUpload) {
        this.uploadRequestedDuringUpload = false
        console.log(`[S3Sync] Re-running upload (changes occurred during previous upload)`)
        setTimeout(() => this.uploadAll(false), 0)
      }
    }

    return this.getStats()
  }

  /**
   * Upload project-src.tar.gz (everything EXCEPT node_modules).
   * This is small (~2-10MB) and fast to create.
   * Skips the S3 upload if the archive hash hasn't changed since the last upload.
   */
  private async uploadProjectArchive(): Promise<void> {
    const startTime = Date.now()
    const tempArchive = join('/tmp', `project-${this.config.prefix}-src-upload.tar.gz`)

    // List all files EXCLUDING node_modules
    const filesToInclude = await this.listLocalFiles(undefined, ['node_modules'])

    if (filesToInclude.length === 0) {
      console.log(`[S3Sync] No project files to include after filtering`)
      return
    }

    // Clear pending uploads before archiving
    this.pendingUploads.clear()

    // Create archive
    await tar.create(
      {
        gzip: true,
        file: tempArchive,
        cwd: this.config.localDir,
        portable: true,
      },
      filesToInclude.map(f => relative(this.config.localDir, f))
    )

    const archiveTime = Date.now() - startTime
    const archiveContent = await readFile(tempArchive)
    const archiveSize = archiveContent.length
    console.log(`[S3Sync] Created project archive in ${archiveTime}ms (${this.formatBytes(archiveSize)})`)

    // Hash the archive and skip upload if unchanged
    const archiveHash = createHash('sha256').update(archiveContent).digest('hex')
    if (archiveHash === this.lastUploadHash) {
      console.log(`[S3Sync] Project archive unchanged (hash=${archiveHash.slice(0, 12)}), skipping upload`)
      await unlink(tempArchive).catch(() => {})
      return
    }

    // Upload to S3
    const archiveKey = this.getProjectArchiveKey()
    const uploadStart = Date.now()

    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: archiveKey,
      Body: archiveContent,
      ContentType: 'application/gzip',
    }))

    const uploadTime = Date.now() - uploadStart
    this.lastUploadHash = archiveHash
    console.log(`[S3Sync] Uploaded project archive in ${uploadTime}ms (hash=${archiveHash.slice(0, 12)})`)

    // Cleanup
    await unlink(tempArchive).catch(() => {})

    this.stats.uploaded = filesToInclude.length
    this.stats.archiveSize = archiveSize
  }

  /**
   * Upload deps archive (node_modules/) if lockfile has changed.
   * Uses content-addressed caching: the deps archive key includes the lockfile hash.
   * This means identical lockfiles across different projects share the same deps archive.
   */
  private async uploadDepsIfNeeded(): Promise<void> {
    const lockfileHash = await this.computeLockfileHash()

    // Check if deps already cached for this lockfile hash
    if (lockfileHash === this.currentLockfileHash && !this.depsNeedUpload) {
      // Same lockfile hash — deps archive already in S3
      return
    }

    // Check if this exact deps archive already exists in S3
    const depsKey = this.getDepsArchiveKey(lockfileHash)
    const depsExist = await this.objectExists(depsKey)

    if (depsExist && !this.depsNeedUpload) {
      // Already cached — just update the pointer
      console.log(`[S3Sync] Deps cache already exists for hash ${lockfileHash}, updating pointer`)
      await this.updateDepsPointer(lockfileHash)
      this.currentLockfileHash = lockfileHash
      this.depsNeedUpload = false
      return
    }

    // Check if node_modules exists
    const nodeModulesDir = join(this.config.localDir, 'node_modules')
    if (!existsSync(nodeModulesDir)) {
      return
    }

    console.log(`[S3Sync] Uploading deps archive (lockfile hash: ${lockfileHash})`)
    const startTime = Date.now()
    const tempArchive = join('/tmp', `deps-${lockfileHash}-upload.tar.gz`)

    // List only node_modules files
    const nodeModulesFiles = await this.listLocalFiles(nodeModulesDir)
    if (nodeModulesFiles.length === 0) return

    console.log(`[S3Sync] Deps archive: ${nodeModulesFiles.length} files`)

    // Create archive of node_modules only
    await tar.create(
      {
        gzip: true,
        file: tempArchive,
        cwd: this.config.localDir,
        portable: true,
      },
      // Archive as 'node_modules/...' paths (relative to project dir)
      nodeModulesFiles.map(f => relative(this.config.localDir, f))
    )

    const archiveTime = Date.now() - startTime
    const archiveStats = statSync(tempArchive)
    console.log(`[S3Sync] Created deps archive in ${archiveTime}ms (${this.formatBytes(archiveStats.size)})`)

    // Upload to S3 (content-addressed key)
    const uploadStart = Date.now()
    const archiveContent = await readFile(tempArchive)

    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: depsKey,
      Body: archiveContent,
      ContentType: 'application/gzip',
    }))

    const uploadTime = Date.now() - uploadStart
    console.log(`[S3Sync] Uploaded deps archive in ${uploadTime}ms`)

    // Update the per-project pointer to this deps hash
    await this.updateDepsPointer(lockfileHash)

    // Cleanup
    await unlink(tempArchive).catch(() => {})

    this.currentLockfileHash = lockfileHash
    this.depsNeedUpload = false

    console.log(`[S3Sync] ⚡ Deps cache populated for hash ${lockfileHash}`)
  }

  /** Write the deps hash pointer so downloads know which deps archive to use */
  private async updateDepsPointer(lockfileHash: string): Promise<void> {
    const pointerKey = this.getDepsPointerKey()
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: pointerKey,
      Body: lockfileHash,
      ContentType: 'text/plain',
    }))
  }

  // ===========================================================================
  // Sync Control
  // ===========================================================================

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
   */
  startWatcher(): void {
    if (!this.config.watchEnabled) {
      console.log(`[S3Sync] File watcher disabled`)
      return
    }

    if (this.watcher) {
      console.log(`[S3Sync] File watcher already running`)
      return
    }

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
            // node_modules changes are handled by deps upload (lockfile hash change).
            // dist changes are included in the project archive by periodic sync.
            if (filename.startsWith('node_modules/') || filename.startsWith('dist/')) {
              // But flag deps upload if lockfile changed
              if (filename === 'bun.lock' || filename === 'bun.lockb' || 
                  filename === 'package-lock.json' || filename === 'yarn.lock') {
                this.depsNeedUpload = true
              }
              return
            }

            // Mark that we have pending changes
            this.pendingUploads.add(filename)

            // Debounced upload
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
   */
  triggerSync(immediate: boolean = false): void {
    if (immediate) {
      console.log(`[S3Sync] 📦 Immediate sync triggered`)
      this.uploadAll(false).catch(err => {
        console.error(`[S3Sync] Immediate sync failed:`, err)
      })
      return
    }

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

  /**
   * Flush any pending changes to S3, then shutdown.
   * Use this on SIGTERM to avoid losing recently-written files
   * (e.g., MCP server config) that are still in the debounce window.
   */
  async flushAndShutdown(timeoutMs: number = 10_000): Promise<void> {
    this.stopPeriodicSync()
    this.stopWatcher()

    if (this.uploadDebounceTimer) {
      clearTimeout(this.uploadDebounceTimer)
      this.uploadDebounceTimer = null
    }

    if (!this.hasPendingChanges() && this.pendingUploads.size === 0) {
      console.log(`[S3Sync] flushAndShutdown: no pending changes`)
      return
    }

    console.log(`[S3Sync] flushAndShutdown: flushing pending changes to S3 (timeout ${timeoutMs}ms)...`)
    try {
      const uploadPromise = this.uploadAll(false)
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('flush timeout')), timeoutMs)
      )
      await Promise.race([uploadPromise, timeoutPromise])
      console.log(`[S3Sync] flushAndShutdown: flush complete`)
    } catch (err: any) {
      console.error(`[S3Sync] flushAndShutdown: ${err.message}`)
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * List local files, optionally excluding additional directory prefixes.
   */
  private async listLocalFiles(dir?: string, excludeDirs?: string[]): Promise<string[]> {
    const targetDir = dir || this.config.localDir
    const files: string[] = []

    try {
      const entries = await readdir(targetDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(targetDir, entry.name)
        const relativePath = relative(this.config.localDir, fullPath)

        if (this.shouldExclude(relativePath)) continue

        // Skip excluded directories by name at any depth (e.g. 'node_modules' matches
        // both top-level and nested like 'project/node_modules' or '.npm/_npx/.../node_modules')
        if (excludeDirs && entry.isDirectory() && excludeDirs.includes(entry.name)) {
          continue
        }

        if (entry.isDirectory()) {
          const subFiles = await this.listLocalFiles(fullPath, excludeDirs)
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

  private async countFilesExcluding(dir: string, excludeDirs: string[]): Promise<number> {
    let count = 0
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (excludeDirs.includes(entry.name)) continue
        if (entry.isDirectory()) {
          count += await this.countFilesExcluding(join(dir, entry.name), excludeDirs)
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
        const ext = pattern.slice(1)
        if (path.endsWith(ext)) return true
      } else {
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
    console.log(`[S3Sync] [createFromEnv] Not configured (bucket=${bucket ?? 'unset'}, prefix=${prefix ?? 'unset'})`)
    return null
  }

  const watchEnabled = process.env.S3_WATCH_ENABLED !== 'false'
  const region = process.env.S3_REGION
  const endpoint = process.env.S3_ENDPOINT

  console.log(`[S3Sync] [createFromEnv] Creating S3Sync instance (bucket=${bucket}, prefix=${prefix}, region=${region}, endpoint=${endpoint ?? 'default'}, localDir=${localDir})`)

  return new S3Sync({
    bucket,
    prefix,
    localDir,
    endpoint,
    region,
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
 */
export async function initializeS3Sync(localDir: string): Promise<{ sync: S3Sync, downloadSucceeded: boolean } | null> {
  const initStart = Date.now()
  console.log(`[S3Sync] [initializeS3Sync] Starting (localDir=${localDir})`)
  const sync = createS3SyncFromEnv(localDir)

  if (!sync) {
    console.log(`[S3Sync] [initializeS3Sync] No sync instance created — returning null`)
    return null
  }

  console.log(`[S3Sync] [initializeS3Sync] Calling downloadAll()...`)
  const downloadStart = Date.now()
  const downloadStats = await sync.downloadAll()
  console.log(`[S3Sync] [initializeS3Sync] downloadAll() completed in ${Date.now() - downloadStart}ms (errors=${downloadStats.errors.length}, downloaded=${downloadStats.downloaded})`)

  // If there were ANY download errors, do NOT start uploading.
  if (downloadStats.errors.length > 0) {
    const totalMs = Date.now() - initStart
    console.warn(`[S3Sync] [initializeS3Sync] Download had errors (total: ${totalMs}ms) — sync in UPLOAD-ONLY-AFTER-DELAY mode`)
    console.warn('[S3Sync] [initializeS3Sync] Errors:', downloadStats.errors)

    const hasCriticalError = downloadStats.errors.some(err =>
      err.includes('AccessDenied') ||
      err.includes('NoSuchBucket') ||
      err.includes('InvalidAccessKeyId') ||
      err.includes('SignatureDoesNotMatch')
    )

    if (hasCriticalError) {
      console.warn(`[S3Sync] [initializeS3Sync] Critical auth/config error — S3 sync completely disabled (total: ${totalMs}ms)`)
      return null
    }

    console.warn(`[S3Sync] [initializeS3Sync] Non-critical download error — sync instance created but NOT started (total: ${totalMs}ms)`)
    return { sync, downloadSucceeded: false }
  }

  // Download succeeded — safe to start sync
  const isNewProject = downloadStats.downloaded === 0
  const totalMs = Date.now() - initStart

  sync.startPeriodicSync()
  sync.startWatcher()

  if (isNewProject) {
    console.log(`[S3Sync] [initializeS3Sync] New project — watcher will capture first file writes (total: ${totalMs}ms)`)
  } else {
    console.log(`[S3Sync] [initializeS3Sync] Existing project restored — sync started (${downloadStats.downloaded} files, total: ${totalMs}ms)`)
  }

  return { sync, downloadSucceeded: true }
}
