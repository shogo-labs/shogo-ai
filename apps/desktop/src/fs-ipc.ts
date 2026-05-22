// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Filesystem IPC fast-path for the desktop IDE.
 *
 * Why this exists:
 *   The IDE's Monaco file tree, Quick Open, and editor reads normally hit
 *   the per-project agent-runtime over HTTP (see `SdkFs` in
 *   `apps/mobile/components/project/panels/ide/workspace/sdkFs.ts`). On
 *   desktop in local mode the agent-runtime is just another process on the
 *   same machine reading the same disk — round-tripping through Hono +
 *   loopback HTTP for a `readdir` is pure overhead. Worse, the renderer
 *   has to wait for the agent-runtime to fully spawn before it can show
 *   anything in the tree.
 *
 *   This module exposes a minimal IPC surface that walks + reads the
 *   workspace directly from Electron main, so the IDE can render the file
 *   tree the moment the user opens a project, before the agent-runtime is
 *   even up.
 *
 * Scope (intentional, phase 2 MVP):
 *   - Tree listing (initial + lazy subtree fetches) goes through IPC.
 *   - File text reads go through IPC.
 *   - Writes / mkdir / delete / rename still go through the SDK / HTTP so
 *     the agent-runtime's file watcher + RAG indexer stay authoritative
 *     for mutations. The renderer-side `DesktopFs` wraps an `SdkFs` and
 *     delegates those methods.
 *   - SSE `file.changed` subscription stays on the HTTP path (same reason).
 *   - Only managed projects (workspaces under `getWorkspacesDir()`) are
 *     resolvable via IPC. External (VS Code-style folder-bound) projects
 *     return null from `fs:resolveWorkspace` and the renderer falls back
 *     to the HTTP `SdkFs` path. Adding external support is straightforward
 *     once the projects table can be queried from main, but it requires a
 *     DB-access path we're deferring.
 *
 * Security:
 *   Every IPC call validates the supplied `root` against
 *   `getWorkspacesDir()`, and every subPath is resolved + verified to live
 *   under that root. A malicious renderer cannot list /etc/passwd by
 *   passing a spoofed root, or escape a real workspace via `../../`.
 *   Symlinks INSIDE a workspace are followed (a project may legitimately
 *   symlink its own files); we never follow OUT of the workspace because
 *   the post-resolve prefix check would catch it.
 */

import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspacesDir } from './paths'
// Single source of truth for the file-tree policy. Types come from the
// ambient declaration at `src/types/agent-runtime-fs-tree-walker.d.ts`
// (the real source lives outside `tsconfig.json`'s rootDir, so importing
// it via a relative path trips TS6059 at compile time — that was the
// regression that bricked the v1.8.0 + v1.8.1 desktop release builds).
// The actual implementation is inlined into `dist/main.js` at bundle
// time by `scripts/bundle-main.mjs`, which symlinks
// `node_modules/@shogo/agent-runtime` -> `packages/agent-runtime` so
// `bun build` can resolve this import. Module is purely node:fs +
// node:path + plain constants, so nothing else from agent-runtime gets
// pulled into the Electron main bundle.
import { walkFilesTree } from '@shogo/agent-runtime/src/fs-tree-walker'

/**
 * Resolve a user-supplied workspace root to its canonical absolute form,
 * but ONLY if it lives directly under `getWorkspacesDir()`. Returns null
 * for anything else (external folder-bound projects, traversal attempts,
 * paths outside the workspaces dir entirely).
 *
 * Resolves symlinks at the workspaces-root level via `realpathSync` so a
 * user with a symlinked data dir doesn't get falsely rejected, while still
 * pinning the validation to the canonical path.
 */
function resolveManagedWorkspaceRoot(rawRoot: string): string | null {
  if (!rawRoot || typeof rawRoot !== 'string') return null
  const workspacesDir = realpathOrSelf(getWorkspacesDir())
  let resolved: string
  try {
    resolved = realpathOrSelf(path.resolve(rawRoot))
  } catch {
    return null
  }
  if (!resolved.startsWith(workspacesDir + path.sep)) return null
  // Reject the workspaces root itself + any path more than one level deep
  // (only `<workspacesDir>/<projectId>` is a valid workspace root).
  const rel = resolved.slice(workspacesDir.length + 1)
  if (rel.length === 0) return null
  if (rel.includes(path.sep)) return null
  if (!fs.existsSync(resolved)) return null
  return resolved
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Resolve a `relPath` against a validated `root`, ensuring the result
 * stays inside `root`. Returns null on traversal attempts.
 */
function resolveSubPath(root: string, relPath: string): string | null {
  if (!relPath) return root
  const resolved = path.resolve(root, relPath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

export interface ResolveWorkspaceResult {
  ok: boolean
  root?: string
  /** Reason the call returned `ok: false`. */
  reason?: 'not-managed' | 'not-found' | 'invalid-input'
}

export interface ListTreeResult {
  ok: boolean
  tree?: ReturnType<typeof walkFilesTree>
  error?: string
}

export interface ReadFileResult {
  ok: boolean
  content?: string
  /** UTF-8 byte length of the file (post-read). */
  size?: number
  /** mtime in milliseconds since epoch. */
  mtime?: number
  error?: string
}

/** Maximum size of a file `fs:readFile` will return. Anything bigger falls
 *  back to the HTTP path (which streams). 10 MB matches the agent-runtime's
 *  `BUNDLE_MAX_FILE_SIZE` and is far larger than any source file Monaco
 *  would happily host. */
const MAX_READ_BYTES = 10 * 1024 * 1024

/**
 * Register the renderer-facing IPC handlers. Idempotent — safe to call
 * more than once (each `handle()` would throw on a re-register, so we
 * `removeHandler` first).
 */
export function registerFsIpcHandlers(): void {
  for (const ch of ['fs:resolveWorkspace', 'fs:listTree', 'fs:readFile']) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle(
    'fs:resolveWorkspace',
    (_event, projectId: string): ResolveWorkspaceResult => {
      if (!projectId || typeof projectId !== 'string') {
        return { ok: false, reason: 'invalid-input' }
      }
      // A projectId is a UUID-ish opaque string the API server uses as a
      // workspaces/<id> directory name. Reject anything that could
      // escape the workspaces dir (`..`, separators, absolute paths).
      if (projectId.includes('/') || projectId.includes('\\') || projectId.includes('..')) {
        return { ok: false, reason: 'invalid-input' }
      }
      const candidate = path.join(getWorkspacesDir(), projectId)
      const root = resolveManagedWorkspaceRoot(candidate)
      if (!root) return { ok: false, reason: 'not-managed' }
      if (!fs.existsSync(root)) return { ok: false, reason: 'not-found' }
      return { ok: true, root }
    },
  )

  ipcMain.handle(
    'fs:listTree',
    (_event, root: string, subPath?: string): ListTreeResult => {
      const resolvedRoot = resolveManagedWorkspaceRoot(root)
      if (!resolvedRoot) {
        return { ok: false, error: 'Workspace root is not under the managed workspaces directory' }
      }
      const startDir = subPath ? resolveSubPath(resolvedRoot, subPath) : resolvedRoot
      if (!startDir) return { ok: false, error: 'Path outside workspace' }
      if (!fs.existsSync(startDir)) return { ok: false, error: 'Path not found' }
      let stat
      try {
        stat = fs.statSync(startDir)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory' }
      try {
        const tree = walkFilesTree(startDir, resolvedRoot)
        return { ok: true, tree }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'fs:readFile',
    (_event, root: string, relPath: string): ReadFileResult => {
      const resolvedRoot = resolveManagedWorkspaceRoot(root)
      if (!resolvedRoot) {
        return { ok: false, error: 'Workspace root is not under the managed workspaces directory' }
      }
      const abs = resolveSubPath(resolvedRoot, relPath)
      if (!abs || abs === resolvedRoot) return { ok: false, error: 'Path outside workspace' }
      let stat
      try {
        stat = fs.statSync(abs)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      if (!stat.isFile()) return { ok: false, error: 'Path is not a file' }
      // Refuse oversized files — the renderer's Monaco editor isn't a viable
      // viewer for them anyway, and reading 100 MB into a single string
      // blocks Electron main longer than is polite. The renderer's SdkFs
      // fallback streams + chunked-base64-encodes for binary previews.
      if (stat.size > MAX_READ_BYTES) {
        return {
          ok: false,
          error: `File too large for IPC fast-path (${stat.size} bytes > ${MAX_READ_BYTES}); use the HTTP path`,
        }
      }
      try {
        const content = fs.readFileSync(abs, 'utf-8')
        return { ok: true, content, size: stat.size, mtime: stat.mtimeMs }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )
}
