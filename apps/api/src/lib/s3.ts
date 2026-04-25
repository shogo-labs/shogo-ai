// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * S3 I/O helpers for file storage
 *
 * Provides low-level S3 operations for project file storage.
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
 */
export function buildS3Key(...parts: string[]): string {
  const prefix = getS3Prefix()
  return prefix + parts.join('/')
}

/**
 * Read and parse a JSON file from S3.
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
      const name = commonPrefix.Prefix
        .slice(prefix.length)
        .replace(/\/$/, '')
      if (name) {
        dirs.push(name)
      }
    }
  }

  return dirs
}

/**
 * List files (objects) under a given prefix.
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
 */
export async function getPresignedReadUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  const client = getS3PublicClient()
  const bucket = options.bucket || getS3Bucket()
  const expiresIn = options.expiresIn || 3600

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  })

  return getSignedUrl(client, command, { expiresIn })
}

/**
 * Generate a pre-signed URL for writing (PUT) an object to S3.
 */
export async function getPresignedWriteUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  const client = getS3PublicClient()
  const bucket = options.bucket || getS3Bucket()
  const expiresIn = options.expiresIn || 3600

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(options.contentType && { ContentType: options.contentType }),
  })

  return getSignedUrl(client, command, { expiresIn })
}

/**
 * Read text content directly from S3.
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

// ============================================================================
// Artifact S3 — dedicated client/bucket for blockable artifact uploads
// ----------------------------------------------------------------------------
// Phase 4: gives the artifact upload path (thumbnails, voice clips, publish
// bundles) its own env-configurable bucket + endpoint so firewall teams can
// allow/deny artifact traffic independently of schema/project storage.
//
// FULLY BACKWARD COMPATIBLE: if S3_ARTIFACT_* vars are unset, these helpers
// return the exact same clients/bucket the rest of the code already uses.
// ============================================================================

let artifactS3Client: S3Client | null = null
let artifactS3PublicClient: S3Client | null = null

/**
 * Get or create the S3 client for internal artifact writes.
 * Falls back to the default schema S3 client if `S3_ARTIFACT_*` is unset.
 */
export function getArtifactS3Client(): S3Client {
  const hasOverride =
    !!process.env.S3_ARTIFACT_ENDPOINT ||
    !!process.env.S3_ARTIFACT_ACCESS_KEY_ID ||
    !!process.env.S3_ARTIFACT_REGION

  if (!hasOverride) return getS3Client()

  if (!artifactS3Client) {
    const region =
      process.env.S3_ARTIFACT_REGION || process.env.AWS_REGION || 'us-east-1'
    const endpoint = process.env.S3_ARTIFACT_ENDPOINT
    const forcePathStyle =
      (process.env.S3_ARTIFACT_FORCE_PATH_STYLE || process.env.S3_FORCE_PATH_STYLE) === 'true'

    const accessKeyId =
      process.env.S3_ARTIFACT_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey =
      process.env.S3_ARTIFACT_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY

    const config: ConstructorParameters<typeof S3Client>[0] = {
      region,
      ...(endpoint && {
        endpoint,
        forcePathStyle: forcePathStyle || !!endpoint,
      }),
      ...(accessKeyId && secretAccessKey && {
        credentials: { accessKeyId, secretAccessKey },
      }),
    }

    artifactS3Client = new S3Client(config)
  }
  return artifactS3Client
}

/**
 * Get or create the S3 client used when minting public-facing presigned URLs
 * for artifacts. Prefers S3_ARTIFACT_PUBLIC_ENDPOINT > S3_ARTIFACT_ENDPOINT,
 * then falls back to the schema public client.
 */
export function getArtifactS3PublicClient(): S3Client {
  const hasOverride =
    !!process.env.S3_ARTIFACT_PUBLIC_ENDPOINT ||
    !!process.env.S3_ARTIFACT_ENDPOINT ||
    !!process.env.S3_ARTIFACT_ACCESS_KEY_ID

  if (!hasOverride) return getS3PublicClient()

  if (!artifactS3PublicClient) {
    const region =
      process.env.S3_ARTIFACT_REGION || process.env.AWS_REGION || 'us-east-1'
    const endpoint =
      process.env.S3_ARTIFACT_PUBLIC_ENDPOINT || process.env.S3_ARTIFACT_ENDPOINT
    const forcePathStyle =
      (process.env.S3_ARTIFACT_FORCE_PATH_STYLE || process.env.S3_FORCE_PATH_STYLE) === 'true'

    const accessKeyId =
      process.env.S3_ARTIFACT_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey =
      process.env.S3_ARTIFACT_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY

    const config: ConstructorParameters<typeof S3Client>[0] = {
      region,
      ...(endpoint && {
        endpoint,
        forcePathStyle: forcePathStyle || !!endpoint,
      }),
      ...(accessKeyId && secretAccessKey && {
        credentials: { accessKeyId, secretAccessKey },
      }),
    }

    artifactS3PublicClient = new S3Client(config)
  }
  return artifactS3PublicClient
}

/**
 * Reset artifact clients (for tests).
 */
export function resetArtifactS3Client(): void {
  artifactS3Client = null
  artifactS3PublicClient = null
}

/**
 * Bucket for artifact uploads. Falls back to the default schema bucket.
 */
export function getArtifactBucket(): string {
  return process.env.S3_ARTIFACT_BUCKET || getS3Bucket()
}

/**
 * True if artifact storage has been split onto a dedicated bucket/host.
 * Use from health endpoints / observability to know which mode we're in.
 */
export function isArtifactStorageIsolated(): boolean {
  return (
    !!process.env.S3_ARTIFACT_BUCKET ||
    !!process.env.S3_ARTIFACT_ENDPOINT ||
    !!process.env.S3_ARTIFACT_PUBLIC_ENDPOINT
  )
}

/**
 * Build an artifact S3 key with an optional prefix (default: "artifacts/").
 * Kept separate from buildS3Key so schema keys never collide with artifacts.
 */
export function buildArtifactKey(...parts: string[]): string {
  const prefix = process.env.S3_ARTIFACT_PREFIX || 'artifacts/'
  return prefix + parts.join('/')
}

/**
 * Generate a pre-signed URL for READING an artifact.
 * Uses the artifact public client + bucket; falls back transparently when
 * artifact env vars are unset.
 */
export async function getArtifactPresignedReadUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  const client = getArtifactS3PublicClient()
  const bucket = options.bucket || getArtifactBucket()
  const expiresIn = options.expiresIn || 3600

  const command = new GetObjectCommand({ Bucket: bucket, Key: key })
  return getSignedUrl(client, command, { expiresIn })
}

/**
 * Generate a pre-signed URL for WRITING an artifact.
 * Uses the artifact public client + bucket; falls back transparently when
 * artifact env vars are unset.
 */
export async function getArtifactPresignedWriteUrl(
  key: string,
  options: PresignOptions = {}
): Promise<string> {
  const client = getArtifactS3PublicClient()
  const bucket = options.bucket || getArtifactBucket()
  const expiresIn = options.expiresIn || 3600

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(options.contentType && { ContentType: options.contentType }),
  })
  return getSignedUrl(client, command, { expiresIn })
}
