// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Single-object helpers for the object store: does it exist, and put this file
 * there without holding it in memory.
 *
 * One implementation for both callers that need it — `S3Sync`'s project
 * archive and the publish artifact / LFS object uploads (SHO-485). The upload
 * is part-buffered multipart **from a file handle**, never a streamed
 * `PutObject` body: a streaming fs body to the OCI S3-compatible endpoint never
 * completes under bun and the promise hangs forever (see `repo-store.ts`), so
 * the buffered-part path is the one that actually works there. Peak memory is
 * one part whatever the file size.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { readFile, open } from 'fs/promises'

/** The two things an object operation needs: a bucket and an S3-compatible client. */
export interface S3ObjectStore {
  bucket: string
  client: { send(command: any): Promise<any> }
}

/**
 * Files at or above this size are uploaded with a multipart upload. Below it, a
 * single `PutObject` with a Buffer body stays the path — it is proven against
 * our S3-compatible store.
 */
export const S3_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024

/** Part size for a multipart upload (S3 requires ≥ 5 MiB per part except the last). */
export const S3_MULTIPART_PART_BYTES = 16 * 1024 * 1024

/** A 404/NoSuchKey from either AWS or OCI. */
export function isObjectNotFound(err: any): boolean {
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404
}

/** A 412 from a conditional write, as both AWS and OCI shape it. */
export function isPreconditionFailure(err: any): boolean {
  return err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412
}

/** Our own 412, for a precondition the store was never asked to enforce. */
export function preconditionFailed(key: string): Error {
  const err: any = new Error(`PreconditionFailed: s3://${key} changed since this instance read it`)
  err.name = 'PreconditionFailed'
  err.$metadata = { httpStatusCode: 412 }
  return err
}

/**
 * Whether `key` exists. Any error other than "not found" is rethrown: a
 * credential or network failure must not be read as "absent" by a caller that
 * would then upload over an object it has not seen.
 */
export async function objectExists(store: S3ObjectStore, key: string): Promise<boolean> {
  try {
    await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }))
    return true
  } catch (err) {
    if (isObjectNotFound(err)) return false
    throw err
  }
}

/**
 * PUT `filePath` under `key` without ever holding it in memory.
 *
 * Below {@link S3_MULTIPART_THRESHOLD_BYTES} this is one `PutObject` with a
 * Buffer body; above it, a multipart upload reads one
 * {@link S3_MULTIPART_PART_BYTES} part at a time from a file handle.
 *
 * `contentType` is not cosmetic for a content-addressed object: `Bun.serve`
 * answers a store object with the object's own `Content-Type` and ignores
 * overrides, so this metadata *is* the header a published pod serves.
 *
 * `precondition` is the archive-lineage guard. S3 enforces it on the complete
 * call; because an S3-compatible store is free to ignore it there, the ETag is
 * also checked against the object immediately before the write is finalised.
 */
export async function putFileToObjectStore(
  store: S3ObjectStore,
  key: string,
  filePath: string,
  opts: {
    bytes: number
    contentType?: string
    cacheControl?: string
    precondition?: { IfMatch?: string; IfNoneMatch?: string }
  },
): Promise<{ etag?: string }> {
  const contentType = opts.contentType ?? 'application/octet-stream'
  const precondition = opts.precondition ?? {}
  if (opts.bytes < S3_MULTIPART_THRESHOLD_BYTES) {
    const res = await store.client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: key,
        Body: await readFile(filePath),
        ContentType: contentType,
        ...(opts.cacheControl ? { CacheControl: opts.cacheControl } : {}),
        ...precondition,
      }),
    )
    return { etag: res.ETag }
  }
  return multipartUploadFromFile(store, key, filePath, opts.bytes, contentType, precondition)
}

/** What a `HeadObject` tells us about an object we did not write (or wrote earlier). */
export interface StoredObjectMetadata {
  size: number
  etag?: string
  contentType?: string
  cacheControl?: string
}

/** `HeadObject` as data, or `null` when the key is not there. */
export async function headObject(store: S3ObjectStore, key: string): Promise<StoredObjectMetadata | null> {
  try {
    const head = await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }))
    return {
      size: Number(head?.ContentLength ?? 0),
      etag: head?.ETag,
      contentType: head?.ContentType,
      cacheControl: head?.CacheControl,
    }
  } catch (err) {
    if (isObjectNotFound(err)) return null
    throw err
  }
}

/**
 * Re-stamp an object's `Content-Type`/`Cache-Control` without rewriting its
 * bytes (a server-side self-`CopyObject`).
 *
 * An object can reach the store before we know how it will be served — `git
 * lfs push` uploads through a presigned PUT and picks
 * `application/octet-stream`, and the same content-addressed key is reused by
 * every later publish. Because a published pod serves the object's own
 * `Content-Type`, the first publish that knows the real type has to fix it.
 */
export async function stampObjectMetadata(
  store: S3ObjectStore,
  key: string,
  metadata: { contentType: string; cacheControl?: string },
): Promise<void> {
  await store.client.send(
    new CopyObjectCommand({
      Bucket: store.bucket,
      Key: key,
      CopySource: `${store.bucket}/${key}`,
      MetadataDirective: 'REPLACE',
      ContentType: metadata.contentType,
      ...(metadata.cacheControl ? { CacheControl: metadata.cacheControl } : {}),
    }),
  )
}

/** The large-object path of {@link putFileToObjectStore}. */
async function multipartUploadFromFile(
  store: S3ObjectStore,
  key: string,
  filePath: string,
  bytes: number,
  contentType: string,
  precondition: { IfMatch?: string; IfNoneMatch?: string },
): Promise<{ etag?: string }> {
  const created = await store.client.send(
    new CreateMultipartUploadCommand({ Bucket: store.bucket, Key: key, ContentType: contentType }),
  )
  const uploadId = created.UploadId
  if (!uploadId) throw new Error(`multipart upload for ${key} returned no UploadId`)

  const parts: Array<{ ETag: string; PartNumber: number }> = []
  try {
    const fh = await open(filePath, 'r')
    try {
      let offset = 0
      let partNumber = 0
      while (offset < bytes) {
        const length = Math.min(S3_MULTIPART_PART_BYTES, bytes - offset)
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await fh.read(buffer, 0, length, offset)
        if (bytesRead !== length) {
          throw new Error(`multipart upload for ${key}: short read at ${offset} (${bytesRead}/${length})`)
        }
        partNumber += 1
        const part = await store.client.send(
          new UploadPartCommand({
            Bucket: store.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buffer,
          }),
        )
        if (!part.ETag) throw new Error(`multipart upload for ${key}: part ${partNumber} returned no ETag`)
        parts.push({ ETag: part.ETag, PartNumber: partNumber })
        offset += length
      }
    } finally {
      await fh.close()
    }

    if (precondition.IfMatch || precondition.IfNoneMatch) {
      const current = await store.client
        .send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }))
        .catch((err: any) => {
          if (isObjectNotFound(err)) return null
          throw err
        })
      const stale = precondition.IfMatch ? current?.ETag !== precondition.IfMatch : current !== null
      if (stale) throw preconditionFailed(key)
    }

    const done = await store.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: store.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
        ...precondition,
      }),
    )
    return { etag: done.ETag }
  } catch (err) {
    await store.client
      .send(new AbortMultipartUploadCommand({ Bucket: store.bucket, Key: key, UploadId: uploadId }))
      .catch(() => {})
    throw err
  }
}
