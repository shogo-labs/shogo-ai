// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Personal workspace's shared root (SHO-285 Update 2, section F).
 *
 * Two routes, both member-authorised and both scoped to a **Personal**
 * workspace, because that is the only workspace whose root is shared across
 * devices and the cloud:
 *
 *   GET  /workspaces/:workspaceId/root/manifest   what the durable copy holds
 *   POST /workspaces/:workspaceId/root/presign    signed read/write URLs
 *
 * Desktops hold no object-store credentials, so this is how they reach the
 * canonical copy: they pull the manifest on a timer and at the start of a
 * Personal turn, then upload their own writes to a signed URL. The cloud
 * workspace pod uses the same two answers through the internal route, so both
 * sides converge on one store (see `lib/workspace-root-files.ts`).
 */
import { Hono } from 'hono'
import { getWorkspaceKind, hasWorkspaceAccess } from '../services/workspace.service'
import {
  presignWorkspaceRoot,
  readWorkspaceRootManifest,
  type PresignRequest,
} from '../lib/workspace-root-files'

export interface WorkspaceRootRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

/** How many files one presign call may ask for. A root is tens of files. */
const MAX_PRESIGN_FILES = 200

export function workspaceRootRoutes(config: WorkspaceRootRoutesConfig): Hono {
  const router = new Hono()

  async function authorize(c: any): Promise<{ userId: string } | { res: Response }> {
    const workspaceId = c.req.param('workspaceId')
    const userId = await config.resolveUserId(c)
    if (!userId) return { res: c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401) }
    if (!(await hasWorkspaceAccess(workspaceId, userId))) {
      return { res: c.json({ error: { code: 'forbidden', message: 'No access to this workspace' } }, 403) }
    }
    // Only the Personal is shared across devices. Any other kind has its own
    // per-project archives and no root store, so answering here would be a
    // silent "your files synced" that never happened.
    const kind = await getWorkspaceKind(workspaceId)
    if (kind !== 'personal') {
      return {
        res: c.json(
          { error: { code: 'not_personal', message: 'Only a Personal workspace has a shared root.' } },
          400,
        ),
      }
    }
    return { userId }
  }

  /**
   * GET /workspaces/:workspaceId/root/manifest?since=<iso>
   *
   * `since` is where the caller's last successful pull ended: only objects
   * modified after it need a metadata HEAD, so a device polling every minute
   * costs one listing when nothing changed.
   */
  router.get('/workspaces/:workspaceId/root/manifest', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const sinceRaw = c.req.query('since')
    const since = sinceRaw ? new Date(sinceRaw) : null
    try {
      const manifest = await readWorkspaceRootManifest(c.req.param('workspaceId'), {
        since: since && !Number.isNaN(since.getTime()) ? since : null,
      })
      return c.json(manifest)
    } catch (err: any) {
      console.warn(`[WorkspaceRoot] manifest failed: ${err?.message ?? err}`)
      return c.json({ error: { code: 'root_manifest_failed', message: err?.message ?? 'Could not read the root' } }, 502)
    }
  })

  /**
   * POST /workspaces/:workspaceId/root/presign
   *   body: { files: [{ path, action: 'read'|'write', sha256?, instanceId?, contentType? }] }
   *
   * Same shape as `POST /projects/:projectId/s3/presign`. Paths outside the
   * shared root (logs, caches, local databases) are reported in `skipped`
   * rather than silently signing an upload that would never be pulled.
   */
  router.post('/workspaces/:workspaceId/root/presign', async (c) => {
    const auth = await authorize(c)
    if ('res' in auth) return auth.res
    const body = (await c.req.json().catch(() => null)) as { files?: PresignRequest[] } | null
    if (!body || !Array.isArray(body.files)) {
      return c.json({ error: { code: 'bad_request', message: 'files array is required' } }, 400)
    }
    if (body.files.length > MAX_PRESIGN_FILES) {
      return c.json(
        { error: { code: 'too_many_files', message: `At most ${MAX_PRESIGN_FILES} files per request` } },
        400,
      )
    }
    const malformed = body.files.find(
      (file) => !file || typeof file.path !== 'string' || (file.action !== 'read' && file.action !== 'write'),
    )
    if (malformed) {
      return c.json({ error: { code: 'bad_request', message: 'every file needs a path and an action' } }, 400)
    }
    try {
      const { urls, skipped } = await presignWorkspaceRoot(c.req.param('workspaceId'), body.files)
      return c.json({ ok: true, urls, skipped })
    } catch (err: any) {
      console.warn(`[WorkspaceRoot] presign failed: ${err?.message ?? err}`)
      return c.json({ error: { code: 'root_presign_failed', message: err?.message ?? 'Could not sign the request' } }, 502)
    }
  })

  return router
}
