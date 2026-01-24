/**
 * PostgreSQL S3 Backup Module
 *
 * Provides backup/restore functionality for PostgreSQL using S3 storage.
 * Used to persist postgres data when using emptyDir volumes.
 *
 * Pattern:
 * 1. On startup: Download and restore pg_dump from S3 (if exists)
 * 2. Periodically: Run pg_dump and upload to S3
 * 3. On shutdown (SIGTERM): Run final pg_dump to S3
 *
 * This allows postgres to run with emptyDir (no PVC needed),
 * avoiding EBS multi-attach and EFS permission issues.
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { spawn, execSync } from 'child_process'
import { writeFile, readFile, mkdir, unlink, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

// =============================================================================
// Types
// =============================================================================

export interface PostgresBackupConfig {
  /** S3 bucket for backups */
  bucket: string
  /** Project ID (used as S3 prefix) */
  projectId: string
  /** PostgreSQL connection details */
  pgHost?: string
  pgPort?: number
  pgUser?: string
  pgPassword?: string
  pgDatabase?: string
  /** S3 endpoint (for MinIO) */
  s3Endpoint?: string
  /** S3 region */
  s3Region?: string
  /** Backup interval in milliseconds (default: 600000 = 10 minutes) */
  backupInterval?: number
  /** Local data directory */
  dataDir?: string
}

// =============================================================================
// PostgreSQL S3 Backup Class
// =============================================================================

export class PostgresBackup {
  private client: S3Client
  private config: Required<PostgresBackupConfig>
  private backupTimer: ReturnType<typeof setInterval> | null = null
  private isShuttingDown = false
  private lastBackupTime: Date | null = null

  constructor(config: PostgresBackupConfig) {
    this.config = {
      bucket: config.bucket,
      projectId: config.projectId,
      pgHost: config.pgHost || 'localhost',
      pgPort: config.pgPort || 5432,
      pgUser: config.pgUser || process.env.POSTGRES_USER || 'shogo',
      pgPassword: config.pgPassword || process.env.POSTGRES_PASSWORD || 'shogo',
      pgDatabase: config.pgDatabase || process.env.POSTGRES_DB || 'project',
      s3Endpoint: config.s3Endpoint || process.env.S3_ENDPOINT || undefined,
      s3Region: config.s3Region || process.env.S3_REGION || 'us-east-1',
      backupInterval: config.backupInterval || 600000, // 10 minutes default
      dataDir: config.dataDir || '/var/lib/postgresql/data',
    }

    this.client = new S3Client({
      region: this.config.s3Region,
      endpoint: this.config.s3Endpoint,
      forcePathStyle: !!this.config.s3Endpoint,
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      } : undefined,
    })

    console.log(`[PostgresBackup] Initialized for project ${this.config.projectId}`)
    console.log(`[PostgresBackup] Bucket: ${this.config.bucket}`)
    console.log(`[PostgresBackup] Backup interval: ${this.config.backupInterval}ms`)
  }

  /**
   * Get the S3 key for the backup file.
   */
  private getBackupKey(): string {
    return `postgres-backups/${this.config.projectId}/backup.sql.gz`
  }

  /**
   * Get the local path for temporary dump file.
   */
  private getLocalDumpPath(): string {
    return `/tmp/pg_backup_${this.config.projectId}.sql.gz`
  }

  /**
   * Check if a backup exists in S3.
   */
  async backupExists(): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: this.getBackupKey(),
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
   * Download backup from S3.
   */
  async downloadBackup(): Promise<string | null> {
    const key = this.getBackupKey()
    const localPath = this.getLocalDumpPath()

    try {
      console.log(`[PostgresBackup] Downloading backup from s3://${this.config.bucket}/${key}`)

      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }))

      const body = await response.Body?.transformToByteArray()
      if (!body) {
        console.log(`[PostgresBackup] No backup found in S3`)
        return null
      }

      await mkdir(dirname(localPath), { recursive: true })
      await writeFile(localPath, body)

      console.log(`[PostgresBackup] Downloaded backup to ${localPath} (${body.length} bytes)`)
      return localPath
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        console.log(`[PostgresBackup] No backup found in S3 (new project)`)
        return null
      }
      console.error(`[PostgresBackup] Failed to download backup:`, error.message)
      throw error
    }
  }

  /**
   * Restore database from a dump file.
   * Must be called after postgres is running.
   */
  async restoreFromDump(dumpPath: string): Promise<void> {
    console.log(`[PostgresBackup] Restoring database from ${dumpPath}`)

    const env = {
      ...process.env,
      PGHOST: this.config.pgHost,
      PGPORT: this.config.pgPort.toString(),
      PGUSER: this.config.pgUser,
      PGPASSWORD: this.config.pgPassword,
      PGDATABASE: this.config.pgDatabase,
    }

    try {
      // Use gunzip + psql to restore
      // Drop and recreate database to ensure clean state
      execSync(`dropdb --if-exists ${this.config.pgDatabase} || true`, { env, stdio: 'pipe' })
      execSync(`createdb ${this.config.pgDatabase} || true`, { env, stdio: 'pipe' })
      execSync(`gunzip -c ${dumpPath} | psql -q`, { env, stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })

      console.log(`[PostgresBackup] Database restored successfully`)

      // Clean up local dump file
      await unlink(dumpPath).catch(() => {})
    } catch (error: any) {
      console.error(`[PostgresBackup] Restore failed:`, error.message)
      // Don't throw - allow postgres to start with empty database
    }
  }

  /**
   * Create a backup and upload to S3.
   */
  async createBackup(): Promise<boolean> {
    if (this.isShuttingDown) {
      console.log(`[PostgresBackup] Skipping backup - shutdown in progress`)
      return false
    }

    const localPath = this.getLocalDumpPath()
    const key = this.getBackupKey()

    const env = {
      ...process.env,
      PGHOST: this.config.pgHost,
      PGPORT: this.config.pgPort.toString(),
      PGUSER: this.config.pgUser,
      PGPASSWORD: this.config.pgPassword,
    }

    try {
      // Check if postgres is running and accepting connections
      try {
        execSync(`pg_isready -h ${this.config.pgHost} -p ${this.config.pgPort}`, { env, stdio: 'pipe' })
      } catch {
        console.log(`[PostgresBackup] PostgreSQL not ready, skipping backup`)
        return false
      }

      console.log(`[PostgresBackup] Creating backup...`)

      // Create compressed dump
      execSync(`pg_dump ${this.config.pgDatabase} | gzip > ${localPath}`, { 
        env, 
        stdio: 'pipe',
        maxBuffer: 100 * 1024 * 1024 
      })

      // Check if dump file exists and has content
      const stats = await stat(localPath)
      if (stats.size === 0) {
        console.log(`[PostgresBackup] Empty database, skipping upload`)
        await unlink(localPath).catch(() => {})
        return true
      }

      // Upload to S3
      const content = await readFile(localPath)
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: content,
        ContentType: 'application/gzip',
      }))

      this.lastBackupTime = new Date()
      console.log(`[PostgresBackup] Backup uploaded to s3://${this.config.bucket}/${key} (${content.length} bytes)`)

      // Clean up local file
      await unlink(localPath).catch(() => {})

      return true
    } catch (error: any) {
      console.error(`[PostgresBackup] Backup failed:`, error.message)
      // Clean up on failure
      await unlink(localPath).catch(() => {})
      return false
    }
  }

  /**
   * Start periodic backups.
   */
  startPeriodicBackup(): void {
    if (this.config.backupInterval <= 0) {
      console.log(`[PostgresBackup] Periodic backup disabled`)
      return
    }

    console.log(`[PostgresBackup] Starting periodic backup every ${this.config.backupInterval / 1000}s`)

    this.backupTimer = setInterval(async () => {
      await this.createBackup()
    }, this.config.backupInterval)
  }

  /**
   * Stop periodic backups.
   */
  stopPeriodicBackup(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer)
      this.backupTimer = null
      console.log(`[PostgresBackup] Periodic backup stopped`)
    }
  }

  /**
   * Perform final backup on shutdown.
   */
  async shutdown(): Promise<void> {
    console.log(`[PostgresBackup] Shutdown initiated - performing final backup`)
    this.isShuttingDown = true
    this.stopPeriodicBackup()

    // Perform final backup
    await this.createBackup()

    console.log(`[PostgresBackup] Shutdown complete`)
  }

  /**
   * Get last backup time.
   */
  getLastBackupTime(): Date | null {
    return this.lastBackupTime
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create PostgresBackup instance from environment variables.
 */
export function createPostgresBackupFromEnv(): PostgresBackup | null {
  const bucket = process.env.S3_WORKSPACES_BUCKET
  const projectId = process.env.PROJECT_ID

  if (!bucket || !projectId) {
    console.log('[PostgresBackup] S3 backup not configured (S3_WORKSPACES_BUCKET or PROJECT_ID not set)')
    return null
  }

  // Check if postgres backup is enabled
  if (process.env.POSTGRES_S3_BACKUP_ENABLED === 'false') {
    console.log('[PostgresBackup] Postgres S3 backup disabled via POSTGRES_S3_BACKUP_ENABLED=false')
    return null
  }

  return new PostgresBackup({
    bucket,
    projectId,
    backupInterval: parseInt(process.env.POSTGRES_BACKUP_INTERVAL || '60000', 10),
  })
}

/**
 * Wait for postgres to be ready.
 */
export async function waitForPostgres(
  host: string = 'localhost',
  port: number = 5432,
  timeoutMs: number = 60000
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    try {
      execSync(`pg_isready -h ${host} -p ${port}`, { stdio: 'pipe' })
      console.log(`[PostgresBackup] PostgreSQL is ready`)
      return true
    } catch {
      // Not ready yet
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  console.error(`[PostgresBackup] PostgreSQL did not become ready within ${timeoutMs}ms`)
  return false
}

/**
 * Initialize postgres backup: restore from S3 if exists, start periodic backup.
 * Should be called after postgres is running.
 */
export async function initializePostgresBackup(): Promise<PostgresBackup | null> {
  const backup = createPostgresBackupFromEnv()
  if (!backup) {
    return null
  }

  // Wait for postgres to be ready
  const ready = await waitForPostgres()
  if (!ready) {
    console.error('[PostgresBackup] Failed to connect to PostgreSQL - backup disabled')
    return null
  }

  // Check if backup exists and restore it
  const exists = await backup.backupExists()
  if (exists) {
    const dumpPath = await backup.downloadBackup()
    if (dumpPath) {
      await backup.restoreFromDump(dumpPath)
    }
  } else {
    console.log('[PostgresBackup] No existing backup found - starting fresh')
  }

  // Start periodic backups
  backup.startPeriodicBackup()

  // Register shutdown handler
  const shutdownHandler = async () => {
    await backup.shutdown()
  }

  process.on('SIGTERM', shutdownHandler)
  process.on('SIGINT', shutdownHandler)

  return backup
}
