// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Reference resolution for the /agent/chat endpoint.
 *
 * The web composer's "@" menu lets a user tag:
 *   - files: a path inside the current project's agent workspace, and
 *   - workspaces: an org/team workspace (carried as a client-built summary).
 *
 * These arrive on the chat body as `references` (see ChatInput's
 * `ChatReference`). `buildReferencedContext` turns them into a single text
 * block that gets appended to the user's message so the model sees the real
 * file contents / workspace metadata.
 *
 * File contents are read from disk here (the runtime owns the workspace), so
 * this works both behind the API proxy and in direct-to-runtime / desktop
 * mode. Workspace metadata is NOT looked up here (the runtime has no platform
 * DB) — we trust the summary the client computed from data it already loaded.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { resolve, sep } from 'path'
import { isBinaryFilePath } from '@shogo/shared-runtime'

/** Structured reference shape mirrored from the web composer. */
export type ChatReference =
  | { type: 'file'; path?: string; name?: string }
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
