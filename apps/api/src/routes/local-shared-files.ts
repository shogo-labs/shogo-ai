// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { readFile, realpath, stat } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { prisma } from '../lib/prisma'
import { verifySharedFileToken } from '../lib/shared-file-token'

export interface LocalSharedFileRoutesConfig {
  workspacesDir: string
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function filenameFor(path: string): string {
  const filename = path.split('/').pop() || 'download'
  return filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 255) || 'download'
}

async function projectRoot(projectId: string, workspacesDir: string): Promise<{
  root: string
  workspaceId: string
} | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      workingMode: true,
      projectFolders: {
        where: { isPrimary: true },
        select: { path: true },
        take: 1,
      },
    },
  })
  if (!project) return null

  const externalRoot = project.workingMode === 'external' ? project.projectFolders[0]?.path : undefined
  return {
    root: externalRoot || join(workspacesDir, projectId),
    workspaceId: project.workspaceId,
  }
}

export function localSharedFileRoutes(config: LocalSharedFileRoutesConfig): Hono {
  const app = new Hono()

  app.get('/api/f/:token', (c) => handleDownload(c))
  app.get('/f/:token', (c) => handleDownload(c))

  async function handleDownload(c: any): Promise<Response> {
    const payload = verifySharedFileToken(c.req.param('token'))
    if (!payload) {
      return c.json({ error: { code: 'not_found', message: 'This download link is invalid or expired' } }, 404)
    }

    try {
      const project = await projectRoot(payload.projectId, config.workspacesDir)
      if (!project || project.workspaceId !== payload.workspaceId) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }

      const root = await realpath(project.root)
      const candidate = resolve(root, payload.path)
      if (!isWithinRoot(root, candidate)) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }

      const target = await realpath(candidate)
      if (!isWithinRoot(root, target)) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }

      const metadata = await stat(target)
      if (!metadata.isFile()) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }

      const filename = filenameFor(payload.path)
      const extension = extname(filename).toLowerCase()
      const contentType = MIME_TYPES[extension] || 'application/octet-stream'
      const body = await readFile(target)
      return new Response(body, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(body.byteLength),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
      }
      console.error('[LocalSharedFiles] Download failed:', error?.message || error)
      return c.json({ error: { code: 'download_failed', message: 'File download failed' } }, 500)
    }
  }

  return app
}
