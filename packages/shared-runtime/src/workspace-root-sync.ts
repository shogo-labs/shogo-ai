// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps one workspace **root** — `AGENTS.md`, `MEMORY.md`, `memory/`, skills —
 * identical on every machine that opens it (SHO-285 Update 2, section F).
 *
 * The cloud is canonical and holds every file as an object; this module is the
 * client half that a runtime (the cloud workspace pod, or the desktop's local
 * runtime) runs against it. Both sides run this same code, which is the point:
 * one sync, not a pod sync plus a desktop sync that disagree.
 *
 * The transport is injected because the two callers reach the store
 * differently — the pod calls the API as itself, the desktop goes through the
 * local API's relay — but neither needs object-store credentials.
 *
 * Three rules, each of which exists because the alternative loses a file:
 *
 *   • **Nothing is deleted by a sync.** A file missing from the cloud copy is
 *     uploaded, never removed locally; a file missing locally is downloaded,
 *     never removed from the cloud. Memory files are the one thing a user
 *     cannot regenerate.
 *   • **A conflict never overwrites.** If a file changed here *and* in the
 *     cloud since this machine last pulled, the cloud's bytes win and ours are
 *     kept beside them as `<name>.conflict-<device>-<ts>.<ext>`.
 *   • **An unchanged file costs one listing.** Etags come from the manifest, so
 *     a poll with nothing to do transfers nothing.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Paths that are never part of a shared root: build output, caches, logs,
 * scratch space and local databases. One list, because the manifest, the
 * presign route and this push all have to agree — a path one side hides and
 * the other sends would be uploaded forever.
 */
const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.vite',
  '.turbo',
  'tmp',
])

const SKIP_PREFIXES = ['.shogo/logs/', '.shogo/tasks/', '.tmp/']

/** Filenames that are machine-local state, never shared. */
const SKIP_FILES = new Set([
  'dev.db',
  'dev.db-shm',
  'dev.db-wal',
  'shogo-local.db',
  '.memory-index.db',
  '.memory-index.db-shm',
  '.memory-index.db-wal',
  // This module's own bookkeeping.
  'workspace-root-state.json',
])

/** True when `filePath` (relative to the root) belongs in the shared root. */
export function isSharedRootPath(filePath: string): boolean {
  const clean = filePath.replace(/^\/+/, '').split(sep).join('/')
  if (!clean || clean.includes('\0')) return false
  const segments = clean.split('/')
  // A path is signed by the API and then joined onto a device's root, so it has
  // to stay inside that root. `..` (and a drive letter, on Windows) would escape
  // it: one device could presign `../../MEMORY.md` and every other device would
  // write outside its workspace on the next pull.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  if (/^[a-zA-Z]:/.test(clean) || clean.startsWith('~')) return false
  if (SKIP_PREFIXES.some((prefix) => clean.startsWith(prefix))) return false
  if (segments.some((segment) => SKIP_SEGMENTS.has(segment))) return false
  const name = segments[segments.length - 1]
  if (SKIP_FILES.has(name)) return false
  if (name.startsWith('.memory-index.db')) return false
  // A conflict copy is a real file the user may want to read on another device.
  return true
}

/**
 * Where the losing side of a conflict is kept. `MEMORY.md` edited on two
 * devices becomes `MEMORY.conflict-russells-macbook-20261104T023000.md` beside
 * the winner, so both lines survive and the loser is still a Markdown file.
 */
export function conflictPathFor(filePath: string, deviceName: string, at: Date = new Date()): string {
  const clean = filePath.replace(/^\/+/, '').split(sep).join('/')
  const slash = clean.lastIndexOf('/')
  const dir = slash === -1 ? '' : clean.slice(0, slash + 1)
  const name = slash === -1 ? clean : clean.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const device = deviceName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'device'
  return `${dir}${stem}.conflict-${device}-${stamp}${ext}`
}

export interface WorkspaceRootFile {
  path: string
  /** Identity of the stored bytes; a change here means the cloud copy moved. */
  etag: string | null
  size: number
  updatedAt: string | null
  /** sha256 the writer declared, when it declared one. */
  sha256: string | null
  updatedByInstanceId: string | null
}

export interface WorkspaceRootManifest {
  workspaceId: string
  files: WorkspaceRootFile[]
  empty: boolean
}

export interface WorkspaceRootPresignRequest {
  path: string
  action: 'read' | 'write'
  sha256?: string
  instanceId?: string
  contentType?: string
}

export interface WorkspaceRootPresignResult {
  urls: Array<{ path: string; action: 'read' | 'write'; url: string }>
  skipped: string[]
}

/** How the sync reaches the store. Both callers implement this over HTTP. */
export interface WorkspaceRootTransport {
  manifest(opts?: { since?: string | null }): Promise<WorkspaceRootManifest>
  presign(files: WorkspaceRootPresignRequest[]): Promise<WorkspaceRootPresignResult>
}

export interface WorkspaceRootSyncOptions {
  /** Absolute path of the workspace root on this machine. */
  dir: string
  /** Name shown in a conflict copy's filename (a device name, or `cloud`). */
  deviceName: string
  transport: WorkspaceRootTransport
  /** Instance id recorded with every upload, so the manifest can say who wrote what. */
  instanceId?: string | null
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** How often to pull the manifest, in ms. */
  intervalMs?: number
  /** How often to look for local edits, in ms. */
  scanMs?: number
}

export interface WorkspaceRootSyncStats {
  /** Files downloaded (or overwritten by the cloud's copy). */
  pulled: number
  /** Files uploaded. */
  pushed: number
  /** Conflict copies written beside a file the cloud also changed. */
  conflicts: string[]
  errors: string[]
}

interface FileState {
  etag: string | null
  sha256: string
  size: number
  mtimeMs: number
}

interface PersistedState {
  files: Record<string, FileState>
}

const EMPTY_STATS = (): WorkspaceRootSyncStats => ({ pulled: 0, pushed: 0, conflicts: [], errors: [] })

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json'
  if (filePath.endsWith('.txt') || filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

export function createWorkspaceRootSync(options: WorkspaceRootSyncOptions) {
  const {
    dir,
    deviceName,
    transport,
    instanceId = null,
    fetchImpl = globalThis.fetch,
    intervalMs = 60_000,
    scanMs = 2_000,
  } = options

  const stateFile = join(dir, '.shogo', 'workspace-root-state.json')
  const abs = (filePath: string) => join(dir, filePath)

  let timer: ReturnType<typeof setInterval> | null = null
  let scanTimer: ReturnType<typeof setInterval> | null = null
  let running = false
  let queued = false

  function loadState(): PersistedState {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return { files: parsed.files }
      }
    } catch {
      // No state yet (first run), or it was truncated by a crash — start clean.
    }
    return { files: {} }
  }

  function saveState(state: PersistedState): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(state, null, 2))
    } catch (err: any) {
      console.warn(`[workspace-root-sync] could not save state: ${err?.message ?? err}`)
    }
  }

  /** Every shared file in the root, with the bytes only read when asked. */
  function walk(): string[] {
    const out: string[] = []
    const visit = (current: string) => {
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(current, entry)
        let info
        try {
          info = statSync(full)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          visit(full)
          continue
        }
        if (!info.isFile()) continue
        const rel = relative(dir, full).split(sep).join('/')
        if (isSharedRootPath(rel)) out.push(rel)
      }
    }
    visit(dir)
    return out
  }

  function readLocal(filePath: string): Uint8Array | null {
    try {
      return readFileSync(abs(filePath))
    } catch {
      return null
    }
  }

  async function download(url: string): Promise<Uint8Array> {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`GET ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async function upload(filePath: string, bytes: Uint8Array, sha256: string): Promise<string | null> {
    const signed = await transport.presign([
      {
        path: filePath,
        action: 'write',
        sha256,
        ...(instanceId ? { instanceId } : {}),
        contentType: contentTypeFor(filePath),
      },
    ])
    const url = signed.urls.find((u) => u.action === 'write' && u.path === filePath)?.url
    if (!url) return null
    const res = await fetchImpl(url, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'content-type': contentTypeFor(filePath) },
    })
    if (!res.ok) throw new Error(`PUT ${res.status}`)
    // The store's own etag is not in the PUT reply; the next manifest carries
    // it. Recording the sha now means this write is not pushed twice.
    return null
  }

  /**
   * Bring the local root up to the cloud copy. Runs first in a sync, so a
   * subsequent push only ever sends files the cloud does not already have.
   */
  async function pull(): Promise<WorkspaceRootSyncStats> {
    const stats = EMPTY_STATS()
    const state = loadState()
    const manifest = await transport.manifest()

    for (const file of manifest.files) {
      if (!isSharedRootPath(file.path)) continue
      const known = state.files[file.path]
      const localBytes = readLocal(file.path)
      const localSha = localBytes ? sha256Of(localBytes) : null

      // The store still holds the bytes this machine last recorded. The etag may
      // be unknown because we are the one who wrote them (a PUT reply carries
      // no etag), in which case the writer's declared sha256 proves it.
      const cloudUnchanged =
        known !== undefined &&
        file.etag !== null &&
        (known.etag === file.etag || (!known.etag && !!file.sha256 && file.sha256 === known.sha256))

      if (cloudUnchanged) {
        known.etag = file.etag
        // Nothing to transfer, and a local file that moved on is a local edit
        // for the push that follows — not something to overwrite.
        if (localBytes) continue
        // ... unless it is gone, which no sync ever does: restore it.
      }

      const localChanged = !!(known && localSha && known.sha256 !== localSha)

      if (localChanged && localBytes) {
        // Both sides moved since this machine last pulled. The cloud is
        // canonical; ours survives as a conflict copy.
        const conflictPath = conflictPathFor(file.path, deviceName)
        const conflictSha = sha256Of(localBytes)
        writeFileSync(abs(conflictPath), localBytes)
        try {
          await upload(conflictPath, localBytes, conflictSha)
          stats.conflicts.push(conflictPath)
          stats.pushed++
          state.files[conflictPath] = {
            etag: null,
            sha256: conflictSha,
            size: localBytes.byteLength,
            mtimeMs: statSync(abs(conflictPath)).mtimeMs,
          }
        } catch (err: any) {
          stats.errors.push(`conflict ${conflictPath}: ${err?.message ?? err}`)
        }
      }

      if (!file.etag) continue
      try {
        const signed = await transport.presign([{ path: file.path, action: 'read' }])
        const url = signed.urls.find((u) => u.action === 'read' && u.path === file.path)?.url
        if (!url) continue
        const bytes = await download(url)
        const target = abs(file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
        stats.pulled++
        state.files[file.path] = {
          etag: file.etag,
          sha256: sha256Of(bytes),
          size: bytes.byteLength,
          // The file's own mtime, not `Date.now()`: `hasLocalEdits` compares
          // this against `statSync().mtimeMs`, which is fractional here, so a
          // rounded clock read would make every pulled file look edited and
          // re-sync the whole root every scan.
          mtimeMs: statSync(target).mtimeMs,
        }
      } catch (err: any) {
        stats.errors.push(`pull ${file.path}: ${err?.message ?? err}`)
      }
    }

    // A file the cloud has never held is not deleted here — it is uploaded by
    // the push that follows. Dropping the entry makes the push notice it.
    const remotePaths = new Set(manifest.files.map((f) => f.path))
    for (const path of Object.keys(state.files)) {
      if (!remotePaths.has(path)) delete state.files[path]
    }

    saveState(state)
    return stats
  }

  /** Send local files the cloud copy does not have, or has an older copy of. */
  async function push(): Promise<WorkspaceRootSyncStats> {
    const stats = EMPTY_STATS()
    const state = loadState()

    for (const filePath of walk()) {
      const bytes = readLocal(filePath)
      if (!bytes) continue
      const sha = sha256Of(bytes)
      const known = state.files[filePath]
      if (known && known.sha256 === sha) continue
      try {
        await upload(filePath, bytes, sha)
        stats.pushed++
        state.files[filePath] = {
          etag: known?.etag ?? null,
          sha256: sha,
          size: bytes.byteLength,
          mtimeMs: statSync(abs(filePath)).mtimeMs,
        }
      } catch (err: any) {
        stats.errors.push(`push ${filePath}: ${err?.message ?? err}`)
      }
    }

    saveState(state)
    return stats
  }

  function merge(into: WorkspaceRootSyncStats, from: WorkspaceRootSyncStats): WorkspaceRootSyncStats {
    into.pulled += from.pulled
    into.pushed += from.pushed
    into.conflicts.push(...from.conflicts)
    into.errors.push(...from.errors)
    return into
  }

  /**
   * One full round: pull the cloud's changes, then push ours. Serialised —
   * a second call while one is running is folded into a single follow-up,
   * never run concurrently over the same files.
   */
  async function sync(): Promise<WorkspaceRootSyncStats> {
    if (running) {
      queued = true
      return EMPTY_STATS()
    }
    running = true
    try {
      const stats = EMPTY_STATS()
      merge(stats, await pull())
      merge(stats, await push())
      return stats
    } finally {
      running = false
      if (queued) {
        queued = false
        setTimeout(() => void sync().catch(() => {}), 0)
      }
    }
  }

  /** Cheap stat-walk; hashes only what changed, so a quiet root costs nothing. */
  function hasLocalEdits(): boolean {
    const state = loadState()
    for (const filePath of walk()) {
      let info
      try {
        info = statSync(abs(filePath))
      } catch {
        continue
      }
      const known = state.files[filePath]
      if (!known) return true
      if (known.size !== info.size || known.mtimeMs !== info.mtimeMs) return true
    }
    return false
  }

  function start(): void {
    if (timer) return
    void sync().catch(() => {})
    timer = setInterval(() => void sync().catch(() => {}), intervalMs)
    timer.unref?.()
    scanTimer = setInterval(() => {
      try {
        if (hasLocalEdits()) void sync().catch(() => {})
      } catch {
        // A transient read error must not stop the loop.
      }
    }, scanMs)
    scanTimer.unref?.()
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    if (scanTimer) clearInterval(scanTimer)
    timer = null
    scanTimer = null
  }

  return { pull, push, sync, start, stop, hasLocalEdits, stateFile, dir }
}

export type WorkspaceRootSync = ReturnType<typeof createWorkspaceRootSync>
