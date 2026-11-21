// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project object storage + CDN (SHO-491).
 *
 * Every project owns a bucket: the agent puts big media in it from its shell
 * (`shogo bucket put|offload`), the app it builds puts it in through the SDK
 * (`shogo.bucket`), and the app links the CDN URL instead of committing
 * gigabytes to git or `public/`.
 *
 * ## Shape
 *
 *   `p/<projectId>/<visibility>/<key>`   cloud: object in `S3_PROJECT_BUCKET`
 *   `<dataDir>/project-buckets/<projectId>/<visibility>/<key>`
 *                                        desktop: a file on disk
 *
 * `ProjectBucketObject` is the index of what is there: `/bucket/objects` lists
 * it, the storage meter counts it under the `bucket` category, and the upload
 * gate prices an upload against the last measurement plus the rows written
 * since (never a live bucket listing).
 *
 * ## Bytes never pass through the API (cloud)
 *
 * `POST /bucket/uploads` answers with a presigned PUT — or, at or above
 * {@link MULTIPART_THRESHOLD_BYTES}, a multipart upload id and one presigned URL
 * per part — and the client streams the bytes straight to object storage.
 * Desktop has no object storage, so the same ticket points at the API's own
 * upload route, which streams the body to disk. Both drivers implement
 * {@link ProjectBucketDriver}, so no caller branches on which one is live.
 *
 * ## Paid by the workspace, expandable (Russell, 2026-11-21)
 *
 * There is no per-project cap. Bucket bytes are part of the workspace's storage
 * allowance (`INSTANCE_SIZES[tier].storageLimitBytes`) and everything above it
 * is billed per GB-month by `jobs/storage-usage-bill.ts` — this card adds no
 * price and no job. An upload over the allowance is allowed when the workspace
 * can pay for it (`checkUsageBalance`); otherwise it is refused with
 * `402 bucket_payment_required`. `shadow` mode never blocks on payment.
 * Local/desktop is unlimited: no metering and no gate.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { prisma } from '../lib/prisma'
import { getS3Client, getS3PublicClient } from '../lib/s3'
import { getFrontendUrl } from '../lib/cloud-urls'
import { mimeTypeForFile } from '../lib/local-file-mime'
import { INSTANCE_SIZES, type InstanceSizeName } from '../config/instance-sizes'
import { STORAGE_USD_PER_GB_MONTH, storageBillingMode, storageDailyUsd } from '../config/storage-pricing'
import { checkUsageBalance, type UsageBlockReason } from './billing.service'

// Keys, layout and multipart thresholds live in `lib/project-bucket-keys.ts` so
// the storage meter can share them without importing this module (and, through
// it, the billing stack). Re-exported here because every caller imports the
// bucket API from this service.
export {
  BUCKET_KEY_MAX_LENGTH,
  BUCKET_PREFIX,
  MULTIPART_MAX_PARTS,
  MULTIPART_PART_SIZE,
  MULTIPART_THRESHOLD_BYTES,
  bucketObjectPath,
  encodePathSegments,
  multipartPartCount,
  normalizeBucketVisibility,
  parseBucketObjectPath,
  projectBucketPrefix,
  shouldUseMultipart,
  validateBucketKey,
  type BucketKeyError,
  type BucketVisibility,
} from '../lib/project-bucket-keys'

import {
  BUCKET_PREFIX,
  MULTIPART_MAX_PARTS,
  MULTIPART_PART_SIZE,
  bucketObjectPath,
  encodePathSegments,
  multipartPartCount,
  normalizeBucketVisibility,
  parseBucketObjectPath,
  projectBucketPrefix,
  shouldUseMultipart,
  validateBucketKey,
  type BucketVisibility,
} from '../lib/project-bucket-keys'

// ---------------------------------------------------------------------------
// Upload tickets
// ---------------------------------------------------------------------------

export interface UploadPartTicket {
  partNumber: number
  url: string
}

export interface UploadTicket {
  /** Opaque token the client hands back to `POST /uploads/:uploadId/complete`. */
  uploadId: string
  key: string
  visibility: BucketVisibility
  mode: 'single' | 'multipart'
  /** Where to PUT the bytes (single mode, and multipart's first part). */
  url: string
  method: 'PUT'
  headers: Record<string, string>
  /** Part URLs, `partSize` bytes each (multipart only). */
  parts?: UploadPartTicket[]
  partSize?: number
  /** `POST` here once every part is uploaded. */
  completeUrl: string
  /** CDN URL for a public object (null for private). */
  publicUrl: string | null
}

/**
 * The stateless upload token: key + visibility (+ the provider's multipart
 * upload id and part count). Nothing is stored server-side between `POST
 * /uploads` and `POST /uploads/:id/complete`, so a restart mid-upload loses
 * nothing, and the token cannot name an object outside the caller's project
 * (the route's auth already pins the project).
 */
export interface UploadToken {
  k: string
  v: BucketVisibility
  /** Provider multipart upload id. */
  u?: string
  /** Part count, so `complete` validates every ETag arrived. */
  n?: number
}

export function encodeUploadToken(token: UploadToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
}

export function decodeUploadToken(raw: string): UploadToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const key = validateBucketKey(parsed?.k)
    if (!key.ok) return null
    return {
      k: key.key,
      v: normalizeBucketVisibility(parsed?.v),
      ...(typeof parsed?.u === 'string' && parsed.u ? { u: parsed.u } : {}),
      ...(typeof parsed?.n === 'number' && parsed.n > 0 ? { n: parsed.n } : {}),
    }
  } catch {
    return null
  }
}

export interface BucketObjectMetadata {
  key: string
  visibility: BucketVisibility
  size: number
  contentType: string | null
  etag: string | null
  sha256: string | null
  updatedAt: string
}

export interface BucketListPage {
  objects: BucketObjectMetadata[]
  /** Opaque cursor for the next page, or null at the end. */
  cursor: string | null
}

export interface BucketReadStream {
  body: ReadableStream<Uint8Array>
  size: number
  contentType: string | null
  /** Set when a `Range` was answered. */
  range: { start: number; end: number } | null
}

/** Raised when a cloud deployment has no project bucket configured. */
export class ProjectBucketNotConfiguredError extends Error {
  readonly code = 'bucket_not_configured'
  constructor() {
    super('Project bucket storage is not configured (S3_PROJECT_BUCKET is unset)')
    this.name = 'ProjectBucketNotConfiguredError'
  }
}

export class BucketObjectMissingError extends Error {
  readonly code = 'object_not_found'
  constructor(key: string) {
    super(`"${key}" was not found in this bucket (the upload may not have finished)`)
    this.name = 'BucketObjectMissingError'
  }
}

export class BucketKeyExistsError extends Error {
  readonly code = 'key_exists'
  constructor(key: string) {
    super(`"${key}" already exists in this bucket; pass overwrite to replace it`)
    this.name = 'BucketKeyExistsError'
  }
}

/**
 * One storage backend. The API, the SDK and the CLI see the same contract on
 * both: only the URL a ticket hands back differs.
 */
export interface ProjectBucketDriver {
  readonly kind: 's3' | 'filesystem'
  createUpload(input: {
    projectId: string
    key: string
    visibility: BucketVisibility
    size: number
    contentType?: string | null
    /** Absolute base URL of the API, for the desktop upload target. */
    apiOrigin: string
  }): Promise<UploadTicket>
  head(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
  ): Promise<{ size: number; etag?: string; contentType?: string } | null>
  /** One page of `<projectIdAndVisibility><prefix>`, keys relative to it. */
  list(
    projectIdAndVisibility: string,
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ objects: Array<{ key: string; size: number }>; cursor: string | null }>
  /** Every object under a full path prefix — teardown proves it is empty. */
  listAll(prefix: string): Promise<Array<{ key: string; size: number }>>
  delete(projectId: string, visibility: BucketVisibility, key: string): Promise<void>
  read(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
    range: { start: number; end: number } | null,
  ): Promise<BucketReadStream | null>
  /** Read URL that needs no credentials: presigned (cloud) or token (desktop). */
  readUrl(projectId: string, visibility: BucketVisibility, key: string, expiresIn: number): Promise<string>
  /** Stream `stream` into the object at `path`. */
  writeObject(
    path: string,
    stream: ReadableStream<Uint8Array> | null,
    contentType?: string | null,
  ): Promise<{ size: number; etag: string | null }>
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

const PRESIGN_EXPIRY_SECONDS = 3600
const SIGNED_READ_EXPIRY_SECONDS = 3600

let projectBucketPublicClient: S3Client | null = null

/**
 * The bucket name: `S3_PROJECT_BUCKET`. Optional, because desktop has no
 * object storage — cloud routes answer `503 bucket_not_configured` rather than
 * pretending an object was stored.
 */
export function getProjectBucketName(): string | null {
  const bucket = (process.env.S3_PROJECT_BUCKET || '').trim()
  return bucket || null
}

/**
 * The client used to mint presigned URLs. Mirrors the artifact pattern: a
 * dedicated public endpoint when `S3_PROJECT_PUBLIC_ENDPOINT` is set (metal
 * guests and browsers cannot resolve the in-cluster host), otherwise the
 * schema bucket's public client.
 */
export function getProjectBucketPublicS3Client(): S3Client {
  const endpoint = (process.env.S3_PROJECT_PUBLIC_ENDPOINT || '').trim()
  if (!endpoint) return getS3PublicClient()
  if (!projectBucketPublicClient) {
    const region = process.env.S3_PROJECT_REGION || process.env.AWS_REGION || 'us-east-1'
    const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'
    const accessKeyId = process.env.S3_PROJECT_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.S3_PROJECT_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY
    projectBucketPublicClient = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      ...(accessKeyId && secretAccessKey && { credentials: { accessKeyId, secretAccessKey } }),
    })
  }
  return projectBucketPublicClient
}

/** Tests mutate the `S3_PROJECT_*` env vars; this drops the cached client. */
export function resetProjectBucketS3Client(): void {
  projectBucketPublicClient = null
}

function requireProjectBucketName(): string {
  const bucket = getProjectBucketName()
  if (!bucket) throw new ProjectBucketNotConfiguredError()
  return bucket
}

class S3ProjectBucketDriver implements ProjectBucketDriver {
  readonly kind = 's3' as const

  async createUpload(input: {
    projectId: string
    key: string
    visibility: BucketVisibility
    size: number
    contentType?: string | null
    apiOrigin: string
  }): Promise<UploadTicket> {
    const bucket = requireProjectBucketName()
    const client = getProjectBucketPublicS3Client()
    const path = bucketObjectPath(input.projectId, input.visibility, input.key)
    const contentType = input.contentType || null
    const headers: Record<string, string> = contentType ? { 'Content-Type': contentType } : {}
    const completeBase = `${input.apiOrigin}/api/projects/${input.projectId}/bucket/uploads`

    if (shouldUseMultipart(input.size)) {
      const partCount = multipartPartCount(input.size)
      if (partCount > MULTIPART_MAX_PARTS) {
        throw new Error(`upload needs ${partCount} parts; the maximum is ${MULTIPART_MAX_PARTS}`)
      }
      const created = await getS3Client().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: path,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      )
      const providerUploadId = created.UploadId
      if (!providerUploadId) throw new Error('object storage returned no multipart upload id')
      const parts: UploadPartTicket[] = []
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const url = await getSignedUrl(
          client,
          new UploadPartCommand({ Bucket: bucket, Key: path, UploadId: providerUploadId, PartNumber: partNumber }),
          { expiresIn: PRESIGN_EXPIRY_SECONDS },
        )
        parts.push({ partNumber, url })
      }
      const token = encodeUploadToken({
        k: input.key,
        v: input.visibility,
        u: providerUploadId,
        n: partCount,
      })
      return {
        uploadId: token,
        key: input.key,
        visibility: input.visibility,
        mode: 'multipart',
        // Multipart callers use `parts`; `url` is the first part so a client
        // that ignores `mode` still fails loudly rather than half-uploading.
        url: parts[0]?.url ?? '',
        method: 'PUT',
        headers,
        parts,
        partSize: MULTIPART_PART_SIZE,
        completeUrl: `${completeBase}/${token}/complete`,
        publicUrl: input.visibility === 'public' ? bucketObjectPublicUrl(input.projectId, input.key) : null,
      }
    }

    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: path, ...(contentType ? { ContentType: contentType } : {}) }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    )
    const token = encodeUploadToken({ k: input.key, v: input.visibility })
    return {
      uploadId: token,
      key: input.key,
      visibility: input.visibility,
      mode: 'single',
      url,
      method: 'PUT',
      headers,
      completeUrl: `${completeBase}/${token}/complete`,
      publicUrl: input.visibility === 'public' ? bucketObjectPublicUrl(input.projectId, input.key) : null,
    }
  }

  async head(projectId: string, visibility: BucketVisibility, key: string) {
    const bucket = requireProjectBucketName()
    try {
      const response = await getS3Client().send(
        new HeadObjectCommand({ Bucket: bucket, Key: bucketObjectPath(projectId, visibility, key) }),
      )
      return {
        size: response.ContentLength ?? 0,
        etag: response.ETag?.replace(/"/g, ''),
        contentType: response.ContentType ?? undefined,
      }
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode
      if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null
      throw error
    }
  }

  async list(projectIdAndVisibility: string, prefix: string, cursor: string | null, limit: number) {
    const bucket = requireProjectBucketName()
    const response = await getS3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${projectIdAndVisibility}${prefix}`,
        MaxKeys: limit,
        ContinuationToken: cursor ?? undefined,
      }),
    )
    const objects = (response.Contents ?? [])
      .filter((object): object is { Key: string; Size?: number } => !!object.Key)
      .map((object) => ({
        key: object.Key.slice(projectIdAndVisibility.length),
        size: object.Size ?? 0,
      }))
    return {
      objects,
      cursor: response.IsTruncated ? response.NextContinuationToken ?? null : null,
    }
  }

  async listAll(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const bucket = requireProjectBucketName()
    const out: Array<{ key: string; size: number }> = []
    let cursor: string | undefined
    do {
      const response = await getS3Client().send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: cursor }),
      )
      for (const object of response.Contents ?? []) {
        if (object.Key) out.push({ key: object.Key, size: object.Size ?? 0 })
      }
      cursor = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (cursor)
    return out
  }

  async delete(projectId: string, visibility: BucketVisibility, key: string): Promise<void> {
    const bucket = requireProjectBucketName()
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: bucketObjectPath(projectId, visibility, key) }),
    )
  }

  async read(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
    range: { start: number; end: number } | null,
  ): Promise<BucketReadStream | null> {
    const bucket = requireProjectBucketName()
    try {
      const response = await getS3Client().send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: bucketObjectPath(projectId, visibility, key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      )
      const body = response.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined
      if (typeof body?.transformToWebStream !== 'function') return null
      return {
        body: body.transformToWebStream(),
        size: typeof response.ContentLength === 'number' ? response.ContentLength : 0,
        contentType: response.ContentType ?? null,
        range,
      }
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode
      if (status === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound') return null
      throw error
    }
  }

  async readUrl(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
    expiresIn = SIGNED_READ_EXPIRY_SECONDS,
  ): Promise<string> {
    const bucket = requireProjectBucketName()
    return getSignedUrl(
      getProjectBucketPublicS3Client(),
      new GetObjectCommand({ Bucket: bucket, Key: bucketObjectPath(projectId, visibility, key) }),
      { expiresIn },
    )
  }

  /** Server-side put: the API streams bytes it already has into the bucket. */
  async writeObject(
    path: string,
    stream: ReadableStream<Uint8Array> | null,
    contentType?: string | null,
  ): Promise<{ size: number; etag: string | null }> {
    const bucket = requireProjectBucketName()
    if (!stream) throw new Error('no body to store')
    // Bounded by the caller: the cloud path never routes big files through the
    // API (they go straight to the presigned URL), so this only ever handles
    // small JSON-ish payloads.
    const body = Buffer.from(await new Response(stream).arrayBuffer())
    const response = await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    )
    return { size: body.byteLength, etag: response.ETag?.replace(/"/g, '') ?? null }
  }
}

// ---------------------------------------------------------------------------
// Filesystem driver (desktop)
// ---------------------------------------------------------------------------

export function projectBucketRoot(): string {
  const configured = (process.env.PROJECT_BUCKET_DIR || '').trim()
  if (configured) return configured
  return join(process.env.SHOGO_DATA_DIR || join(homedir(), '.shogo'), 'project-buckets')
}

/** Absolute path of one object, refusing anything that escapes the root. */
export function projectBucketFilePath(path: string): string {
  const root = normalize(projectBucketRoot())
  const full = normalize(join(root, path))
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('Invalid bucket path')
  }
  return full
}

async function fileEtag(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path)
    return createHash('sha256').update(`${metadata.size}:${metadata.mtimeMs}`).digest('hex').slice(0, 32)
  } catch {
    return null
  }
}

class FilesystemProjectBucketDriver implements ProjectBucketDriver {
  readonly kind = 'filesystem' as const

  async createUpload(input: {
    projectId: string
    key: string
    visibility: BucketVisibility
    size: number
    contentType?: string | null
    apiOrigin: string
  }): Promise<UploadTicket> {
    // No object storage on desktop, so the API is the upload target and a
    // single streamed PUT is the whole protocol — multipart exists because S3
    // needs it, not because the contract does.
    const token = encodeUploadToken({ k: input.key, v: input.visibility })
    return {
      uploadId: token,
      key: input.key,
      visibility: input.visibility,
      mode: 'single',
      url: `${input.apiOrigin}/api/projects/${input.projectId}/bucket/uploads/${token}`,
      method: 'PUT',
      headers: input.contentType ? { 'Content-Type': input.contentType } : {},
      completeUrl: `${input.apiOrigin}/api/projects/${input.projectId}/bucket/uploads/${token}/complete`,
      // Built from the same origin as the ticket: a caller that reached the API
      // on a proxy or a port of its own must get a URL it can fetch, and
      // `bucketObjectPublicUrl` answers with the deployment's configured origin.
      publicUrl:
        input.visibility === 'public'
          ? `${input.apiOrigin}/api/bucket/${input.projectId}/public/${encodePathSegments(input.key)}`
          : null,
    }
  }

  async head(projectId: string, visibility: BucketVisibility, key: string) {
    const path = projectBucketFilePath(bucketObjectPath(projectId, visibility, key))
    try {
      const metadata = await stat(path)
      if (!metadata.isFile()) return null
      return {
        size: metadata.size,
        etag: (await fileEtag(path)) ?? undefined,
        // The S3 driver reads Content-Type from the HEAD response; on disk the
        // only source is the extension, and `completeBucketUpload` records it
        // in the index (so a download can answer with the right type later).
        contentType: mimeTypeForFile(key.split('/').pop() || key),
      }
    } catch {
      return null
    }
  }

  async list(projectIdAndVisibility: string, prefix: string, cursor: string | null, limit: number) {
    const root = projectBucketFilePath(projectIdAndVisibility)
    const found: Array<{ key: string; size: number }> = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        const key = relative(root, full).split(sep).join('/')
        if (!key.startsWith(prefix)) continue
        if (cursor && key <= cursor) continue
        const metadata = await stat(full).catch(() => null)
        if (!metadata) continue
        found.push({ key, size: metadata.size })
      }
    }
    await walk(root)
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const page = found.slice(0, limit)
    const hasMore = found.length > limit
    return { objects: page, cursor: hasMore ? page[page.length - 1]?.key ?? null : null }
  }

  async listAll(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const root = projectBucketFilePath(prefix.replace(/\/+$/, ''))
    const out: Array<{ key: string; size: number }> = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          const metadata = await stat(full).catch(() => null)
          if (metadata) {
            out.push({ key: `${prefix}${relative(root, full).split(sep).join('/')}`, size: metadata.size })
          }
        }
      }
    }
    await walk(root)
    return out
  }

  async delete(projectId: string, visibility: BucketVisibility, key: string): Promise<void> {
    await unlink(projectBucketFilePath(bucketObjectPath(projectId, visibility, key))).catch(() => {})
  }

  async read(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
    range: { start: number; end: number } | null,
  ): Promise<BucketReadStream | null> {
    const path = projectBucketFilePath(bucketObjectPath(projectId, visibility, key))
    const metadata = await stat(path).catch(() => null)
    if (!metadata?.isFile()) return null
    const stream = range
      ? createReadStream(path, { start: range.start, end: range.end })
      : createReadStream(path)
    return {
      body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      size: range ? range.end - range.start + 1 : metadata.size,
      contentType: mimeTypeForFile(key.split('/').pop() || key),
      range,
    }
  }

  async readUrl(
    projectId: string,
    visibility: BucketVisibility,
    key: string,
    expiresIn = SIGNED_READ_EXPIRY_SECONDS,
  ): Promise<string> {
    // Desktop has no CDN: the API answers the bytes itself, and a private read
    // carries an HMAC token so it works without a session (an `<img>`, a
    // native loader, an end-user's browser).
    const token = signBucketObjectToken(projectId, visibility, key, expiresIn)
    return `${bucketApiOrigin()}/api/bucket/${projectId}/${visibility}/${encodePathSegments(key)}?t=${token}`
  }

  async writeObject(
    path: string,
    stream: ReadableStream<Uint8Array> | null,
    _contentType?: string | null,
  ): Promise<{ size: number; etag: string | null }> {
    if (!stream) throw new Error('no body to store')
    const full = projectBucketFilePath(path)
    await mkdir(dirname(full), { recursive: true })
    await pipeline(Readable.fromWeb(stream as any), createWriteStream(full))
    const metadata = await stat(full)
    return { size: metadata.size, etag: await fileEtag(full) }
  }
}

// ---------------------------------------------------------------------------
// Desktop capability URLs
// ---------------------------------------------------------------------------

/**
 * The signing secret for desktop bucket URLs. Same chain as the conversation
 * file links (`lib/conversation-files.ts`): one deployment, one secret.
 */
function bucketSigningSecret(): string {
  const secret =
    process.env.AI_PROXY_SECRET || process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('[ProjectBucket] No signing secret configured')
  return 'shogo-dev-only-bucket-secret'
}

/** `exp.hmac` for a desktop object URL — capability, not identity. */
export function signBucketObjectToken(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
  expiresIn = SIGNED_READ_EXPIRY_SECONDS,
  nowMs = Date.now(),
): string {
  const exp = nowMs + Math.max(1, expiresIn) * 1000
  const mac = createHmac('sha256', bucketSigningSecret())
    .update(`bucket:${projectId}:${visibility}:${key}:${exp}`)
    .digest('hex')
  return `${exp}.${mac}`
}

export function verifyBucketObjectToken(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
  token: string | undefined | null,
  nowMs = Date.now(),
): boolean {
  const [expPart, mac] = (token ?? '').split('.')
  if (!expPart || !mac) return false
  const exp = Number(expPart)
  if (!Number.isFinite(exp) || exp <= nowMs) return false
  const expected = Buffer.from(
    createHmac('sha256', bucketSigningSecret())
      .update(`bucket:${projectId}:${visibility}:${key}:${exp}`)
      .digest('hex'),
  )
  const actual = Buffer.from(mac)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// Driver selection + public URLs
// ---------------------------------------------------------------------------

export function isLocalBucketMode(): boolean {
  return process.env.SHOGO_LOCAL_MODE === 'true'
}

let filesystemDriver: FilesystemProjectBucketDriver | null = null
let s3Driver: S3ProjectBucketDriver | null = null

/** True when this deployment can store project bucket bytes at all. */
export function isProjectBucketConfigured(): boolean {
  return isLocalBucketMode() || !!getProjectBucketName()
}

export function getProjectBucketDriver(): ProjectBucketDriver {
  if (isLocalBucketMode()) {
    filesystemDriver ??= new FilesystemProjectBucketDriver()
    return filesystemDriver
  }
  s3Driver ??= new S3ProjectBucketDriver()
  return s3Driver
}

/** Throws `ProjectBucketNotConfiguredError` when this deployment has no bucket. */
export function assertBucketConfigured(): void {
  if (!isProjectBucketConfigured()) throw new ProjectBucketNotConfiguredError()
}

/** Absolute base of this API, for URLs it hands back to clients. */
export function bucketApiOrigin(): string {
  const configured = (process.env.SHOGO_PUBLIC_API_URL || process.env.BETTER_AUTH_URL || '').trim()
  if (configured) return configured.replace(/\/+$/, '')
  const port = process.env.PORT || process.env.API_PORT || '3000'
  return `http://localhost:${port}`
}

/** Cloud: `https://cdn.<publish domain>`; desktop: null (the API serves it). */
export function projectBucketCdnBaseUrl(): string | null {
  if (isLocalBucketMode()) return null
  const configured = (process.env.SHOGO_BUCKET_CDN_BASE || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  const domain = (process.env.PUBLISH_DOMAIN || 'shogo.one').trim()
  return `https://cdn.${domain}`
}

/**
 * The URL a public object is served at: the CDN on cloud, the API's own
 * `/api/bucket/...` route on desktop.
 */
export function bucketObjectPublicUrl(projectId: string, key: string): string {
  const cdn = projectBucketCdnBaseUrl()
  if (cdn) return `${cdn}/${encodePathSegments(projectId)}/${encodePathSegments(key)}`
  return `${bucketApiOrigin()}/api/bucket/${projectId}/public/${encodePathSegments(key)}`
}

// ---------------------------------------------------------------------------
// Upload gate — "paid by the workspace, expandable"
// ---------------------------------------------------------------------------

export interface BucketUploadGate {
  ok: boolean
  /** Set when the upload was refused. */
  reason?: UsageBlockReason
  usedBytes: number
  allowanceBytes: number
  usdPerGbMonth: number
}

export function allowanceFor(instanceSize: string | null): number {
  const spec = INSTANCE_SIZES[(instanceSize ?? 'micro') as InstanceSizeName]
  return spec?.storageLimitBytes ?? 0
}

/**
 * Workspace storage in use right now: the last measurement plus every bucket
 * row written since it. A delete before the next pass can only make a caller
 * pay for a little more headroom than it uses, never less.
 */
export async function workspaceStorageInUse(
  workspaceId: string,
  measuredBillableBytes: number,
  measuredAt: Date | null,
): Promise<number> {
  const since = measuredAt ?? new Date(0)
  const added = await prisma.projectBucketObject.aggregate({
    where: { project: { workspaceId }, updatedAt: { gt: since } },
    _sum: { size: true },
  })
  return measuredBillableBytes + Number(added._sum.size ?? 0)
}

/**
 * Can this workspace take `sizeBytes` more into a project's bucket?
 *
 * Under the tier allowance: yes, always. Over it: yes when the workspace can
 * pay (`checkUsageBalance`), no with the wallet's own `UsageBlockReason`
 * otherwise. `shadow` mode applies the allowance rule but never blocks on
 * payment, so flipping `STORAGE_BILLING_MODE` to `enforce` turns the bill and
 * the gate on together. Local/desktop is unlimited.
 */
export async function checkBucketUploadAllowed(
  workspaceId: string,
  sizeBytes: number,
): Promise<BucketUploadGate> {
  const usdPerGbMonth = STORAGE_USD_PER_GB_MONTH
  if (isLocalBucketMode()) {
    return { ok: true, usedBytes: 0, allowanceBytes: Number.MAX_SAFE_INTEGER, usdPerGbMonth }
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { instanceSize: true },
  })
  const allowanceBytes = allowanceFor(workspace?.instanceSize ?? null)

  const usage = await prisma.storageUsage.findUnique({
    where: { workspaceId },
    select: { billableBytes: true, lastCalculatedAt: true },
  })
  const usedBytes = await workspaceStorageInUse(
    workspaceId,
    Number(usage?.billableBytes ?? 0),
    usage?.lastCalculatedAt ?? null,
  )
  const projected = usedBytes + Math.max(0, sizeBytes)

  if (projected <= allowanceBytes) {
    return { ok: true, usedBytes, allowanceBytes, usdPerGbMonth }
  }

  // Shadow mode: numbers are recorded and shown, but nothing is blocked.
  if (storageBillingMode() === 'shadow') {
    return { ok: true, usedBytes, allowanceBytes, usdPerGbMonth }
  }

  // The minimum the wallet must absorb: one day of the over-allowance share of
  // this upload, at the same rate the bill charges.
  const minimumUsd = Math.max(storageDailyUsd(projected, allowanceBytes), 0.000001)
  const balance = await checkUsageBalance(workspaceId, minimumUsd)
  if (balance.ok) return { ok: true, usedBytes, allowanceBytes, usdPerGbMonth }
  return { ok: false, reason: balance.reason, usedBytes, allowanceBytes, usdPerGbMonth }
}

export class BucketUploadRejectedError extends Error {
  readonly code = 'bucket_payment_required' as const
  readonly gate: BucketUploadGate
  readonly workspaceId: string
  constructor(gate: BucketUploadGate, workspaceId: string) {
    super('bucket_payment_required')
    this.name = 'BucketUploadRejectedError'
    this.gate = gate
    this.workspaceId = workspaceId
  }
}

/** The `402` body every surface prints verbatim (SDK, CLI, app route). */
export function bucketPaymentRequiredBody(gate: BucketUploadGate, workspaceId: string) {
  return {
    error: {
      code: 'bucket_payment_required' as const,
      message:
        'This upload is over your workspace storage allowance and the workspace cannot pay for the extra storage. Turn on usage-based billing or raise the spend cap, or remove files from the bucket.',
      reason: gate.reason ?? 'usage_limit_reached',
      usedBytes: gate.usedBytes,
      allowanceBytes: gate.allowanceBytes,
      usdPerGbMonth: gate.usdPerGbMonth,
      billingUrl: `${getFrontendUrl()}/billing?workspace=${encodeURIComponent(workspaceId)}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Object operations (index + bytes)
// ---------------------------------------------------------------------------

export interface BucketProject {
  id: string
  workspaceId: string
}

export interface BucketUploadRequest {
  key: string
  visibility: BucketVisibility
  size: number
  contentType?: string | null
  overwrite?: boolean
}

/** The index row for one object, or null. */
export async function findBucketObject(projectId: string, visibility: BucketVisibility, key: string) {
  return prisma.projectBucketObject.findUnique({
    where: { projectId_visibility_key: { projectId, visibility, key } },
  })
}

/**
 * Mint an upload ticket, after the existing-object and payment checks. Writes
 * nothing: the row lands in {@link completeBucketUpload}.
 */
export async function createBucketUpload(
  project: BucketProject,
  request: BucketUploadRequest,
  apiOrigin: string,
): Promise<UploadTicket> {
  assertBucketConfigured()
  const existing = await findBucketObject(project.id, request.visibility, request.key)
  if (existing && !request.overwrite) throw new BucketKeyExistsError(request.key)

  // Replacing a file frees its bytes, so only the growth is gated.
  const growth = Math.max(0, Math.max(0, request.size) - Number(existing?.size ?? 0))
  const gate = await checkBucketUploadAllowed(project.workspaceId, growth)
  if (!gate.ok) throw new BucketUploadRejectedError(gate, project.workspaceId)

  return getProjectBucketDriver().createUpload({
    projectId: project.id,
    key: request.key,
    visibility: request.visibility,
    size: request.size,
    contentType: request.contentType ?? null,
    apiOrigin,
  })
}

export interface CompletedBucketObject {
  key: string
  visibility: BucketVisibility
  size: number
  etag: string | null
  sha256: string | null
  publicUrl: string | null
}

/**
 * Record an uploaded object. The bytes are already in place (the client PUT
 * them to the ticket's URL), so this finishes a multipart upload when needed,
 * HEADs the object for its real size and etag, and upserts the index row. An
 * object that never landed is a 404 rather than a phantom row.
 */
export async function completeBucketUpload(
  project: BucketProject,
  token: UploadToken,
  parts: CompletedPart[] = [],
): Promise<CompletedBucketObject> {
  assertBucketConfigured()
  if (token.u) await finishMultipart(project.id, token, parts)
  const driver = getProjectBucketDriver()
  const head = await driver.head(project.id, token.v, token.k)
  if (!head) throw new BucketObjectMissingError(token.k)

  const row = await prisma.projectBucketObject.upsert({
    where: { projectId_visibility_key: { projectId: project.id, visibility: token.v, key: token.k } },
    create: {
      projectId: project.id,
      key: token.k,
      visibility: token.v,
      size: BigInt(head.size),
      contentType: head.contentType ?? null,
      etag: head.etag ?? null,
    },
    update: {
      size: BigInt(head.size),
      ...(head.contentType ? { contentType: head.contentType } : {}),
      etag: head.etag ?? null,
    },
    select: { size: true, etag: true, sha256: true },
  })
  return {
    key: token.k,
    visibility: token.v,
    size: Number(row.size),
    etag: row.etag ?? null,
    sha256: row.sha256 ?? null,
    publicUrl: token.v === 'public' ? bucketObjectPublicUrl(project.id, token.k) : null,
  }
}

/** Complete the provider-side multipart upload (S3 only; a no-op elsewhere). */
async function finishMultipart(
  projectId: string,
  token: UploadToken,
  parts: CompletedPart[],
): Promise<void> {
  if (!token.u || isLocalBucketMode()) return
  const bucket = requireProjectBucketName()
  const sorted = [...parts].sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0))
  if (token.n && sorted.length !== token.n) {
    throw new Error(`multipart upload needs ${token.n} parts, got ${sorted.length}`)
  }
  await getS3Client().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: bucketObjectPath(projectId, token.v, token.k),
      UploadId: token.u,
      MultipartUpload: { Parts: sorted },
    }),
  )
}

/** Abandon a multipart upload so the provider stops holding the parts. */
export async function abortBucketUpload(projectId: string, token: UploadToken): Promise<void> {
  if (!token.u || isLocalBucketMode()) return
  const bucket = getProjectBucketName()
  if (!bucket) return
  await getS3Client()
    .send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: bucketObjectPath(projectId, token.v, token.k),
        UploadId: token.u,
      }),
    )
    .catch(() => {})
}

/** Store bytes the API already has (the desktop upload target). */
export async function putBucketStream(
  project: BucketProject,
  input: {
    key: string
    visibility: BucketVisibility
    contentType?: string | null
    /** `Content-Length` of the request, when the caller sent one. */
    declaredSize?: number | null
  },
  stream: ReadableStream<Uint8Array> | null,
): Promise<CompletedBucketObject> {
  assertBucketConfigured()

  // Same gate as the ticket flow. This route exists so desktop can upload
  // without object storage, but it is mounted on cloud too, and a client that
  // PUTs straight at it must not be able to store bytes a ticket would refuse.
  const existing = await findBucketObject(project.id, input.visibility, input.key)
  const declared = Number(input.declaredSize ?? 0)
  const growth = Math.max(0, (Number.isFinite(declared) ? Math.max(0, declared) : 0) - Number(existing?.size ?? 0))
  const gate = await checkBucketUploadAllowed(project.workspaceId, growth)
  if (!gate.ok) throw new BucketUploadRejectedError(gate, project.workspaceId)

  const driver = getProjectBucketDriver()
  const written = await driver.writeObject(
    bucketObjectPath(project.id, input.visibility, input.key),
    stream,
    input.contentType ?? null,
  )
  const row = await prisma.projectBucketObject.upsert({
    where: { projectId_visibility_key: { projectId: project.id, visibility: input.visibility, key: input.key } },
    create: {
      projectId: project.id,
      key: input.key,
      visibility: input.visibility,
      size: BigInt(written.size),
      contentType: input.contentType ?? null,
      etag: written.etag,
    },
    update: {
      size: BigInt(written.size),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      etag: written.etag,
    },
    select: { size: true, etag: true, sha256: true },
  })
  return {
    key: input.key,
    visibility: input.visibility,
    size: Number(row.size),
    etag: row.etag ?? null,
    sha256: row.sha256 ?? null,
    publicUrl: input.visibility === 'public' ? bucketObjectPublicUrl(project.id, input.key) : null,
  }
}

export interface BucketListOptions {
  prefix?: string
  /** `public` / `private` / omitted for both. */
  visibility?: BucketVisibility | null
  cursor?: string | null
  limit?: number
}

/**
 * Page a project's bucket from the index — never a live bucket listing, so a
 * list costs one query and cannot page forever.
 */
export async function listBucketObjects(
  projectId: string,
  options: BucketListOptions = {},
): Promise<BucketListPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000)
  const prefix = options.prefix ?? ''
  const keyFilter = options.cursor
    ? { startsWith: prefix, gt: options.cursor }
    : prefix
      ? { startsWith: prefix }
      : undefined
  const rows = await prisma.projectBucketObject.findMany({
    where: {
      projectId,
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(keyFilter ? { key: keyFilter } : {}),
    },
    orderBy: { key: 'asc' },
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  return {
    objects: page.map((row) => ({
      key: row.key,
      visibility: row.visibility as BucketVisibility,
      size: Number(row.size),
      contentType: row.contentType ?? null,
      etag: row.etag ?? null,
      sha256: row.sha256 ?? null,
      updatedAt: new Date(row.updatedAt).toISOString(),
    })),
    cursor: rows.length > limit ? page[page.length - 1]?.key ?? null : null,
  }
}

/** Metadata of one object: the index row, or the stored object when unindexed. */
export async function headBucketObject(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
): Promise<BucketObjectMetadata | null> {
  const row = await findBucketObject(projectId, visibility, key)
  if (row) {
    return {
      key: row.key,
      visibility: row.visibility as BucketVisibility,
      size: Number(row.size),
      contentType: row.contentType ?? null,
      etag: row.etag ?? null,
      sha256: row.sha256 ?? null,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }
  }
  if (!isProjectBucketConfigured()) return null
  const head = await getProjectBucketDriver().head(projectId, visibility, key)
  if (!head) return null
  return {
    key,
    visibility,
    size: head.size,
    contentType: head.contentType ?? null,
    etag: head.etag ?? null,
    sha256: null,
    updatedAt: new Date().toISOString(),
  }
}

/** A URL that needs no credentials: the CDN (public) or a signed read (private). */
export async function bucketObjectSignedUrl(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
  expiresIn = SIGNED_READ_EXPIRY_SECONDS,
): Promise<string> {
  if (visibility === 'public') return bucketObjectPublicUrl(projectId, key)
  assertBucketConfigured()
  return getProjectBucketDriver().readUrl(projectId, visibility, key, expiresIn)
}

export async function readBucketObject(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
  range: { start: number; end: number } | null,
): Promise<BucketReadStream | null> {
  assertBucketConfigured()
  return getProjectBucketDriver().read(projectId, visibility, key, range)
}

/** Delete one object: bytes, then the index row. Idempotent. */
export async function deleteBucketObject(
  projectId: string,
  visibility: BucketVisibility,
  key: string,
): Promise<boolean> {
  const row = await findBucketObject(projectId, visibility, key)
  if (isProjectBucketConfigured()) {
    await getProjectBucketDriver().delete(projectId, visibility, key)
  }
  if (row) {
    await prisma.projectBucketObject.delete({
      where: { projectId_visibility_key: { projectId, visibility, key } },
    })
  }
  return !!row
}

export interface BucketUsage {
  projectBytes: number
  projectObjects: number
  workspaceId: string
  workspaceUsedBytes: number
  allowanceBytes: number
  billingMode: 'shadow' | 'enforce'
  usdPerGbMonth: number
  /** Where public objects are served: the CDN on cloud, this API on desktop. */
  publicBaseUrl: string
}

/** `/bucket/usage`: what this project holds and what the workspace has left. */
export async function bucketUsage(project: BucketProject): Promise<BucketUsage> {
  const totals = await prisma.projectBucketObject.aggregate({
    where: { projectId: project.id },
    _sum: { size: true },
    _count: { _all: true },
  })
  const workspace = await prisma.workspace.findUnique({
    where: { id: project.workspaceId },
    select: { instanceSize: true },
  })
  const usage = await prisma.storageUsage.findUnique({
    where: { workspaceId: project.workspaceId },
    select: { billableBytes: true, lastCalculatedAt: true },
  })
  const allowanceBytes = allowanceFor(workspace?.instanceSize ?? null)
  const workspaceUsedBytes = isLocalBucketMode()
    ? Number(totals._sum.size ?? 0)
    : await workspaceStorageInUse(
        project.workspaceId,
        Number(usage?.billableBytes ?? 0),
        usage?.lastCalculatedAt ?? null,
      )
  return {
    projectBytes: Number(totals._sum.size ?? 0),
    projectObjects: totals._count._all,
    workspaceId: project.workspaceId,
    workspaceUsedBytes,
    allowanceBytes,
    billingMode: storageBillingMode(),
    usdPerGbMonth: STORAGE_USD_PER_GB_MONTH,
    publicBaseUrl: projectBucketCdnBaseUrl() ?? bucketApiOrigin(),
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: project and workspace delete
// ---------------------------------------------------------------------------

/**
 * Remove every object in a project's bucket, then prove the prefix is empty
 * (SHO-207 rule: single-object DELETEs, then an empty listing). Rows are
 * deleted here too, so a purge that runs before the row delete leaves no index
 * behind.
 */
export async function purgeProjectBucket(projectId: string): Promise<{ deleted: number; empty: boolean }> {
  let deleted = 0
  const driver = getProjectBucketDriver()
  const prefix = projectBucketPrefix(projectId)
  if (isProjectBucketConfigured()) {
    for (let pass = 0; pass < 20; pass += 1) {
      const objects = await driver.listAll(prefix)
      if (objects.length === 0) break
      for (const object of objects) {
        const parsed = parseBucketObjectPath(object.key)
        if (!parsed) continue
        await driver.delete(parsed.projectId, parsed.visibility, parsed.key)
        deleted += 1
      }
    }
  }
  await prisma.projectBucketObject.deleteMany({ where: { projectId } })
  if (!isProjectBucketConfigured()) return { deleted, empty: true }
  const remaining = await driver.listAll(prefix)
  return { deleted, empty: remaining.length === 0 }
}

/** Remove every project's bucket in a workspace (workspace delete). */
export async function purgeWorkspaceBuckets(
  workspaceId: string,
): Promise<{ deleted: number; projects: number }> {
  const projects = await prisma.project.findMany({ where: { workspaceId }, select: { id: true } })
  let deleted = 0
  for (const project of projects) {
    const result = await purgeProjectBucket(project.id)
    deleted += result.deleted
  }
  return { deleted, projects: projects.length }
}

/** Bytes a workspace's project buckets hold, from the index (delete preview). */
export async function projectBucketBytesForWorkspace(workspaceId: string): Promise<number> {
  const totals = await prisma.projectBucketObject.aggregate({
    where: { project: { workspaceId } },
    _sum: { size: true },
  })
  return Number(totals._sum.size ?? 0)
}

/** Bytes one project's bucket holds (delete preview). */
export async function projectBucketBytes(projectId: string): Promise<number> {
  const totals = await prisma.projectBucketObject.aggregate({
    where: { projectId },
    _sum: { size: true },
  })
  return Number(totals._sum.size ?? 0)
}

/** SHA-256 of a file on disk — the desktop upload route records what it wrote. */
export async function sha256OfFile(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', () => resolve(null))
  })
}

/** Write bytes under the bucket root (tests and seeds). */
export async function writeBucketFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const full = projectBucketFilePath(path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, bytes)
}
