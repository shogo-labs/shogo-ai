// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git LFS server (basic transfer adapter) backed by OCI Object Storage.
 *
 * Implements the Git LFS Batch API for each project's repo:
 *   POST /projects/:projectId/git/info/lfs/objects/batch
 *   POST /projects/:projectId/git/info/lfs/objects/verify
 *
 * The API never touches object bytes: the batch response hands back
 * presigned OCI URLs and the git-lfs client PUTs/GETs the bytes directly to
 * object storage. This means:
 *   - no `git-lfs` binary is required on the API image;
 *   - the global 200 MB body limit is irrelevant to object size (only the
 *     small JSON envelope flows through the API);
 *   - hydrate/`reset --hard` on the API leaves pointer files in place, so
 *     the commit graph still lists the large files.
 *
 * Objects are content-addressed (sha256 oid) under
 *   `<projectId>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`
 * in `S3_LFS_BUCKET` (defaults to `S3_WORKSPACES_BUCKET`), giving free
 * dedup within a project.
 *
 * Auth mirrors the smart-HTTP backend (`git-http.ts`): the parent
 * `authMiddleware` + an explicit `authorizeProject` check. Internal pods
 * authenticate with the runtime bearer forwarded by git-lfs via
 * `http.extraHeader`. External (laptop/CI) git-lfs clients are out of scope
 * — they have no way to present a Shogo credential yet.
 *
 * Spec: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
 */

import { Hono, type Context } from 'hono'
import { lfsObjectKey, isValidLfsOid } from '@shogo/shared-runtime'
import { prisma } from '../lib/prisma'
import { authorizeProject } from '../middleware/auth'
import {
  getLfsPresignedReadUrl,
  getLfsPresignedWriteUrl,
  headLfsObject,
} from '../lib/s3'

const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json'

/** Presigned-URL TTL for LFS transfers (seconds). */
const LFS_PRESIGN_EXPIRY = parseInt(process.env.LFS_PRESIGN_EXPIRY || '3600', 10) || 3600

export interface GitLfsRoutesConfig {
  /** Directory containing per-project workspaces (unused today; kept for parity). */
  workspacesDir: string
}

interface BatchObjectRequest {
  oid: string
  size: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON response with the git-lfs media type. */
function lfsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': LFS_CONTENT_TYPE },
  })
}

/** LFS error envelope (`{ message }`) with the git-lfs media type. */
function lfsError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: {
      'Content-Type': LFS_CONTENT_TYPE,
      ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="shogo"' } : {}),
    },
  })
}

/**
 * Shared auth + project resolution, mirroring `git-http.ts`. Returns null on
 * success or a ready-to-return Response on any failure path.
 */
async function authorizeLfs(c: Context, projectId: string): Promise<Response | null> {
  const auth = c.get('auth')
  if (!auth?.isAuthenticated || !auth.userId) {
    return lfsError('Authentication required', 401)
  }
  const access = await authorizeProject(c, projectId)
  if (!access.ok) {
    return lfsError(access.message || 'Forbidden', access.status || 403)
  }
  // workingMode=external projects don't have a Shogo-managed repo.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workingMode: true } as any,
  }) as { workingMode?: string } | null
  if (project?.workingMode === 'external') {
    return lfsError('Not found', 404)
  }
  return null
}

function parseBatchObjects(input: unknown): BatchObjectRequest[] | null {
  if (!Array.isArray(input)) return null
  const out: BatchObjectRequest[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null
    const oid = (raw as any).oid
    const size = (raw as any).size
    if (typeof oid !== 'string' || typeof size !== 'number' || size < 0) return null
    out.push({ oid, size })
  }
  return out
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function gitLfsRoutes(_config: GitLfsRoutesConfig) {
  const router = new Hono()

  /**
   * POST /projects/:projectId/git/info/lfs/objects/batch
   *
   * The git-lfs client asks, for a set of {oid,size}, where to upload or
   * download each object. We answer with presigned OCI URLs (basic transfer).
   */
  router.post('/projects/:projectId/git/info/lfs/objects/batch', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return lfsError('projectId is required', 400)

    const denied = await authorizeLfs(c, projectId)
    if (denied) return denied

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return lfsError('Invalid JSON body', 422)
    }

    const operation = body?.operation
    if (operation !== 'upload' && operation !== 'download') {
      return lfsError('operation must be "upload" or "download"', 422)
    }

    const objects = parseBatchObjects(body?.objects)
    if (!objects) {
      return lfsError('objects must be an array of {oid, size}', 422)
    }

    const verifyHref =
      `${new URL(c.req.url).origin}/api/projects/${projectId}/git/info/lfs/objects/verify`

    const responseObjects = await Promise.all(
      objects.map(async (obj) => {
        // Reject malformed oids — they'd otherwise escape the project's S3
        // key namespace.
        if (!isValidLfsOid(obj.oid)) {
          return {
            oid: obj.oid,
            size: obj.size,
            error: { code: 422, message: 'invalid oid (expected sha256 hex)' },
          }
        }
        const key = lfsObjectKey(projectId, obj.oid)
        const existing = await headLfsObject(key)

        if (operation === 'download') {
          if (!existing) {
            return {
              oid: obj.oid,
              size: obj.size,
              error: { code: 404, message: 'object does not exist' },
            }
          }
          const href = await getLfsPresignedReadUrl(key, { expiresIn: LFS_PRESIGN_EXPIRY })
          return {
            oid: obj.oid,
            size: obj.size,
            authenticated: true,
            actions: { download: { href, expires_in: LFS_PRESIGN_EXPIRY } },
          }
        }

        // upload: omit actions when the object already exists (dedup → the
        // client treats it as already uploaded and skips the transfer).
        if (existing) {
          return { oid: obj.oid, size: obj.size, authenticated: true }
        }
        const href = await getLfsPresignedWriteUrl(key, { expiresIn: LFS_PRESIGN_EXPIRY })
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: {
            upload: { href, expires_in: LFS_PRESIGN_EXPIRY },
            verify: { href: verifyHref, expires_in: LFS_PRESIGN_EXPIRY },
          },
        }
      }),
    )

    return lfsJson({ transfer: 'basic', objects: responseObjects, hash_algo: 'sha256' })
  })

  /**
   * POST /projects/:projectId/git/info/lfs/objects/verify
   *
   * Optional integrity check the client calls after an upload: confirm the
   * object landed in OCI with the expected size.
   */
  router.post('/projects/:projectId/git/info/lfs/objects/verify', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectId) return lfsError('projectId is required', 400)

    const denied = await authorizeLfs(c, projectId)
    if (denied) return denied

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return lfsError('Invalid JSON body', 422)
    }
    const oid = body?.oid
    const size = body?.size
    if (typeof oid !== 'string' || !isValidLfsOid(oid)) {
      return lfsError('invalid oid', 422)
    }

    const existing = await headLfsObject(lfsObjectKey(projectId, oid))
    if (!existing) return lfsError('object does not exist', 404)
    if (typeof size === 'number' && existing.size !== size) {
      return lfsError(`size mismatch: stored ${existing.size}, expected ${size}`, 422)
    }
    return new Response(null, { status: 200 })
  })

  return router
}

export default gitLfsRoutes
