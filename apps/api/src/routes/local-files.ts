// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { readdir, readFile, writeFile, mkdir, stat, unlink } from 'fs/promises'
import { extname, join, relative } from 'path'
import { prisma } from '../lib/prisma'

export interface LocalFilesRoutesConfig {
  workspacesDir: string
}

type FileInfo = {
  path: string
  name: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
  lastModified?: string | null
}

const INCLUDED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.svg',
])
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.vite', '.cache',
])
const ALLOWED_DIRS = new Set(['test-results'])
const BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.ico': 'image/x-icon',
}
const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env$/,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa($|\.)/,
  /(^|\/)credentials($|\.)/,
]

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filePath))
}

async function listFilesRecursive(
  dir: string,
  basePath: string,
  files: FileInfo[] = [],
): Promise<FileInfo[]> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name)
      const filePath = relative(basePath, entryPath)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        files.push({ path: filePath, name: entry.name, type: 'directory' })
        await listFilesRecursive(entryPath, basePath, files)
        continue
      }
      const extension = extname(entry.name).toLowerCase()
      if (!INCLUDED_EXTENSIONS.has(extension)) continue
      try {
        const metadata = await stat(entryPath)
        files.push({
          path: filePath,
          name: entry.name,
          type: 'file',
          extension,
          size: metadata.size,
          lastModified: metadata.mtime.toISOString(),
        })
      } catch {
        // Ignore files that disappear while the tree is being read.
      }
    }
  } catch (error) {
    console.error('[LocalFiles] Error listing directory:', dir, error)
  }
  return files
}

export function localFilesRoutes(config: LocalFilesRoutesConfig): Hono {
  const router = new Hono()
  const { workspacesDir } = config

  async function getProjectPath(projectId: string): Promise<string | null> {
    const workspacePath = join(workspacesDir, projectId)
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      })
      if (project) return workspacePath
    } catch (error) {
      console.debug('[LocalFiles] Project lookup failed, checking directory:', error)
    }
    try {
      await stat(workspacePath)
      return workspacePath
    } catch {
      return null
    }
  }

  function validateFilePath(filePath: string): boolean {
    if (filePath.includes('..') || filePath.startsWith('/')) return false
    return filePath.split('/').every((part) => !EXCLUDED_DIRS.has(part) || ALLOWED_DIRS.has(part))
  }

  /**
   * `c.req.path` is the full URL path, including the `/api` mount, so a
   * prefix replace of `/projects/:id/files/` leaves a leading `/api`.
   */
  function fileSubPath(fullPath: string, projectId: string): string {
    const marker = `/projects/${projectId}/files/`
    const index = fullPath.indexOf(marker)
    if (index < 0) return ''
    return decodeURIComponent(fullPath.slice(index + marker.length))
  }

  router.get('/projects/:projectId/files', async (c) => {
    try {
      const projectPath = await getProjectPath(c.req.param('projectId'))
      if (!projectPath) {
        return c.json({ error: { code: 'project_not_found', message: 'Project not found' } }, 404)
      }
      const srcPath = join(projectPath, 'src')
      let files = await listFilesRecursive(srcPath, srcPath)
      files = files.map((file) => ({ ...file, path: `src/${file.path}` }))
      for (const name of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
        try {
          const filePath = join(projectPath, name)
          const metadata = await stat(filePath)
          files.push({
            path: name,
            name,
            type: 'file',
            extension: extname(name).toLowerCase(),
            size: metadata.size,
            lastModified: metadata.mtime.toISOString(),
          })
        } catch {
          // Optional root config.
        }
      }
      return c.json({ ok: true, files })
    } catch (error: any) {
      return c.json({ error: { code: 'list_failed', message: error?.message || 'Failed to list files' } }, 500)
    }
  })

  router.get('/projects/:projectId/files/*', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const filePath = fileSubPath(c.req.path, projectId)
      if (!filePath || !validateFilePath(filePath)) {
        return c.json({ error: { code: 'invalid_path', message: 'Invalid file path' } }, 400)
      }
      const projectPath = await getProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: { code: 'project_not_found', message: 'Project not found' } }, 404)
      }
      const fullPath = join(projectPath, filePath)
      const mimeType = BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
      if (mimeType) {
        const buffer = await readFile(fullPath)
        return new Response(buffer, {
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(buffer.byteLength),
            'Cache-Control': 'public, max-age=60',
          },
        })
      }
      return c.json({ ok: true, content: await readFile(fullPath, 'utf-8'), path: filePath })
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return c.json({ error: { code: 'file_not_found', message: 'File not found' } }, 404)
      }
      return c.json({ error: { code: 'read_failed', message: error?.message || 'Failed to read file' } }, 500)
    }
  })

  router.put('/projects/:projectId/files/*', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const filePath = fileSubPath(c.req.path, projectId)
      if (!filePath || !validateFilePath(filePath)) {
        return c.json({ error: { code: 'invalid_path', message: 'Invalid file path' } }, 400)
      }
      const projectPath = await getProjectPath(projectId)
      if (!projectPath) {
        return c.json({ error: { code: 'project_not_found', message: 'Project not found' } }, 404)
      }
      const body = await c.req.json<{ content?: unknown }>()
      if (typeof body.content !== 'string') {
        return c.json({ error: { code: 'invalid_body', message: 'Content is required' } }, 400)
      }
      const fullPath = join(projectPath, filePath)
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, body.content, 'utf-8')
      return c.json({ ok: true, path: filePath })
    } catch (error: any) {
      return c.json({ error: { code: 'write_failed', message: error?.message || 'Failed to write file' } }, 500)
    }
  })

  router.get('/projects/:projectId/workspace/manifest', async (c) => {
    const projectPath = await getProjectPath(c.req.param('projectId'))
    if (!projectPath) {
      return c.json({ error: { code: 'project_not_found', message: 'Project not found' } }, 404)
    }
    const files = (await listFilesRecursive(projectPath, projectPath))
      .filter((file) => file.type === 'file' && !isSensitivePath(file.path))
      .map(({ path, size, lastModified }) => ({ path, size: size ?? 0, lastModified, etag: null }))
    return c.json({
      ok: true,
      projectId: c.req.param('projectId'),
      files,
      source: 'filesystem',
      generatedAt: new Date().toISOString(),
    })
  })

  router.delete('/projects/:projectId/files/*', async (c) => {
    try {
      const projectId = c.req.param('projectId')
      const filePath = fileSubPath(c.req.path, projectId)
      if (!filePath || !validateFilePath(filePath) || isSensitivePath(filePath)) {
        return c.json({ error: { code: 'invalid_path', message: 'Invalid file path' } }, 400)
      }
      const projectPath = await getProjectPath(projectId)
      if (projectPath) {
        try {
          await unlink(join(projectPath, filePath))
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      return c.json({ ok: true, path: filePath })
    } catch (error: any) {
      return c.json({ error: { code: 'delete_failed', message: error?.message || 'Failed to delete file' } }, 500)
    }
  })

  return router
}
