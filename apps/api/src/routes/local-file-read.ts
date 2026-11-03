// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Local-only read route for a file that is already on this machine's disk.
 *
 * On the desktop `share_file` hands out a `file://` URL, which a browser page
 * cannot fetch. The app's file viewer asks this route instead, by absolute
 * path, and serves the bytes from the same disk. It is mounted only by
 * `create-local-app.ts` — never in the cloud app — and it needs the desktop
 * session (unlike `/api/f/<token>`, where the token itself is the capability).
 */

import { Hono } from 'hono'
import { readFile, stat } from 'fs/promises'
import { resolveLocalAbsoluteFileTarget } from '../lib/local-shared-file-target'
import { mimeTypeForFile } from '../lib/local-file-mime'

export interface LocalFileReadRoutesConfig {
  workspacesDir: string
}

function filenameFor(path: string): string {
  const filename = path.split('/').pop() || 'file'
  return filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 255) || 'file'
}

export function localFileReadRoutes(config: LocalFileReadRoutesConfig): Hono {
  const app = new Hono()

  app.get('/api/local-files', async (c: any) => {
    const auth = c.get('auth') as { isAuthenticated?: boolean } | undefined
    if (!auth?.isAuthenticated) {
      return c.json({ error: { code: 'unauthorized', message: 'Sign in to open local files' } }, 401)
    }

    const path = c.req.query('path')
    if (!path) {
      return c.json({ error: { code: 'invalid_path', message: 'path is required' } }, 400)
    }

    let resolution
    try {
      resolution = await resolveLocalAbsoluteFileTarget({ path, workspacesDir: config.workspacesDir })
    } catch (error: any) {
      console.error('[LocalFileRead] Resolve failed:', error?.message || error)
      return c.json({ error: { code: 'read_failed', message: 'Could not read this file' } }, 500)
    }

    if (!resolution.ok) {
      if (resolution.reason === 'not_found') {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }
      return c.json({ error: { code: 'forbidden_path', message: 'Path is outside the allowed folders' } }, 403)
    }

    try {
      const metadata = await stat(resolution.target)
      if (!metadata.isFile()) {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }
      const filename = filenameFor(path)
      const body = await readFile(resolution.target)
      return new Response(body, {
        headers: {
          'Content-Type': mimeTypeForFile(filename),
          'Content-Disposition': `inline; filename="${filename}"`,
          'Content-Length': String(body.byteLength),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }
      console.error('[LocalFileRead] Read failed:', error?.message || error)
      return c.json({ error: { code: 'read_failed', message: 'Could not read this file' } }, 500)
    }
  })

  return app
}
