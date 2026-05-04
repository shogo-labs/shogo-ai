// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

export interface TerminalCompletionRequest {
  cwd?: string
  pathPrefix?: string
  onlyDirectories?: boolean
}

export interface TerminalCompletionEntry {
  name: string
  type: 'file' | 'directory'
}

export interface TerminalCompletionResponse {
  ok: true
  base: string
  entries: TerminalCompletionEntry[]
}

const MAX_COMPLETION_ENTRIES = 100

export function completeTerminalPath(
  workspaceDir: string,
  request: TerminalCompletionRequest,
): TerminalCompletionResponse {
  const root = resolve(workspaceDir)
  const cwd = pickWorkspaceCwd(request.cwd, root)
  const prefix = typeof request.pathPrefix === 'string' ? request.pathPrefix : ''
  const expanded = expandWorkspaceHome(prefix, root)
  const emptyPrefix = expanded === ''
  const target = emptyPrefix ? cwd : isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const wantsDirectoryContents = emptyPrefix || /[/\\]$/.test(expanded)
  const base = wantsDirectoryContents ? target : dirname(target)
  const leaf = wantsDirectoryContents ? '' : basename(target)

  if (!isInsideWorkspace(base, root) || !isRealPathInsideWorkspace(base, root)) {
    return { ok: true, base: root, entries: [] }
  }

  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return { ok: true, base, entries: [] }
  }

  const includeDotEntries = leaf.startsWith('.')
  const onlyDirectories = request.onlyDirectories !== false
  const out: TerminalCompletionEntry[] = []

  for (const entry of entries) {
    if (!includeDotEntries && entry.name.startsWith('.')) continue
    if (!entry.name.startsWith(leaf)) continue

    const abs = join(base, entry.name)
    const type = classifyEntry(abs, entry)
    if (!type) continue
    if (onlyDirectories && type !== 'directory') continue
    if (!isRealPathInsideWorkspace(abs, root)) continue

    out.push({ name: entry.name, type })
  }

  out.sort(compareEntries)
  return { ok: true, base, entries: out.slice(0, MAX_COMPLETION_ENTRIES) }
}

function pickWorkspaceCwd(candidate: string | undefined, root: string): string {
  if (!candidate || typeof candidate !== 'string') return root
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  if (!existsSync(abs) || !isInsideWorkspace(abs, root) || !isRealPathInsideWorkspace(abs, root)) {
    return root
  }
  try {
    return statSync(abs).isDirectory() ? abs : root
  } catch {
    return root
  }
}

function expandWorkspaceHome(prefix: string, root: string): string {
  if (prefix === '~') return root
  if (prefix.startsWith('~/') || prefix.startsWith('~\\')) {
    return join(root, prefix.slice(2))
  }
  return prefix
}

function classifyEntry(
  abs: string,
  entry: { isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean },
): 'file' | 'directory' | null {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return null

  try {
    const stat = statSync(abs)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
  } catch {
    return null
  }
  return null
}

function isInsideWorkspace(candidate: string, root: string): boolean {
  const rel = relative(root, resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isRealPathInsideWorkspace(candidate: string, root: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    return isInsideWorkspace(realCandidate, realRoot)
  } catch {
    return false
  }
}

function compareEntries(a: TerminalCompletionEntry, b: TerminalCompletionEntry): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}
