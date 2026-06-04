// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Reference resolution for the /agent/chat endpoint.
 *
 * The web composer's "@" menu lets a user tag:
 *   - files: a path inside the current project's agent workspace,
 *   - projects: a sibling project in the same workspace. When this runtime is
 *     a merged-root workspace runtime the API mounts that project under
 *     `WORKSPACE_DIR/<projectId>/`, so we inject a bounded file tree and point
 *     the model at that path (it can then read the real files with its tools),
 *   - workspaces: an org/team workspace (carried as a client-built summary).
 *
 * These arrive on the chat body as `references` (see ChatInput's
 * `ChatReference`). `buildReferencedContext` turns them into a single text
 * block that gets appended to the user's message so the model sees the real
 * file contents / project structure / workspace metadata.
 *
 * File contents and project trees are read from disk here (the runtime owns
 * the workspace), so this works both behind the API proxy and in
 * direct-to-runtime / desktop mode. Workspace metadata is NOT looked up here
 * (the runtime has no platform DB) — we trust the summary the client computed
 * from data it already loaded.
 */

import { Dirent, existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import { isBinaryFilePath } from '@shogo/shared-runtime'

/** Structured reference shape mirrored from the web composer. */
export type ChatReference =
  | { type: 'file'; path?: string; name?: string }
  | { type: 'project'; id?: string; name?: string }
  | { type: 'workspace'; id?: string; name?: string; slug?: string; summary?: string }

/** Per-file inlined-content cap. Larger files are truncated. */
const MAX_FILE_BYTES = 64 * 1024
/** Aggregate cap across all referenced files in one message. */
const MAX_TOTAL_BYTES = 256 * 1024

/**
 * Resolve `subPath` strictly inside `rootDir`, rejecting path traversal.
 * Mirrors `resolveWorkspacePath` in server.ts but is self-contained so the
 * helper has no dependency on the server module.
 */
function resolveInsideRoot(rootDir: string, subPath: string): string | null {
  const root = resolve(rootDir)
  const resolved = resolve(rootDir, subPath)
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  return resolved
}

function workspaceLabel(ref: Extract<ChatReference, { type: 'workspace' }>): string {
  return ref.name || ref.slug || ref.id || 'workspace'
}

function projectLabel(ref: Extract<ChatReference, { type: 'project' }>): string {
  return ref.name || ref.id || 'project'
}

/** Caps for a referenced project's injected file tree (keep the prompt small). */
const MAX_PROJECT_TREE_ENTRIES = 200
const MAX_PROJECT_TREE_DEPTH = 4

/**
 * Directories not worth enumerating in a referenced-project tree. Dot-dirs are
 * skipped wholesale (tooling/caches); these are the common non-dot offenders.
 */
const PROJECT_TREE_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  'venv',
])

/**
 * Build a bounded, indented file tree for a referenced project's directory.
 * DFS with hard depth/entry caps so a large monorepo can't blow the prompt;
 * dot-dirs and well-known build/dep dirs are listed as skipped, not walked.
 */
function buildProjectTree(rootDir: string): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let count = 0
  let truncated = false

  const walk = (dir: string, depth: number, prefix: string): void => {
    if (truncated || depth > MAX_PROJECT_TREE_DEPTH) return
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Directories first, then files; each alphabetical — stable + readable.
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1
      const bd = b.isDirectory() ? 0 : 1
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (count >= MAX_PROJECT_TREE_ENTRIES) {
        truncated = true
        return
      }
      const isDir = entry.isDirectory()
      if (isDir && (entry.name.startsWith('.') || PROJECT_TREE_SKIP_DIRS.has(entry.name))) {
        lines.push(`${prefix}${entry.name}/ …(skipped)`)
        count++
        continue
      }
      if (isDir) {
        lines.push(`${prefix}${entry.name}/`)
        count++
        walk(resolve(dir, entry.name), depth + 1, `${prefix}  `)
        if (truncated) return
      } else if (entry.isFile()) {
        lines.push(`${prefix}${entry.name}`)
        count++
      }
    }
  }

  walk(rootDir, 0, '')
  return { lines, truncated }
}

/**
 * Build the "[Referenced context]" block for a message's `references`.
 * Returns an empty string when there's nothing to inject.
 */
export function buildReferencedContext(
  references: unknown,
  workspaceDir: string,
): string {
  if (!Array.isArray(references) || references.length === 0) return ''

  const sections: string[] = []
  let totalBytes = 0

  for (const raw of references) {
    if (!raw || typeof raw !== 'object') continue
    const ref = raw as ChatReference

    if (ref.type === 'file') {
      const relPath = typeof ref.path === 'string' ? ref.path : ''
      if (!relPath) continue

      const resolved = resolveInsideRoot(workspaceDir, relPath)
      if (!resolved) {
        sections.push(`[Referenced File: ${relPath}] (path outside workspace — skipped)`)
        continue
      }
      if (!existsSync(resolved)) {
        sections.push(`[Referenced File: ${relPath}] (not found in workspace)`)
        continue
      }
      try {
        const st = statSync(resolved)
        if (!st.isFile()) continue
        if (isBinaryFilePath(resolved)) {
          sections.push(
            `[Referenced File: ${relPath}] Binary file (not inlined). Use your file tools to read it if needed.`,
          )
          continue
        }
        if (totalBytes >= MAX_TOTAL_BYTES) {
          sections.push(
            `[Referenced File: ${relPath}] Skipped — reference context size limit reached. Read it with your file tools if needed.`,
          )
          continue
        }
        let content = readFileSync(resolved, 'utf-8')
        let truncated = false
        if (content.length > MAX_FILE_BYTES) {
          content = content.slice(0, MAX_FILE_BYTES)
          truncated = true
        }
        totalBytes += content.length
        sections.push(
          `[Referenced File: ${relPath}]\n${content}${truncated ? '\n…(truncated — read the full file with your file tools if needed)' : ''}\n[End of Referenced File]`,
        )
      } catch {
        sections.push(`[Referenced File: ${relPath}] (could not read)`)
      }
    } else if (ref.type === 'project') {
      const id = typeof ref.id === 'string' ? ref.id : ''
      const label = projectLabel(ref)
      if (!id) {
        sections.push(`[Referenced Project: ${label}]`)
        continue
      }
      // Sibling projects are mounted by the API under `WORKSPACE_DIR/<id>/`
      // (merged-root workspace runtime). If this runtime isn't merged (single
      // project) the dir won't exist — say so instead of failing silently.
      const resolved = resolveInsideRoot(workspaceDir, id)
      let isDir = false
      if (resolved && existsSync(resolved)) {
        try {
          isDir = statSync(resolved).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (!isDir) {
        sections.push(
          `[Referenced Project: ${label}] (not mounted in this runtime — its files aren't available here)`,
        )
        continue
      }
      const { lines, truncated } = buildProjectTree(resolved as string)
      const tree = lines.length > 0 ? lines.join('\n') : '(empty)'
      sections.push(
        `[Referenced Project: ${label}] mounted at ./${id}/ in your workspace. ` +
          `Use your file tools (read / list / search) on that path to inspect its code.\n` +
          `Structure (depth-limited${truncated ? ', truncated' : ''}):\n${tree}\n` +
          `[End of Referenced Project]`,
      )
    } else if (ref.type === 'workspace') {
      const label = workspaceLabel(ref)
      const summary = typeof ref.summary === 'string' ? ref.summary.trim() : ''
      sections.push(
        summary
          ? `[Referenced Workspace: ${label}]\n${summary}`
          : `[Referenced Workspace: ${label}]`,
      )
    }
  }

  if (sections.length === 0) return ''

  return (
    '[SYSTEM NOTE — the user attached the following references with their message ' +
    'via the "@" menu. Treat them as relevant context for this turn.]\n\n' +
    sections.join('\n\n')
  )
}
