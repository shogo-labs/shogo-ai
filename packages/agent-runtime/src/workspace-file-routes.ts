// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace file API: tree, read, write, delete, mkdir and download.
 *
 * Two path spaces:
 *
 *   - default         — relative to `WORKSPACE_DIR`. On a workspace runtime
 *                       that is the merged root (Shogo scaffolding plus one
 *                       link per mounted project / linked folder). Used by the
 *                       agent-files panel, chat downloads and canvas.
 *   - `?scope=project` — relative to the runtime's own project (see
 *                       `projectScopeRoot`). Used by the IDE, whose tree,
 *                       editor paths and Source Control all live in the
 *                       project's path space.
 *
 * Mounted by `server.ts`; a factory (like `runtime-lsp-routes.ts`) so the
 * handlers can be exercised against a real directory without booting the
 * side-effectful server module.
 */

import { Hono } from 'hono'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, extname, join, relative, resolve } from 'path'
import { isBinaryBuffer, isBinaryFilePath } from '@shogo-ai/sdk/file-types'
import { isWithinRoot } from './path-boundary'
import {
  walkFilesTree,
  WORKSPACE_TREE_HIDDEN_DIRS,
  WORKSPACE_TREE_HIDDEN_FILES,
  WORKSPACE_TREE_LAZY_DIRS,
} from './fs-tree-walker'
import type { CanvasEvent } from './canvas-file-watcher'

/**
 * Resolve `subPath` under `root`, or null if it escapes. `isWithinRoot` is
 * separator- and case-aware; a bare `startsWith(root)` accepts a sibling such
 * as `<root>-evil` and is case-sensitive on Windows.
 */
export function resolveWithinRoot(root: string, subPath: string): string | null {
  const base = resolve(root)
  const resolved = resolve(base, subPath)
  return isWithinRoot(base, resolved) ? resolved : null
}

/**
 * The project's content root: `<workspaceDir>/<anchorId>` on a workspace
 * runtime (a folder-linked project's own folder, or `workspaces/<id>` for a
 * managed one), `workspaceDir` itself on a single-project runtime or before
 * the anchor mount exists.
 */
export function projectScopeRoot(workspaceDir: string, anchorId: string | undefined): string {
  if (anchorId) {
    const anchorDir = join(workspaceDir, anchorId)
    if (existsSync(anchorDir)) return anchorDir
  }
  return workspaceDir
}

/** POSIX path of `absPath` relative to `workspaceDir` — the canvas watcher's event path space. */
export function workspaceRelativePath(workspaceDir: string, absPath: string): string {
  return relative(resolve(workspaceDir), absPath).split('\\').join('/')
}

/**
 * Map a merged-root watcher event into the path space rooted at `scopePrefix`
 * (a `workspaceRelativePath` of the scope root; '' = no scoping). File events
 * outside the scope return null.
 */
export function scopeCanvasEvent(event: CanvasEvent, scopePrefix: string): CanvasEvent | null {
  if (!scopePrefix || (event.type !== 'file.changed' && event.type !== 'file.deleted')) return event
  if (!event.path.startsWith(`${scopePrefix}/`)) return null
  return { ...event, path: event.path.slice(scopePrefix.length + 1) }
}

function isDirectoryPath(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory()
  } catch {
    return false
  }
}

const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

export interface WorkspaceFileRoutesConfig {
  workspaceDir: string
  /** The agent-files area (`<workspaceDir>/files`), fallback for unscoped reads and unscoped mkdir. */
  filesDir: string
  /** Root for `?scope=project` requests. */
  getProjectRoot: () => string
  /** Paths are `workspaceRelativePath`s, whatever scope the request used. */
  onFileWritten?: (workspaceRelative: string, absolutePath: string) => void
  onFileDeleted?: (workspaceRelative: string) => void
}

export function workspaceFileRoutes(config: WorkspaceFileRoutesConfig) {
  const { workspaceDir, filesDir, getProjectRoot } = config
  const app = new Hono()

  const requestRoot = (c: { req: { query(name: string): string | undefined } }) =>
    c.req.query('scope') === 'project'
      ? { root: getProjectRoot(), scoped: true }
      : { root: workspaceDir, scoped: false }

  // Recursive file tree for the file browser UI.
  //
  // Without `?path=`, walks from the root. With `?path=<rel>`, walks just
  // that subtree — used by the IDE to lazy-load `node_modules/`, `dist/`,
  // and friends only when the user expands them. The same three exclusion
  // sets apply at every depth, so a `node_modules/foo/node_modules` nested
  // dep still comes back as a `lazy: true` entry rather than recursing.
  app.get('/agent/workspace/tree', async (c) => {
    const subPath = c.req.query('path') ?? ''
    const rootResolved = resolve(requestRoot(c).root)
    let startDir = rootResolved
    if (subPath) {
      const resolved = resolveWithinRoot(rootResolved, subPath)
      if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)
      if (!existsSync(resolved)) return c.json({ error: 'Path not found' }, 404)
      if (!statSync(resolved).isDirectory()) {
        return c.json({ error: 'Path is not a directory' }, 400)
      }
      startDir = resolved
    }
    // `eagerDepth: 1` keeps first-paint cheap on big repos — the walker
    // returns the requested dir's children plus one level of descent, with
    // anything deeper marked `lazy: true`. The IDE fetches deeper subtrees
    // on demand by hitting this same route with `?path=…`. See
    // `apps/mobile/components/project/panels/ide/workspace/desktopFs.ts`
    // and `sdkFs.ts` for the IDE-side handling.
    // `signal: c.req.raw.signal` wires Hono's per-request abort straight
    // into the walker, so a superseded request stops reading directories.
    const tree = await walkFilesTree(startDir, rootResolved, {
      hiddenDirs: WORKSPACE_TREE_HIDDEN_DIRS,
      lazyDirs: WORKSPACE_TREE_LAZY_DIRS,
      hiddenFiles: WORKSPACE_TREE_HIDDEN_FILES,
      eagerDepth: 1,
      signal: c.req.raw.signal,
    })
    return c.json({ tree })
  })

  // Read a file. Text files come back as `content` (utf-8 string); binary
  // files come back as `contentBase64` (base64-encoded raw bytes) — see
  // `isBinaryFilePath` (canonical extension list in
  // `@shogo-ai/core/file-types`). Callers must branch on the `encoding`
  // field; the SDK's `readFile()` does this for you and throws if asked to
  // text-read a binary file.
  app.get('/agent/workspace/files/*', (c) => {
    const subPath = c.req.path.replace('/agent/workspace/files/', '')
    if (!subPath) return c.json({ error: 'Path required' }, 400)

    const { root, scoped } = requestRoot(c)
    const resolved = resolveWithinRoot(root, subPath)
    if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)

    let target = resolved
    if (!existsSync(resolved)) {
      // The `files/` fallback belongs to the agent-files panel's path space.
      const fallback = scoped ? null : resolveWithinRoot(filesDir, subPath)
      if (!fallback || !existsSync(fallback)) {
        return c.json({ error: 'File not found' }, 404)
      }
      target = fallback
    }
    if (isDirectoryPath(target)) return c.json({ error: 'Path is a directory' }, 400)

    const buf = readFileSync(target)
    if (isBinaryFilePath(target) || isBinaryBuffer(buf)) {
      return c.json({
        path: subPath,
        contentBase64: buf.toString('base64'),
        encoding: 'base64',
        bytes: buf.length,
      })
    }

    const content = buf.toString('utf-8')
    return c.json({ path: subPath, content, encoding: 'utf-8', bytes: content.length })
  })

  // Write/create a file. Accepts either:
  //   { content: "<utf-8 string>" }                — text files
  //   { contentBase64: "<base64-encoded bytes>" } — binary files
  //
  // Refuses utf-8 `content` for any path that `isBinaryFilePath` flags, so a
  // read-as-utf-8 / write-as-utf-8 round-trip can't corrupt binary files —
  // callers MUST send `contentBase64` for those.
  app.put('/agent/workspace/files/*', async (c) => {
    const subPath = c.req.path.replace('/agent/workspace/files/', '')
    if (!subPath) return c.json({ error: 'Path required' }, 400)

    const resolved = resolveWithinRoot(requestRoot(c).root, subPath)
    if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)
    if (isDirectoryPath(resolved)) return c.json({ error: 'Path is a directory' }, 400)
    const eventPath = workspaceRelativePath(workspaceDir, resolved)

    const body = (await c.req.json()) as { content?: unknown; contentBase64?: unknown }
    mkdirSync(dirname(resolved), { recursive: true })

    if (typeof body.contentBase64 === 'string') {
      let buf: Buffer
      try {
        buf = Buffer.from(body.contentBase64, 'base64')
      } catch {
        return c.json({ error: 'Invalid base64 in contentBase64' }, 400)
      }
      writeFileSync(resolved, buf)
      config.onFileWritten?.(eventPath, resolved)
      return c.json({
        ok: true,
        path: subPath,
        bytes: buf.length,
        encoding: 'base64',
      })
    }

    if (typeof body.content !== 'string') {
      return c.json(
        { error: 'Missing content (utf-8 string) or contentBase64' },
        400,
      )
    }

    const existingBytes = existsSync(resolved) ? readFileSync(resolved) : null
    if (isBinaryFilePath(resolved) || (existingBytes && isBinaryBuffer(existingBytes))) {
      return c.json(
        {
          error:
            'Refusing to write a binary file path with utf-8 string content — use contentBase64 to avoid corruption',
          path: subPath,
        },
        400,
      )
    }

    writeFileSync(resolved, body.content, 'utf-8')
    config.onFileWritten?.(eventPath, resolved)
    return c.json({
      ok: true,
      path: subPath,
      bytes: body.content.length,
      encoding: 'utf-8',
    })
  })

  app.delete('/agent/workspace/files/*', (c) => {
    const subPath = c.req.path.replace('/agent/workspace/files/', '')
    if (!subPath) return c.json({ error: 'Path required' }, 400)

    const resolved = resolveWithinRoot(requestRoot(c).root, subPath)
    if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)
    if (!existsSync(resolved)) return c.json({ error: 'File not found' }, 404)
    if (isDirectoryPath(resolved)) return c.json({ error: 'Path is a directory' }, 400)

    unlinkSync(resolved)
    config.onFileDeleted?.(workspaceRelativePath(workspaceDir, resolved))
    return c.json({ ok: true, deleted: subPath })
  })

  // Create a directory. Unscoped, this is the agent-files panel's "New
  // Folder" and resolves under `files/`; with `?scope=project` (the IDE) it
  // resolves against the project root like every other scoped route.
  app.post('/agent/workspace/mkdir', async (c) => {
    const { path: dirPath } = await c.req.json() as { path: string }
    if (!dirPath) return c.json({ error: 'Path required' }, 400)

    const { root, scoped } = requestRoot(c)
    const resolved = scoped ? resolveWithinRoot(root, dirPath) : resolveWithinRoot(filesDir, dirPath)
    if (!resolved) return c.json({ error: scoped ? 'Path outside workspace' : 'Path outside files directory' }, 400)

    mkdirSync(resolved, { recursive: true })
    return c.json({ ok: true, path: dirPath })
  })

  app.get('/agent/workspace/download/*', (c) => {
    const subPath = c.req.path.replace('/agent/workspace/download/', '')
    if (!subPath) return c.json({ error: 'Path required' }, 400)

    const { root, scoped } = requestRoot(c)
    let resolved = resolveWithinRoot(root, subPath)
    if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)

    if (!existsSync(resolved)) {
      const fallback = scoped ? null : resolveWithinRoot(filesDir, subPath)
      if (fallback && existsSync(fallback)) {
        resolved = fallback
      } else {
        return c.json({ error: 'File not found' }, 404)
      }
    }
    if (isDirectoryPath(resolved)) return c.json({ error: 'Path is a directory' }, 400)

    const content = readFileSync(resolved)
    const fileName = subPath.split('/').pop() || 'download'
    const ext = extname(fileName).toLowerCase()
    const contentType = DOWNLOAD_MIME_TYPES[ext] || 'application/octet-stream'
    const isInline = contentType.startsWith('image/') || contentType === 'application/pdf'

    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename="${fileName}"`,
        'Content-Length': String(content.length),
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
      },
    })
  })

  return app
}
