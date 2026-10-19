// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace-level export and import.
 *
 * Mounted at `/api/workspaces` on both composers (cloud `server.ts` and the
 * desktop's `create-local-app.ts`) so the route cannot exist on one surface and
 * not the other. A cloud workspace opened from the desktop is relayed by
 * `routes/local-cloud-proxy.ts`, which passes a non-JSON body through
 * untouched — the archive streams over the relay with no extra work.
 */

import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { decide, denialResponse, loadAccess, principalOf } from '../lib/authz'
import { pinWorkspaceRoutesToHomeRegion } from '../lib/chat-region-pin'
import type { AuthContext } from '../middleware/auth'
import { WorkspaceExportTooLargeError } from '../services/workspace-export/archive'
import {
  buildWorkspaceArchive,
  estimateWorkspaceExport,
  WorkspaceExportError,
} from '../services/workspace-export/export'
import {
  importWorkspace,
  WorkspaceImportError,
} from '../services/workspace-export/import'

/** Free/Basic get a smaller archive; Pro+ the full size (same tiers as project import). */
const MAX_EXPORT_BYTES_PRO = 500 * 1024 * 1024
const MAX_EXPORT_BYTES_FREE = 50 * 1024 * 1024

function errorResponse(c: any, status: number, code: string, message: string, extra: object = {}) {
  return c.json({ error: { code, message, ...extra } }, status as any)
}

/**
 * Stream a finished temp archive back to the client and delete it (with its
 * temp directory) as soon as the stream closes — whether it finished, errored
 * or the client disconnected.
 */
function archiveResponse(tempPath: string, bytes: number, filename: string): Response {
  const dir = dirname(tempPath)
  const stream = createReadStream(tempPath)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => {
        controller.enqueue(new Uint8Array(chunk as Buffer))
      })
      stream.on('end', () => {
        controller.close()
        rmSync(dir, { recursive: true, force: true })
      })
      stream.on('error', (err) => {
        controller.error(err)
        rmSync(dir, { recursive: true, force: true })
      })
    },
    cancel() {
      stream.destroy()
      rmSync(dir, { recursive: true, force: true })
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(bytes),
      'Cache-Control': 'no-store',
    },
  })
}

export function workspaceExportRoutes(): Hono {
  const app = new Hono()

  // An export reads model rows *and* every project's files, so it must run
  // where the workspace's runtimes live. Same pin as the workspace runtime
  // routes; a no-op in single-region, local and desktop.
  app.use('/:workspaceId/export', pinWorkspaceRoutesToHomeRegion())
  app.use('/:workspaceId/export/estimate', pinWorkspaceRoutesToHomeRegion())

  const authorizeExport = async (c: any, workspaceId: string) => {
    const principal = principalOf(c)
    const access = await loadAccess(principal, { workspaceId })
    const decision = await decide(access, 'workspace:export', principal, `${c.req.method} ${c.req.path}`)
    return decision
  }

  const runExport = async (
    c: any,
    body: { includeAllDms?: boolean; includeAttachments?: boolean; password?: string },
  ) => {
    const workspaceId = c.req.param('workspaceId')
    const decision = await authorizeExport(c, workspaceId)
    if (!decision.ok) return denialResponse(c, decision)
    const principal = principalOf(c)
    if (!principal.userId) {
      return errorResponse(c, 401, 'unauthorized', 'Authentication required')
    }
    // "Owner opt-in" means owner: an admin runs the workspace but is not the
    // person who answers for everyone else's DMs.
    const isOwner = decision.access.workspaceRole === 'owner'
    const cap = await workspaceExportCapBytes(workspaceId)

    let result
    try {
      result = await buildWorkspaceArchive({
        workspaceId,
        requesterId: principal.userId,
        isOwner,
        options: {
          includeAllDms: body.includeAllDms === true,
          includeAttachments: body.includeAttachments !== false,
          password: typeof body.password === 'string' ? body.password : undefined,
        },
        limits: { maxTotalBytes: cap, maxFiles: 20_000 },
      })
    } catch (err: any) {
      if (err instanceof WorkspaceExportTooLargeError) {
        return errorResponse(c, 413, err.code, err.message, {
          limit: err.limit,
          observed: err.observed,
          cap: err.cap,
          contributors: err.contributors,
        })
      }
      if (err instanceof WorkspaceExportError) {
        return errorResponse(c, err.status, err.code, err.message)
      }
      console.error('[workspace-export] failed:', err)
      return errorResponse(
        c,
        500,
        'workspace_export_failed',
        err?.message || 'The workspace could not be exported.',
      )
    }

    const name = result.manifest.workspace.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'workspace'
    return archiveResponse(result.tempPath, result.bytes, `${name}.shogo-workspace.zip`)
  }

  // POST /:workspaceId/export — body carries the optional archive password, so
  // a password never lands in a URL, a log line or browser history.
  app.post('/:workspaceId/export', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      includeAllDms?: boolean
      includeAttachments?: boolean
      password?: string
    }
    return runExport(c, body)
  })

  // GET /:workspaceId/export — for native clients, whose download manager
  // (`expo-file-system`) can only stream a GET. Every option rides in a header
  // (never the query string): a password in a URL ends up in access logs, proxy
  // logs and the archive's own download history.
  app.get('/:workspaceId/export', async (c) => {
    const header = (name: string) => c.req.header(name) || undefined
    return runExport(c, {
      includeAllDms: header('x-workspace-export-all-dms') === 'true',
      includeAttachments: header('x-workspace-export-attachments') !== 'false',
      password: header('x-workspace-export-password'),
    })
  })

  // GET /:workspaceId/export/estimate — cheap counts + bytes for the settings screen.
  app.get('/:workspaceId/export/estimate', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const decision = await authorizeExport(c, workspaceId)
    if (!decision.ok) return denialResponse(c, decision)
    try {
      const estimate = await estimateWorkspaceExport(workspaceId)
      return c.json({
        workspaceId,
        workspace: estimate.workspace,
        models: estimate.models,
        projects: estimate.projects,
        totals: estimate.totals,
        warnings: estimate.warnings,
        limits: { bytes: await workspaceExportCapBytes(workspaceId) },
      })
    } catch (err: any) {
      if (err instanceof WorkspaceExportError) {
        return errorResponse(c, err.status, err.code, err.message)
      }
      return errorResponse(c, 500, 'workspace_estimate_failed', err?.message || 'Estimate failed.')
    }
  })

  // POST /import — multipart: file, name?, password?, dryRun?
  //
  // No workspace permission: the target workspace does not exist yet. The
  // caller becomes its owner, and every other member is matched by email.
  app.post('/import', async (c) => {
    const auth = c.get('auth') as AuthContext | undefined
    if (!auth?.isAuthenticated || !auth.userId) {
      return errorResponse(c, 401, 'unauthorized', 'Authentication required')
    }

    const contentType = c.req.header('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return errorResponse(
        c,
        400,
        'workspace_import_bad_request',
        'Expected multipart/form-data with a file upload.',
      )
    }

    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return errorResponse(c, 400, 'workspace_import_bad_request', 'Missing file in form data.')
    }

    const cap = await workspaceImportCapBytes(auth.userId)
    if (file.size > cap) {
      return errorResponse(c, 413, 'workspace_import_too_large', importTooLargeMessage(cap), {
        cap,
        observed: file.size,
      })
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > cap) {
      return errorResponse(c, 413, 'workspace_import_too_large', importTooLargeMessage(cap), {
        cap,
        observed: bytes.byteLength,
      })
    }

    const name = typeof form.get('name') === 'string' ? String(form.get('name')) : undefined
    const password =
      (typeof form.get('password') === 'string' ? String(form.get('password')) : '') ||
      (typeof form.get('passphrase') === 'string' ? String(form.get('passphrase')) : '')
    const dryRun = String(form.get('dryRun') ?? '') === 'true'
    // `replace`/`merge` are deliberately unsupported in v1.
    const mode = String(form.get('mode') ?? 'create')
    if (mode !== 'create') {
      return errorResponse(
        c,
        400,
        'workspace_import_mode_unsupported',
        'Workspace import only creates a new workspace. Merging into an existing one needs per-model conflict rules and is not supported yet.',
      )
    }

    try {
      const report = await importWorkspace({
        archive: bytes,
        requesterId: auth.userId,
        name,
        password,
        dryRun,
      })
      return c.json(report)
    } catch (err: any) {
      if (err instanceof WorkspaceImportError) {
        return errorResponse(c, err.status, err.code, err.message)
      }
      console.error('[workspace-import] failed:', err)
      return errorResponse(
        c,
        500,
        'workspace_import_failed',
        err?.message || 'The archive could not be imported.',
      )
    }
  })

  return app
}

function importTooLargeMessage(cap: number): string {
  const mb = Math.round(cap / (1024 * 1024))
  return cap >= MAX_EXPORT_BYTES_PRO
    ? `Workspace archives are limited to ${mb} MB.`
    : `Importing a workspace is limited to ${mb} MB on the Free and Basic plans. Upgrade to Pro to import up to 500 MB.`
}

async function billingTierIsProPlus(workspaceId: string): Promise<boolean> {
  try {
    const billing = await import('../services/billing.service')
    return await billing.hasAdvancedModelAccess(workspaceId)
  } catch {
    return false
  }
}

/** Archive cap for a workspace export, following the plan of the workspace's owner. */
async function workspaceExportCapBytes(workspaceId: string): Promise<number> {
  return (await billingTierIsProPlus(workspaceId)) ? MAX_EXPORT_BYTES_PRO : MAX_EXPORT_BYTES_FREE
}

/** A user's plan, resolved from any workspace they own; Free/Basic otherwise. */
async function workspaceImportCapBytes(userId: string): Promise<number> {
  try {
    const { prisma } = await import('../lib/prisma')
    const membership = await prisma.member.findFirst({
      where: { userId, role: 'owner', workspaceId: { not: null } },
      select: { workspaceId: true },
    })
    if (membership?.workspaceId && (await billingTierIsProPlus(membership.workspaceId))) {
      return MAX_EXPORT_BYTES_PRO
    }
  } catch {
    /* fall through to the free cap */
  }
  return MAX_EXPORT_BYTES_FREE
}
