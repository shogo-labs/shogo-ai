/**
 * S3 I/O helpers for schema and data persistence
 *
 * Provides low-level S3 operations mirroring the filesystem io.ts interface.
 * Used by S3SchemaPersistence and S3Persistence implementations.
 *
 * Environment variables:
 * - SCHEMA_STORAGE=s3 (enable S3 mode)
 * - S3_SCHEMA_BUCKET (required: bucket name)
 * - AWS_REGION (required: AWS region)
 * - S3_SCHEMA_PREFIX (optional: key prefix, defaults to "schemas/")
 * - S3_ENDPOINT (optional: custom endpoint for MinIO/LocalStack)
 * - S3_FORCE_PATH_STYLE (optional: set to "true" for MinIO compatibility)
 * - AWS_ACCESS_KEY_ID (optional: for MinIO/explicit credentials)
 * - AWS_SECRET_ACCESS_KEY (optional: for MinIO/explicit credentials)
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Lazy-initialized S3 clients
let s3Client: S3Client | null = null
let s3PublicClient: S3Client | null = null

/**
 * Get or create the S3 client for internal operations.
 * Lazily initialized to avoid errors when S3 isn't configured.
 *
 * Supports MinIO/LocalStack via S3_ENDPOINT env var.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    const region = process.env.AWS_REGION || 'us-east-1'
    const endpoint = process.env.S3_ENDPOINT
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'

    const config: ConstructorParameters<typeof S3Client>[0] = {
      region,
      // For MinIO/LocalStack: use custom endpoint and path-style addressing
      ...(endpoint && {
        endpoint,
        forcePathStyle: forcePathStyle || !!endpoint, // Default to path style if endpoint is set
      }),
      // For MinIO: explicit credentials (in production, use IAM roles)
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    }

    s3Client = new S3Client(config)
  }
  return s3Client
}

/**
 * Get or create the S3 client for public-facing presigned URLs.
 * Uses S3_PUBLIC_ENDPOINT if set, otherwise falls back to S3_ENDPOINT.
 *
 * This is needed in Docker environments where the internal endpoint (e.g., http://minio:9000)
 * differs from the browser-accessible endpoint (e.g., http://localhost:9000).
 */
export function getS3PublicClient(): S3Client {
  if (!s3PublicClient) {
    const region = process.env.AWS_REGION || 'us-east-1'
    // Prefer public endpoint for browser-accessible URLs, fall back to internal endpoint
    const endpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'

    const config: ConstructorParameters<typeof S3Client>[0] = {
      region,
      ...(endpoint && {
        endpoint,
        forcePathStyle: forcePathStyle || !!endpoint,
      }),
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    }

    s3PublicClient = new S3Client(config)
  }
  return s3PublicClient
}

/**
 * Reset the S3 clients (useful for testing with different configs).
 */
export function resetS3Client(): void {
  s3Client = null
  s3PublicClient = null
}

/**
 * Get the S3 bucket name from environment.
 */
export function getS3Bucket(): string {
  const bucket = process.env.S3_SCHEMA_BUCKET
  if (!bucket) {
    throw new Error('S3_SCHEMA_BUCKET environment variable is required for S3 storage')
  }
  return bucket
}

/**
 * Get the S3 key prefix (defaults to "schemas/").
 */
export function getS3Prefix(): string {
  return process.env.S3_SCHEMA_PREFIX || 'schemas/'
}

/**
 * Check if S3 storage is enabled.
 */
export function isS3Enabled(): boolean {
  return process.env.SCHEMA_STORAGE === 's3'
}

/**
 * Build S3 key from workspace and path components.
 *
 * @example
 * buildS3Key('workspace-123', 'my-schema', 'schema.json')
 * // Returns: "schemas/workspace-123/my-schema/schema.json"
 */
export function buildS3Key(...parts: string[]): string {
  const prefix = getS3Prefix()
  return prefix + parts.join('/')
}

/**
 * Read and parse a JSON file from S3.
 *
 * @throws Error if object doesn't exist or JSON is invalid
 */
export async function readJsonFromS3(key: string): Promise<any> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const response = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }))

  const body = await response.Body?.transformToString()
  if (!body) {
    throw new Error(`Empty response from S3 for key: ${key}`)
  }

  return JSON.parse(body)
}

/**
 * Write data to S3 as JSON.
 */
export async function writeJsonToS3(key: string, data: any): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  }))
}

/**
 * Check if an object exists in S3.
 */
export async function existsInS3(key: string): Promise<boolean> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  try {
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
 * List "directories" (common prefixes) under a given prefix.
 * S3 doesn't have real directories, so this lists common prefixes.
 *
 * @example
 * // Given objects: schemas/ws1/app1/schema.json, schemas/ws1/app2/schema.json
 * listDirsInS3('schemas/ws1/')
 * // Returns: ['app1', 'app2']
 */
export async function listDirsInS3(prefix: string): Promise<string[]> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const response = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/',
  }))

  const dirs: string[] = []
  for (const commonPrefix of response.CommonPrefixes || []) {
    if (commonPrefix.Prefix) {
      // Extract directory name from prefix
      // e.g., "schemas/ws1/app1/" -> "app1"
      const name = commonPrefix.Prefix
        .slice(prefix.length) // Remove parent prefix
        .replace(/\/$/, '')    // Remove trailing slash
      if (name) {
        dirs.push(name)
      }
    }
  }

  return dirs
}

/**
 * List files (objects) under a given prefix.
 *
 * @example
 * listFilesInS3('schemas/ws1/app1/')
 * // Returns: ['schema.json', 'templates/main.njk']
 */
export async function listFilesInS3(prefix: string): Promise<string[]> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  const response = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }))

  const files: string[] = []
  for (const object of response.Contents || []) {
    if (object.Key) {
      // Extract filename from key
      const name = object.Key.slice(prefix.length)
      if (name && !name.includes('/')) {
        files.push(name)
      }
    }
  }

  return files
}

/**
 * Delete an object from S3.
 */
export async function deleteFromS3(key: string): Promise<void> {
  const client = getS3Client()
  const bucket = getS3Bucket()

  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

// ============================================================================
// Pre-signed URL helpers
// ============================================================================

/**
 * Configuration for pre-signed URL generation.
 */
export interface PresignOptions {
  /** Bucket name (overrides default from env) */
  bucket?: string
  /** URL expiration in seconds (default: 3600 = 1 hour) */
  expiresIn?: number
  /** Content type for PUT requests */
  contentType?: string
}

/**
 * Generate a pre-signed URL for reading (GET) an object from S3.
 * The URL can be used directly by browsers to fetch the file.
 *
 * Uses S3_PUBLIC_ENDPOINT for browser-accessible URLs (falls back to S3_ENDPOINT).
 *
 * @param key - S3 object key (full path including any prefix)
 * @param options - Optional configuration
 * @returns Pre-signed URL string
 */
export async function getPresignedReadUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  // Use public client for browser-accessible URLs
  const client = getS3PublicClient()
  const bucket = options.bucket || getS3Bucket()
  const expiresIn = options.expiresIn || 3600

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  })

  // Type assertion needed due to AWS SDK version compatibility issues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSignedUrl(client as any, command, { expiresIn })
}

/**
 * Generate a pre-signed URL for writing (PUT) an object to S3.
 * The URL can be used directly by browsers to upload files.
 *
 * Uses S3_PUBLIC_ENDPOINT for browser-accessible URLs (falls back to S3_ENDPOINT).
 *
 * @param key - S3 object key (full path including any prefix)
 * @param options - Optional configuration
 * @returns Pre-signed URL string
 */
export async function getPresignedWriteUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  // Use public client for browser-accessible URLs
  const client = getS3PublicClient()
  const bucket = options.bucket || getS3Bucket()
  const expiresIn = options.expiresIn || 3600

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(options.contentType && { ContentType: options.contentType }),
  })

  // Type assertion needed due to AWS SDK version compatibility issues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSignedUrl(client as any, command, { expiresIn })
}

/**
 * Read text content directly from S3.
 * Useful for reading non-JSON files like source code.
 *
 * @param key - S3 object key
 * @param bucket - Optional bucket override
 * @returns File contents as string
 */
export async function readTextFromS3(key: string, bucket?: string): Promise<string> {
  const client = getS3Client()
  const effectiveBucket = bucket || getS3Bucket()

  const response = await client.send(new GetObjectCommand({
    Bucket: effectiveBucket,
    Key: key,
  }))

  const body = await response.Body?.transformToString()
  if (body === undefined) {
    throw new Error(`Empty response from S3 for key: ${key}`)
  }

  return body
}

/**
 * Write text content directly to S3.
 * Useful for writing non-JSON files like source code.
 *
 * @param key - S3 object key
 * @param content - Text content to write
 * @param contentType - MIME type (default: text/plain)
 * @param bucket - Optional bucket override
 */
export async function writeTextToS3(
  key: string,
  content: string,
  contentType = 'text/plain',
  bucket?: string
): Promise<void> {
  const client = getS3Client()
  const effectiveBucket = bucket || getS3Bucket()

  await client.send(new PutObjectCommand({
    Bucket: effectiveBucket,
    Key: key,
    Body: content,
    ContentType: contentType,
  }))
}

/**
 * List all objects (files) recursively under a prefix.
 * Unlike listFilesInS3, this includes nested files with their full relative paths.
 *
 * @param prefix - S3 key prefix to list under
 * @param bucket - Optional bucket override
 * @returns Array of object keys relative to the prefix
 */
export async function listAllObjectsInS3(prefix: string, bucket?: string): Promise<Array<{
  key: string
  relativePath: string
  size: number
  lastModified?: Date
}>> {
  const client = getS3Client()
  const effectiveBucket = bucket || getS3Bucket()

  const objects: Array<{
    key: string
    relativePath: string
    size: number
    lastModified?: Date
  }> = []

  let continuationToken: string | undefined

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: effectiveBucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }))

    for (const object of response.Contents || []) {
      if (object.Key) {
        objects.push({
          key: object.Key,
          relativePath: object.Key.slice(prefix.length),
          size: object.Size || 0,
          lastModified: object.LastModified,
        })
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  return objects
}
