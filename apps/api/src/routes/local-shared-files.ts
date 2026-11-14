// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { stat } from 'fs/promises'
import { fileRangeResponse } from '@shogo/shared-runtime'
import { describeSharedFileToken, diagnoseSharedFileToken, sharedFileLinkError } from '../lib/shared-file-token'
import { resolveLocalSharedFileTarget } from '../lib/local-shared-file-target'
import { mimeTypeForFile } from '../lib/local-file-mime'
import { isInlinePreviewContentType } from '../lib/shared-file-disposition'

export interface LocalSharedFileRoutesConfig {
  workspacesDir: string
}

function filenameFor(path: string): string {
  const filename = path.split('/').pop() || 'download'
  return filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 255) || 'download'
}

export function localSharedFileRoutes(config: LocalSharedFileRoutesConfig): Hono {
  const app = new Hono()

  app.get('/api/f/:token', (c) => handleDownload(c))
  app.get('/f/:token', (c) => handleDownload(c))

  async function handleDownload(c: any): Promise<Response> {
    const diagnosis = diagnoseSharedFileToken(c.req.param('token'))
    if (!diagnosis.ok) {
      // The token is a capability, not a secret: log which check failed and
      // what it claimed, so the next "the link doesn't work" is one grep.
      console.warn(`[LocalSharedFiles] Refused a download link: ${describeSharedFileToken(diagnosis)}`)
      const error = sharedFileLinkError(diagnosis.reason)
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    const payload = diagnosis.claims

    try {
      const resolvedFile = await resolveLocalSharedFileTarget({
        projectId: payload.projectId,
        workspaceId: payload.workspaceId,
        path: payload.path,
        workspacesDir: config.workspacesDir,
      })
      const target = resolvedFile?.target ?? null
      if (!target) {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }

      const metadata = await stat(target)
      if (!metadata.isFile()) {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }

      const filename = filenameFor(payload.path)
      const contentType = mimeTypeForFile(filename)
      // Pictures, video, audio and PDFs open in place: the chat preview and the
      // app's viewer need an `inline` answer (SHO-388). Media is streamed from
      // disk with `Range` support, so the viewer's `<video>` starts playing and
      // seeks without pulling the whole file down first (SHO-387).
      const disposition = isInlinePreviewContentType(contentType) ? 'inline' : 'attachment'
      return fileRangeResponse({
        file: Bun.file(target),
        size: metadata.size,
        rangeHeader: c.req.header('range'),
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `${disposition}; filename="${filename}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }
      console.error('[LocalSharedFiles] Download failed:', error?.message || error)
      return c.json({ error: { code: 'download_failed', message: 'File download failed' } }, 500)
    }
  }

  return app
}
