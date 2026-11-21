// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project bucket API (SHO-491).
 *
 * Mounted under `/api/projects/:projectId/bucket` — so the global
 * `authMiddleware` + `requireProjectAccess` apply, and a project's runtime
 * token can only reach its own bucket:
 *
 *   POST   /uploads                      mint an upload ticket (presigned PUT /
 *                                        multipart on cloud, an API target on
 *                                        desktop) — 402 when over the allowance
 *                                        and the workspace cannot pay
 *   PUT    /uploads/:uploadId            desktop upload target (streamed to disk)
 *   POST   /uploads/:uploadId/complete   record the object (HEAD + index row)
 *   DELETE /uploads/:uploadId            abort a multipart upload
 *   GET    /objects?prefix=&cursor=      page the index
 *   HEAD   /objects/*key                 metadata
 *   GET    /objects/*key                 redirect to the CDN/presigned URL
 *   GET    /objects/*key?url=1           the read URL as JSON (no redirect)
 *   DELETE /objects/*key                 delete one object
 *   GET    /usage                        project bytes, workspace allowance, rate
 *
 * Plus {@link projectBucketPublicRoutes}: `GET /api/bucket/:projectId/:…`, the
 * desktop stand-in for the CDN. Public objects only, bytes streamed from disk
 * with `Range`; private objects need the signed token in the URL.
 */

import { Hono, type Context } from 'hono'
import { stat } from 'node:fs/promises'
import { fileRangeResponse } from '@shogo/shared-runtime'
import { prisma } from '../lib/prisma'
import { mimeTypeForFile } from '../lib/local-file-mime'
import {
  BucketKeyExistsError,
  BucketObjectMissingError,
  BucketUploadRejectedError,
  ProjectBucketNotConfiguredError,
  abortBucketUpload,
  bucketApiOrigin,
  bucketObjectPath,
  bucketObjectSignedUrl,
  bucketPaymentRequiredBody,
  bucketUsage,
  completeBucketUpload,
  createBucketUpload,
  decodeUploadToken,
  deleteBucketObject,
  headBucketObject,
  isLocalBucketMode,
  listBucketObjects,
  normalizeBucketVisibility,
  projectBucketFilePath,
  projectBucketPublicPrefix,
  putBucketStream,
  validateBucketKey,
  verifyBucketObjectToken,
  type BucketProject,
} from '../services/project-bucket.service'

export interface ProjectBucketRoutesConfig {
  /** Absolute base URL the API answers on; tickets and URLs are built from it. */
  apiOrigin?: string
}

/** `{ error: { code, message } }` for anything the bucket throws. */
export function bucketErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof BucketUploadRejectedError) {
    return c.json(bucketPaymentRequiredBody(error.gate, error.workspaceId), 402)
  }
  if (error instanceof BucketKeyExistsError) {
    return c.json({ error: { code: error.code, message: error.message } }, 409)
  }
  if (error instanceof BucketObjectMissingError) {
    return c.json({ error: { code: error.code, message: error.message } }, 404)
  }
  if (error instanceof ProjectBucketNotConfiguredError) {
    return c.json({ error: { code: error.code, message: error.message } }, 503)
  }
  const code = (error as any)?.code
  if (code === 'invalid_key') {
    return c.json({ error: { code, message: (error as Error).message } }, 400)
  }
  console.error('[ProjectBucket]', (error as any)?.message ?? error)
  return c.json(
    { error: { code: 'bucket_error', message: (error as any)?.message ?? 'Bucket request failed' } },
    500,
  )
}

/** The project + workspace a request names, or null when the project is gone. */
async function loadBucketProject(projectId: string): Promise<BucketProject | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workspaceId: true },
  })
  return project ? { id: project.id, workspaceId: project.workspaceId } : null
}

async function readJsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? (body as Record<string, any>) : {}
  } catch {
    return {}
  }
}

/** The path after `marker`, percent-decoded segment by segment. */
export function keyAfterPath(marker: string, path: string): string {
  const at = path.indexOf(marker)
  if (at < 0) return ''
  return path
    .slice(at + marker.length)
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join('/')
}

/** The `*` part of `/objects/*key`. */
export function objectKeyFromPath(path: string): string {
  return keyAfterPath('/bucket/objects/', path)
}

export function projectBucketRoutes(config: ProjectBucketRoutesConfig = {}): Hono {
  const router = new Hono()
  const apiOrigin = () => config.apiOrigin ?? bucketApiOrigin()

  /**
   * Mint an upload ticket. Nothing is stored yet: the caller PUTs the bytes to
   * the returned URL (or part URLs) and then POSTs to `completeUrl`.
   */
  router.post('/projects/:projectId/bucket/uploads', async (c) => {
    const project = await loadBucketProject(c.req.param('projectId'))
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)

    const body = await readJsonBody(c)
    const key = validateBucketKey(body.key)
    if (!key.ok) return c.json({ error: { code: key.code, message: key.message } }, 400)
    const size = Number(body.size)
    if (!Number.isFinite(size) || size < 0) {
      return c.json({ error: { code: 'invalid_size', message: 'size must be a number of bytes' } }, 400)
    }
    const contentType = typeof body.contentType === 'string' ? body.contentType : null

    try {
      const ticket = await createBucketUpload(
        project,
        {
          key: key.key,
          visibility: normalizeBucketVisibility(body.visibility ?? (body.public === true ? 'public' : undefined)),
          size,
          contentType,
          overwrite: body.overwrite === true,
        },
        apiOrigin(),
      )
      return c.json(ticket, 201)
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  /**
   * Desktop upload target: the whole body, streamed to disk. Cloud does not
   * have it — a cloud ticket points straight at object storage, so a request
   * here means something is wrong and gets a 404.
   */
  router.put('/projects/:projectId/bucket/uploads/:uploadId', async (c) => {
    if (!isLocalBucketMode()) {
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    }
    const project = await loadBucketProject(c.req.param('projectId'))
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    const token = decodeUploadToken(c.req.param('uploadId'))
    if (!token) return c.json({ error: { code: 'invalid_upload', message: 'Unknown upload ticket' } }, 400)

    const declaredLength = Number(c.req.header('content-length'))
    // The length is optional: the filesystem driver streams and measures the
    // body itself. It is passed through so the gate sees a real growth number
    // (and so a streaming object-store write can bound the body).
    try {
      const stored = await putBucketStream(
        project,
        {
          key: token.k,
          visibility: token.v,
          contentType: c.req.header('content-type') ?? null,
          declaredSize: Number.isFinite(declaredLength) ? declaredLength : null,
        },
        c.req.raw.body,
      )
      return c.json(stored, 201)
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  /** Finish an upload: multipart parts first, then the index row. */
  router.post('/projects/:projectId/bucket/uploads/:uploadId/complete', async (c) => {
    const project = await loadBucketProject(c.req.param('projectId'))
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    const token = decodeUploadToken(c.req.param('uploadId'))
    if (!token) return c.json({ error: { code: 'invalid_upload', message: 'Unknown upload ticket' } }, 400)

    const body = await readJsonBody(c)
    const parts = Array.isArray(body.parts)
      ? body.parts
          .filter((part: any) => typeof part?.ETag === 'string' || typeof part?.etag === 'string')
          .map((part: any) => ({
            ETag: String(part.ETag ?? part.etag),
            PartNumber: Number(part.PartNumber ?? part.partNumber),
          }))
      : []
    const sha256 = typeof body.sha256 === 'string' ? body.sha256 : null

    try {
      const stored = await completeBucketUpload(project, token, parts)
      if (sha256 && stored.size >= 0) {
        await prisma.projectBucketObject.update({
          where: { projectId_visibility_key: { projectId: project.id, visibility: token.v, key: token.k } },
          data: { sha256 },
        })
        stored.sha256 = sha256
      }
      return c.json(stored)
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  /** Give up on a multipart upload (the caller aborted mid-file). */
  router.delete('/projects/:projectId/bucket/uploads/:uploadId', async (c) => {
    const project = await loadBucketProject(c.req.param('projectId'))
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    const token = decodeUploadToken(c.req.param('uploadId'))
    if (!token) return c.json({ error: { code: 'invalid_upload', message: 'Unknown upload ticket' } }, 400)
    await abortBucketUpload(project.id, token)
    return c.json({ ok: true })
  })

  /** Page the index. */
  router.get('/projects/:projectId/bucket/objects', async (c) => {
    const projectId = c.req.param('projectId')
    const visibilityRaw = c.req.query('visibility')
    try {
      const page = await listBucketObjects(projectId, {
        prefix: c.req.query('prefix') ?? '',
        visibility: visibilityRaw ? normalizeBucketVisibility(visibilityRaw) : null,
        cursor: c.req.query('cursor') ?? null,
        limit: Number(c.req.query('limit') ?? 100),
      })
      // The prefix an object URL is built from, so a client on either
      // deployment appends an encoded key instead of guessing the shape.
      return c.json({ ...page, publicUrlPrefix: projectBucketPublicPrefix(projectId) })
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  /**
   * HEAD answers metadata; GET answers a read URL. One handler for both,
   * because Hono routes a HEAD request to the matching GET handler — two
   * separate registrations would make `HEAD` return the GET's redirect.
   */
  router.on(['GET', 'HEAD'], '/projects/:projectId/bucket/objects/*', async (c) => {
    const projectId = c.req.param('projectId')
    const key = objectKeyFromPath(c.req.path)
    const validated = validateBucketKey(key)
    if (!validated.ok) return c.json({ error: { code: validated.code, message: validated.message } }, 400)
    const visibility = normalizeBucketVisibility(c.req.query('visibility'))

    if (c.req.method === 'HEAD') {
      const object = await headBucketObject(projectId, visibility, validated.key)
      if (!object) return c.body(null, 404)
      c.header('Content-Length', String(object.size))
      if (object.contentType) c.header('Content-Type', object.contentType)
      if (object.etag) c.header('ETag', object.etag)
      return c.body(null, 200)
    }

    const expiresIn = Math.min(Math.max(Number(c.req.query('expiresIn') ?? 3600), 60), 86400)

    try {
      const object = await headBucketObject(projectId, visibility, validated.key)
      if (!object) return c.json({ error: { code: 'object_not_found', message: `"${validated.key}" is not in this bucket` } }, 404)
      const url = await bucketObjectSignedUrl(projectId, visibility, validated.key, expiresIn)
      if (c.req.query('url') === '1') {
        return c.json({ url, key: validated.key, visibility, size: object.size, contentType: object.contentType })
      }
      return c.redirect(url, 302)
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  router.delete('/projects/:projectId/bucket/objects/*', async (c) => {
    const key = objectKeyFromPath(c.req.path)
    const validated = validateBucketKey(key)
    if (!validated.ok) return c.json({ error: { code: validated.code, message: validated.message } }, 400)
    const visibility = normalizeBucketVisibility(c.req.query('visibility'))
    try {
      const existed = await deleteBucketObject(c.req.param('projectId'), visibility, validated.key)
      if (!existed) return c.json({ error: { code: 'object_not_found', message: `"${validated.key}" is not in this bucket` } }, 404)
      return c.json({ ok: true, key: validated.key, visibility })
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  /** Project bytes, workspace usage and allowance, billing mode and rate. */
  router.get('/projects/:projectId/bucket/usage', async (c) => {
    const project = await loadBucketProject(c.req.param('projectId'))
    if (!project) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    try {
      return c.json(await bucketUsage(project))
    } catch (error) {
      return bucketErrorResponse(c, error)
    }
  })

  return router
}

/**
 * `GET|HEAD /api/bucket/:projectId/:visibility/*` — the desktop stand-in for
 * the CDN. It exists only in local mode (cloud serves public objects from
 * `cdn.<domain>`), serves public objects to anyone, and a private object only
 * with a valid `?t=` token from `signedUrl`.
 */
export function projectBucketPublicRoutes(): Hono {
  const router = new Hono()

  router.on(['GET', 'HEAD'], '/api/bucket/:projectId/:visibility/*', async (c) => {
    if (!isLocalBucketMode()) {
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    }
    const projectId = c.req.param('projectId')
    const visibility = c.req.param('visibility')
    const key = keyAfterPath(`/api/bucket/${projectId}/${visibility}/`, c.req.path)
    const validated = validateBucketKey(key)
    if (!validated.ok) return c.json({ error: { code: validated.code, message: validated.message } }, 400)

    if (visibility === 'private' && !verifyBucketObjectToken(projectId, 'private', validated.key, c.req.query('t'))) {
      return c.json({ error: { code: 'forbidden', message: 'This object needs a signed URL' } }, 403)
    }
    if (visibility !== 'public' && visibility !== 'private') {
      return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    }

    const path = projectBucketFilePath(bucketObjectPath(projectId, visibility, validated.key))
    const metadata = await stat(path).catch(() => null)
    if (!metadata?.isFile()) return c.json({ error: { code: 'object_not_found', message: 'Not found' } }, 404)

    const filename = validated.key.split('/').pop() || 'file'
    const contentType = mimeTypeForFile(filename)
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    }
    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(metadata.size) } })
    }
    return fileRangeResponse({
      file: Bun.file(path),
      size: metadata.size,
      rangeHeader: c.req.header('range'),
      headers,
    })
  })

  return router
}
