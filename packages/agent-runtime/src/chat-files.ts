// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Downloaded chat files: `<workspaceDir>/chat-files/<conversation>/<name>`.
 *
 * Agents read and search chat files through the API; a file only lands on
 * disk when the agent asks for the raw bytes. Chat files never change once
 * shared, so a file already on disk is reused without asking the API again.
 * `chat-files/.index.json` maps file ids to their paths. The folder is a
 * cache: it's left out of the project backup and pruned when the agent loses
 * access to a conversation.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { downloadAgentChatFile, type AgentChannelIdentity } from './internal-api'

export const CHAT_FILES_DIR = 'chat-files'
const INDEX_FILE = '.index.json'

interface IndexEntry {
  path: string
  size: number
}

type ChatFileIndex = Record<string, IndexEntry>

export interface SavedChatFile {
  /** Relative to the workspace dir, e.g. `chat-files/sales/q3.pdf`. */
  path: string
  size: number
  reused: boolean
}

const inflight = new Map<string, Promise<SavedChatFile>>()

function rootOf(workspaceDir: string): string {
  return join(workspaceDir, CHAT_FILES_DIR)
}

function readIndex(root: string): ChatFileIndex {
  try {
    const parsed = JSON.parse(readFileSync(join(root, INDEX_FILE), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeIndex(root: string, index: ChatFileIndex): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, INDEX_FILE), JSON.stringify(index, null, 2))
}

/** One safe path segment: no separators, no dot-only names, no control characters. */
export function safeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[/\\?%*:|"<>\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(-120)
  return cleaned || fallback
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The path of a file already on disk, or null. */
export function downloadedPath(workspaceDir: string, fileId: string): string | null {
  const root = rootOf(workspaceDir)
  const entry = readIndex(root)[fileId]
  if (!entry) return null
  const abs = join(workspaceDir, entry.path)
  try {
    return statSync(abs).size === entry.size ? entry.path : null
  } catch {
    return null
  }
}

/**
 * Save a chat file into the agent's workspace, or return the copy already
 * there. Concurrent calls for the same file share one download.
 */
export function saveChatFile(
  workspaceDir: string,
  workspaceId: string,
  identity: AgentChannelIdentity,
  fileId: string,
): Promise<SavedChatFile> {
  const existing = downloadedPath(workspaceDir, fileId)
  if (existing) return Promise.resolve({ path: existing, size: statSync(join(workspaceDir, existing)).size, reused: true })
  const key = `${workspaceDir}\u0000${fileId}`
  const running = inflight.get(key)
  if (running) return running
  const job = (async (): Promise<SavedChatFile> => {
    const result = await downloadAgentChatFile(workspaceId, identity, fileId)
    if (!result.ok || !result.data) {
      throw Object.assign(new Error(result.error ?? 'Could not download the file'), { code: result.code, status: result.status })
    }
    const root = rootOf(workspaceDir)
    const index = readIndex(root)
    const folder = safeSegment(result.data.folder, 'files')
    const name = safeSegment(result.data.name, 'file')
    const taken = new Set(Object.entries(index).filter(([id]) => id !== fileId).map(([, e]) => e.path))
    let rel = join(CHAT_FILES_DIR, folder, name)
    if (taken.has(rel) || (existsSync(join(workspaceDir, rel)) && !index[fileId])) {
      const ext = extname(name)
      rel = join(CHAT_FILES_DIR, folder, `${name.slice(0, name.length - ext.length)}-${fileId.slice(0, 6)}${ext}`)
    }
    const abs = join(workspaceDir, rel)
    if (!insideRoot(root, abs)) throw new Error('Refusing to write outside chat-files/')
    mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(abs, result.data.bytes)
    index[fileId] = { path: rel, size: result.data.bytes.byteLength }
    writeIndex(root, index)
    return { path: rel, size: result.data.bytes.byteLength, reused: false }
  })()
  inflight.set(key, job)
  job.finally(() => inflight.delete(key)).catch(() => {})
  return job
}

/** Delete downloaded folders for conversations the agent can no longer read. Returns the removed folder names. */
export function pruneChatFiles(workspaceDir: string, keepFolders: Iterable<string>): string[] {
  const root = rootOf(workspaceDir)
  if (!existsSync(root)) return []
  const keep = new Set([...keepFolders].map((f) => safeSegment(f, 'files')))
  const removed: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue
    rmSync(join(root, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length) {
    const index = readIndex(root)
    for (const [id, e] of Object.entries(index)) {
      const folder = e.path.split(/[\\/]/)[1]
      if (removed.includes(folder)) delete index[id]
    }
    writeIndex(root, index)
  }
  return removed
}
