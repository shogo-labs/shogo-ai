/**
 * Project Files API Routes
 *
 * Endpoints for reading and listing project source files.
 * Uses Prisma for project validation.
 *
 * Endpoints:
 * - GET /projects/:projectId/files - List all source files (from S3 or filesystem)
 * - GET /projects/:projectId/files/* - Get file content (filesystem fallback)
 * - PUT /projects/:projectId/files/* - Write file content (filesystem fallback)
 *
 * S3 Pre-signed URL endpoints:
 * - GET /projects/:projectId/s3/files - List all files from S3
 * - POST /projects/:projectId/s3/presign - Get pre-signed URLs for read/write
 */

import { Hono } from "hono"
import { readdir, readFile, writeFile, mkdir, stat } from "fs/promises"
import { join, relative, extname } from "path"
import { prisma } from "../lib/prisma"
import {
  getPresignedReadUrl,
  getPresignedWriteUrl,
  listAllObjectsInS3,
  isS3Enabled,
} from "../lib/s3"

/**
 * Configuration for files routes.
 */
export interface FilesRoutesConfig {
  /**
   * Directory containing project workspaces.
   */
  workspacesDir: string
}

/**
 * File extensions to include in the file tree.
 * Excludes node_modules, .git, dist, etc.
 */
const INCLUDED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.svg'
])

/**
 * Directories to exclude from listing.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.vite', '.cache'
])

/**
 * Map file extensions to MIME types for binary/media files.
 * Files with these extensions are served as raw binary with the correct content type.
 */
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

/**
 * File info returned by list endpoint.
 */
interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  extension?: string
  size?: number
}

/**
 * Recursively list files in a directory.
 */
async function listFilesRecursive(
  dir: string,
  basePath: string,
  files: FileInfo[] = []
): Promise<FileInfo[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      const relativePath = relative(basePath, entryPath)

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue
        }

        files.push({
          path: relativePath,
          name: entry.name,
          type: 'directory',
        })

        // Recurse into subdirectories
        await listFilesRecursive(entryPath, basePath, files)
      } else {
        const ext = extname(entry.name).toLowerCase()
        // Only include files with allowed extensions
        if (INCLUDED_EXTENSIONS.has(ext)) {
          try {
            const stats = await stat(entryPath)
            files.push({
              path: relativePath,
              name: entry.name,
              type: 'file',
              extension: ext,
              size: stats.size,
            })
          } catch {
            // Skip files we can't stat
          }
        }
      }
    }

    return files
  } catch (err) {
    console.error('[Files] Error listing directory:', dir, err)
    return files
  }
}

/**
 * Create files routes.
 *
 * @param config - Route configuration
 * @returns Hono router instance
 */
export function filesRoutes(config: FilesRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * Validate project/workspace exists and return workspace path.
   * First checks if project exists in database, then falls back to checking
   * if the workspace directory exists directly (for development).
   */
  async function getProjectPath(projectId: string): Promise<string | null> {
    const workspacePath = join(workspacesDir, projectId)

    try {
      // First try to check if project exists in database
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      })
      if (project) {
        return workspacePath
      }
    } catch (err) {
      // Database lookup failed - fall through to directory check
      console.debug('[Files] Project database lookup failed, checking directory:', err)
    }

    // Fallback: check if workspace directory exists directly
    // This allows file access for workspaces created manually or via template
    try {
      await stat(workspacePath)
      return workspacePath
    } catch {
      // Directory doesn't exist
      return null
    }
  }

  /**
   * Directories that are always allowed even though they would normally be excluded.
   * test-results contains Playwright screenshots/traces/videos.
   */
  const ALLOWED_DIRS = new Set(['test-results'])

  /**
   * Validate file path to prevent directory traversal.
   */
  function validateFilePath(filePath: string): boolean {
    // Prevent directory traversal
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return false
    }
    // Prevent access to excluded directories (but allow test-results)
    const parts = filePath.split('/')
    for (const part of parts) {
      if (EXCLUDED_DIRS.has(part) && !ALLOWED_DIRS.has(part)) {
        return false
      }
    }
    return true
  }

  /**
   * GET /projects/:projectId/files - List all source files
   */
  router.get("/projects/:projectId/files", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      const projectPath = await getProjectPath(projectId)
      if (!projectPath) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      // List files in src directory primarily
      const srcPath = join(projectPath, "src")
      let files: FileInfo[] = []

      // Try to list src directory first
      try {
        files = await listFilesRecursive(srcPath, srcPath)
        // Prefix paths with src/
        files = files.map(f => ({
          ...f,
          path: `src/${f.path}`,
        }))
      } catch {
        // src doesn't exist, try listing from project root
      }

      // Also include root config files
      const rootConfigFiles = [
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
      ]

      for (const fileName of rootConfigFiles) {
        const filePath = join(projectPath, fileName)
        try {
          const stats = await stat(filePath)
          files.push({
            path: fileName,
            name: fileName,
            type: 'file',
            extension: extname(fileName).toLowerCase(),
            size: stats.size,
          })
        } catch {
          // File doesn't exist, skip
        }
      }

      return c.json({ ok: true, files }, 200)
    } catch (error: any) {
      console.error("[Files] List error:", error)
      return c.json(
        { error: { code: "list_failed", message: error.message || "Failed to list files" } },
        500
      )
    }
  })

  /**
   * GET /projects/:projectId/files/* - Get file content
   */
  router.get("/projects/:projectId/files/*", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      // Extract file path from the wildcard
      const filePath = c.req.path.replace(`/projects/${projectId}/files/`, '')

      if (!filePath) {
        return c.json(
          { error: { code: "invalid_path", message: "File path is required" } },
          400
        )
      }

      if (!validateFilePath(filePath)) {
        return c.json(
          { error: { code: "invalid_path", message: "Invalid file path" } },
          400
        )
      }

      const projectPath = await getProjectPath(projectId)
      if (!projectPath) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      const fullPath = join(projectPath, filePath)

      try {
        // Check if this is a binary/media file that should be served raw
        const ext = extname(filePath).toLowerCase()
        const mimeType = BINARY_MIME_TYPES[ext]

        if (mimeType) {
          // Serve binary files with correct content type (images, videos, zips)
          const buffer = await readFile(fullPath)
          return new Response(buffer, {
            status: 200,
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(buffer.byteLength),
              'Cache-Control': 'public, max-age=60',
            },
          })
        }

        // Text files: return as JSON (existing behavior)
        const content = await readFile(fullPath, 'utf-8')
        return c.json({ ok: true, content, path: filePath }, 200)
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return c.json(
            { error: { code: "file_not_found", message: `File not found: ${filePath}` } },
            404
          )
        }
        throw err
      }
    } catch (error: any) {
      console.error("[Files] Read error:", error)
      return c.json(
        { error: { code: "read_failed", message: error.message || "Failed to read file" } },
        500
      )
    }
  })

  /**
   * PUT /projects/:projectId/files/* - Write file content
   */
  router.put("/projects/:projectId/files/*", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      // Extract file path from the wildcard
      const filePath = c.req.path.replace(`/projects/${projectId}/files/`, '')

      if (!filePath) {
        return c.json(
          { error: { code: "invalid_path", message: "File path is required" } },
          400
        )
      }

      if (!validateFilePath(filePath)) {
        return c.json(
          { error: { code: "invalid_path", message: "Invalid file path" } },
          400
        )
      }

      const projectPath = await getProjectPath(projectId)
      if (!projectPath) {
        return c.json(
          { error: { code: "project_not_found", message: "Project not found" } },
          404
        )
      }

      const body = await c.req.json<{ content: string }>()
      if (typeof body.content !== 'string') {
        return c.json(
          { error: { code: "invalid_body", message: "Content is required" } },
          400
        )
      }

      const fullPath = join(projectPath, filePath)

      // Ensure directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
      if (dir && dir !== projectPath) {
        await mkdir(dir, { recursive: true })
      }

      await writeFile(fullPath, body.content, 'utf-8')
      return c.json({ ok: true, path: filePath }, 200)
    } catch (error: any) {
      console.error("[Files] Write error:", error)
      return c.json(
        { error: { code: "write_failed", message: error.message || "Failed to write file" } },
        500
      )
    }
  })

  // ===========================================================================
  // S3 Pre-signed URL Routes
  // ===========================================================================

  /**
   * S3 bucket and key configuration for project files.
   */
  const S3_WORKSPACES_BUCKET = process.env.S3_WORKSPACES_BUCKET || 'shogo-workspaces'

  /**
   * Build S3 key for a project file.
   */
  function buildProjectFileKey(projectId: string, filePath: string): string {
    return `${projectId}/${filePath}`
  }

  /**
   * GET /projects/:projectId/s3/files - List all files from S3
   */
  router.get("/projects/:projectId/s3/files", async (c) => {
    try {
      const projectId = c.req.param("projectId")
      const prefix = `${projectId}/`

      const objects = await listAllObjectsInS3(prefix, S3_WORKSPACES_BUCKET)

      // Transform to FileInfo format
      const files: FileInfo[] = objects
        .filter(obj => {
          // Only include files with allowed extensions
          const ext = extname(obj.relativePath).toLowerCase()
          return INCLUDED_EXTENSIONS.has(ext)
        })
        .filter(obj => {
          // Exclude files in excluded directories
          const parts = obj.relativePath.split('/')
          return !parts.some(part => EXCLUDED_DIRS.has(part))
        })
        .map(obj => ({
          path: obj.relativePath,
          name: obj.relativePath.split('/').pop() || obj.relativePath,
          type: 'file' as const,
          extension: extname(obj.relativePath).toLowerCase(),
          size: obj.size,
        }))

      // Add directory entries for unique parent paths
      const dirs = new Set<string>()
      for (const file of files) {
        const parts = file.path.split('/')
        let currentPath = ''
        for (let i = 0; i < parts.length - 1; i++) {
          currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]
          dirs.add(currentPath)
        }
      }

      const dirEntries: FileInfo[] = Array.from(dirs).map(dirPath => ({
        path: dirPath,
        name: dirPath.split('/').pop() || dirPath,
        type: 'directory' as const,
      }))

      // Combine and sort: directories first, then alphabetically
      const allFiles = [...dirEntries, ...files].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.path.localeCompare(b.path)
      })

      return c.json({ ok: true, files: allFiles, source: 's3' }, 200)
    } catch (error: any) {
      console.error("[Files] S3 list error:", error)
      return c.json(
        { error: { code: "s3_list_failed", message: error.message || "Failed to list S3 files" } },
        500
      )
    }
  })

  /**
   * POST /projects/:projectId/s3/presign - Get pre-signed URLs
   *
   * Request body:
   * {
   *   files: [
   *     { path: "src/App.tsx", action: "read" },
   *     { path: "src/App.tsx", action: "write", contentType: "text/typescript" }
   *   ]
   * }
   *
   * Response:
   * {
   *   ok: true,
   *   urls: [
   *     { path: "src/App.tsx", action: "read", url: "https://..." },
   *     { path: "src/App.tsx", action: "write", url: "https://..." }
   *   ]
   * }
   */
  router.post("/projects/:projectId/s3/presign", async (c) => {
    try {
      const projectId = c.req.param("projectId")

      const body = await c.req.json<{
        files: Array<{
          path: string
          action: 'read' | 'write'
          contentType?: string
        }>
      }>()

      if (!body.files || !Array.isArray(body.files)) {
        return c.json(
          { error: { code: "invalid_body", message: "files array is required" } },
          400
        )
      }

      const urls = await Promise.all(
        body.files.map(async (file) => {
          const key = buildProjectFileKey(projectId, file.path)

          if (file.action === 'write') {
            const url = await getPresignedWriteUrl(key, {
              bucket: S3_WORKSPACES_BUCKET,
              contentType: file.contentType || 'application/octet-stream',
            })
            return { path: file.path, action: file.action, url }
          } else {
            const url = await getPresignedReadUrl(key, { bucket: S3_WORKSPACES_BUCKET })
            return { path: file.path, action: file.action, url }
          }
        })
      )

      return c.json({ ok: true, urls }, 200)
    } catch (error: any) {
      console.error("[Files] S3 presign error:", error)
      return c.json(
        { error: { code: "s3_presign_failed", message: error.message || "Failed to generate pre-signed URLs" } },
        500
      )
    }
  })

  return router
}

export default filesRoutes
