/**
 * S3-Backed SQLite Persistence
 *
 * Each workspace gets its own SQLite database file stored in S3.
 * - On workspace init: download SQLite file from S3 (or create new)
 * - On data changes: upload SQLite file back to S3
 *
 * S3 Key Format: {prefix}/{workspaceId}/data.db
 *
 * @example
 * ```ts
 * const sqlite = await S3SqliteManager.getDatabase('project-123')
 * // Use sqlite for queries...
 * await S3SqliteManager.sync('project-123') // Upload to S3
 * ```
 *
 * @module persistence/s3-sqlite
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync, unlinkSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getS3Client,
  getS3Bucket,
  getS3Prefix,
  isS3Enabled,
} from './s3-io'
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { writeFile, readFile } from 'node:fs/promises'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Local cache directory for SQLite files.
 * Each workspace's db is cached locally for performance.
 */
const CACHE_DIR = process.env.SQLITE_CACHE_DIR || join(tmpdir(), 'shogo-sqlite-cache')

/**
 * S3 key suffix for database files
 */
const DB_FILENAME = 'data.db'

// ============================================================================
// Types
// ============================================================================

interface CachedDatabase {
  db: Database
  lastSync: number
  dirty: boolean
}

// ============================================================================
// Singleton Manager
// ============================================================================

/**
 * Manages SQLite databases backed by S3 storage.
 *
 * Features:
 * - Lazy loading: databases are downloaded from S3 on first access
 * - Local caching: databases are cached locally for performance
 * - Dirty tracking: only sync databases that have changes
 * - Automatic sync: optional periodic sync to S3
 */
class S3SqliteManagerClass {
  /**
   * Cache of open databases by workspace ID
   */
  private databases: Map<string, CachedDatabase> = new Map()

  /**
   * Ensure cache directory exists
   */
  private ensureCacheDir(): void {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true })
    }
  }

  /**
   * Get local cache path for a workspace's database
   */
  private getCachePath(workspaceId: string): string {
    return join(CACHE_DIR, `${workspaceId}.db`)
  }

  /**
   * Get S3 key for a workspace's database
   */
  private getS3Key(workspaceId: string): string {
    const prefix = getS3Prefix()
    return `${prefix}${workspaceId}/${DB_FILENAME}`
  }

  /**
   * Check if database exists in S3
   */
  async existsInS3(workspaceId: string): Promise<boolean> {
    if (!isS3Enabled()) return false

    try {
      const client = getS3Client()
      const bucket = getS3Bucket()
      const key = this.getS3Key(workspaceId)

      await client.send(new HeadObjectCommand({
        Bucket: bucket,
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

  /**
   * Download database from S3 to local cache
   */
  private async downloadFromS3(workspaceId: string): Promise<void> {
    this.ensureCacheDir()

    const client = getS3Client()
    const bucket = getS3Bucket()
    const key = this.getS3Key(workspaceId)
    const cachePath = this.getCachePath(workspaceId)

    console.log(`[s3-sqlite] Downloading database for workspace '${workspaceId}' from S3...`)

    const response = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }))

    // Stream response body to file
    const body = await response.Body?.transformToByteArray()
    if (!body) {
      throw new Error(`Empty response from S3 for key: ${key}`)
    }

    await writeFile(cachePath, Buffer.from(body))
    console.log(`[s3-sqlite] Downloaded database to ${cachePath}`)
  }

  /**
   * Upload database from local cache to S3
   */
  private async uploadToS3(workspaceId: string): Promise<void> {
    const client = getS3Client()
    const bucket = getS3Bucket()
    const key = this.getS3Key(workspaceId)
    const cachePath = this.getCachePath(workspaceId)

    console.log(`[s3-sqlite] Uploading database for workspace '${workspaceId}' to S3...`)

    // Read database file
    const data = await readFile(cachePath)

    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: 'application/x-sqlite3',
    }))

    console.log(`[s3-sqlite] Uploaded database to s3://${bucket}/${key}`)
  }

  /**
   * Get or create a SQLite database for a workspace.
   *
   * If S3 is enabled:
   * - Downloads existing database from S3 on first access
   * - Creates new database if none exists in S3
   *
   * If S3 is disabled:
   * - Creates/uses local database file
   *
   * @param workspaceId - Unique workspace/project identifier
   * @returns SQLite Database instance
   */
  async getDatabase(workspaceId: string): Promise<Database> {
    // Return cached database if available
    const cached = this.databases.get(workspaceId)
    if (cached) {
      return cached.db
    }

    this.ensureCacheDir()
    const cachePath = this.getCachePath(workspaceId)

    // If S3 is enabled and database exists in S3, download it
    if (isS3Enabled()) {
      const existsInS3 = await this.existsInS3(workspaceId)
      if (existsInS3 && !existsSync(cachePath)) {
        await this.downloadFromS3(workspaceId)
      }
    }

    // Open or create database
    const db = new Database(cachePath)

    // Enable WAL mode for better concurrent access
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')

    // Cache the database
    this.databases.set(workspaceId, {
      db,
      lastSync: Date.now(),
      dirty: false,
    })

    console.log(`[s3-sqlite] Opened database for workspace '${workspaceId}'`)
    return db
  }

  /**
   * Mark a workspace's database as dirty (has unsaved changes)
   */
  markDirty(workspaceId: string): void {
    const cached = this.databases.get(workspaceId)
    if (cached) {
      cached.dirty = true
    }
  }

  /**
   * Sync a workspace's database to S3 if dirty.
   *
   * @param workspaceId - Workspace to sync
   * @param force - Sync even if not dirty
   * @returns true if sync was performed
   */
  async sync(workspaceId: string, force = false): Promise<boolean> {
    if (!isS3Enabled()) {
      return false
    }

    const cached = this.databases.get(workspaceId)
    if (!cached) {
      return false
    }

    if (!cached.dirty && !force) {
      return false
    }

    // Checkpoint WAL before upload
    cached.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    await this.uploadToS3(workspaceId)

    cached.dirty = false
    cached.lastSync = Date.now()
    return true
  }

  /**
   * Sync all dirty databases to S3.
   *
   * @returns Number of databases synced
   */
  async syncAll(): Promise<number> {
    let count = 0
    for (const [workspaceId] of this.databases) {
      if (await this.sync(workspaceId)) {
        count++
      }
    }
    return count
  }

  /**
   * Close a workspace's database and optionally sync to S3.
   *
   * @param workspaceId - Workspace to close
   * @param syncFirst - Whether to sync to S3 before closing
   */
  async close(workspaceId: string, syncFirst = true): Promise<void> {
    const cached = this.databases.get(workspaceId)
    if (!cached) {
      return
    }

    if (syncFirst) {
      await this.sync(workspaceId, true)
    }

    cached.db.close()
    this.databases.delete(workspaceId)

    console.log(`[s3-sqlite] Closed database for workspace '${workspaceId}'`)
  }

  /**
   * Close all databases and sync to S3.
   */
  async closeAll(): Promise<void> {
    for (const [workspaceId] of this.databases) {
      await this.close(workspaceId, true)
    }
  }

  /**
   * Delete a workspace's database from local cache and S3.
   *
   * @param workspaceId - Workspace to delete
   */
  async delete(workspaceId: string): Promise<void> {
    // Close database first
    await this.close(workspaceId, false)

    // Delete local cache
    const cachePath = this.getCachePath(workspaceId)
    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
    }

    // Delete from S3
    if (isS3Enabled()) {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
      const client = getS3Client()
      const bucket = getS3Bucket()
      const key = this.getS3Key(workspaceId)

      await client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }))
    }

    console.log(`[s3-sqlite] Deleted database for workspace '${workspaceId}'`)
  }

  /**
   * Get list of cached workspace IDs
   */
  getCachedWorkspaces(): string[] {
    return Array.from(this.databases.keys())
  }

  /**
   * Check if a workspace's database is dirty
   */
  isDirty(workspaceId: string): boolean {
    return this.databases.get(workspaceId)?.dirty ?? false
  }

  /**
   * Reset manager state (for testing)
   */
  __resetForTesting(): void {
    for (const [, cached] of this.databases) {
      try {
        cached.db.close()
      } catch { /* ignore */ }
    }
    this.databases.clear()
  }
}

/**
 * Singleton S3 SQLite manager instance
 */
export const S3SqliteManager = new S3SqliteManagerClass()

/**
 * Convenience export for getting a database
 */
export async function getWorkspaceDatabase(workspaceId: string): Promise<Database> {
  return S3SqliteManager.getDatabase(workspaceId)
}

/**
 * Convenience export for syncing a database
 */
export async function syncWorkspaceDatabase(workspaceId: string, force = false): Promise<boolean> {
  return S3SqliteManager.sync(workspaceId, force)
}
