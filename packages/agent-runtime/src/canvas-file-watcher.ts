// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasFileWatcher — Detects workspace file changes and broadcasts events.
 *
 * Two input paths feed the same event stream:
 *
 *   1. Explicit notifications from gateway-tools.ts when the chat agent's
 *      write_file / edit_file tools succeed. These are synchronous with the
 *      tool response and fire before the tool returns.
 *
 *   2. A chokidar watcher on the workspace root. This catches every write
 *      regardless of source — Shogo external agents, the host user editing
 *      files directly on disk, git pulls, etc. Without this, the IDE live-
 *      edit experience is only reliable when the project's own chat agent
 *      is driving, which is a confusing UX.
 *
 * Both paths funnel through broadcast(), and a short-term dedupe guard
 * prevents the same `file.changed` event from firing twice (once from each
 * source) within a small window.
 *
 * Subscribers get:
 *   { type: 'file.changed', path, mtime }
 *   { type: 'file.deleted', path }
 *   { type: 'reload' }  ← legacy, bundle-level signal (not per-file)
 *   { type: 'init' }    ← replayed on first subscribe
 */

import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { statSync } from 'node:fs'
import { relative, resolve as resolvePath } from 'node:path'

// Files whose changes should trigger a rebuild. Covers both Vite layouts
// (src/, vite.config.ts, postcss.config.js) and Metro/Expo layouts
// (app/ for expo-router routes, app.json for runtime config, babel.config.js,
// metro.config.js). Unknown extensions are ignored to keep noisy writes
// (.DS_Store, swp files, etc.) from triggering builds.
const BUILDABLE_PREFIXES = [
  // Vite + shared
  'src/',
  'index.html',
  'vite.config',
  'tsconfig',
  'postcss',
  // Expo / Metro
  'app/',
  'app.json',
  'babel.config',
  'metro.config',
  'expo-router',
] as const
const BUILDABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.json'] as const

function isBuildableFile(relativePath: string): boolean {
  if (BUILDABLE_PREFIXES.some(p => relativePath.startsWith(p))) {
    return BUILDABLE_EXTENSIONS.some(ext => relativePath.endsWith(ext))
  }
  return false
}

// Paths under these prefixes are ignored by the chokidar watcher. They're
// either agent-runtime internals, build artefacts, or user-invisible state
// that would flood the event stream.
const IGNORED_PATH_PREFIXES = [
  'node_modules',
  '.git',
  '.shogo/server', // legacy skill-server path — retained so any leftover
                   // pre-migration files don't trigger rebuilds. The
                   // migration deletes the directory but old snapshots
                   // (`.shogo/server.migrated-<ts>/`) are also under
                   // `.shogo/`, which we ignore wholesale next:
  '.shogo/cache',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'src/generated',
  'prisma/dev.db',
]

function shouldIgnore(relativePath: string): boolean {
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) return true
  for (const p of IGNORED_PATH_PREFIXES) {
    if (relativePath === p || relativePath.startsWith(p + '/')) return true
  }
  return false
}

export type CanvasEvent =
  | { type: 'init' }
  | { type: 'reload' }
  | { type: 'file.changed'; path: string; mtime: number }
  | { type: 'file.deleted'; path: string }

export class CanvasFileWatcher {
  private static instance: CanvasFileWatcher | null = null

  static getInstance(workspaceDir: string): CanvasFileWatcher {
    if (!CanvasFileWatcher.instance) {
      CanvasFileWatcher.instance = new CanvasFileWatcher(workspaceDir)
    }
    return CanvasFileWatcher.instance
  }

  private subscribers = new Set<(event: CanvasEvent) => void>()
  private workspaceDir: string
  private onRebuildCallback: (() => void) | null = null

  /** Dedupe guard: `${type}:${path}` -> timestamp (ms). */
  private recentEvents = new Map<string, number>()
  private readonly DEDUPE_WINDOW_MS = 120

  private chokidar: FSWatcher | null = null

  constructor(workspaceDir: string) {
    this.workspaceDir = resolvePath(workspaceDir)
    this.startChokidar()
  }

  /**
   * Start a chokidar watcher on the workspace root. Best-effort: if chokidar
   * fails to start (unusual, usually permission issues), we silently fall
   * back to the explicit gateway-tools path and log to stderr.
   */
  private startChokidar(): void {
    try {
      this.chokidar = chokidarWatch(this.workspaceDir, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        depth: 30,
        awaitWriteFinish: {
          stabilityThreshold: 60,
          pollInterval: 20,
        },
        ignored: (absPath: string) => {
          const rel = relative(this.workspaceDir, absPath)
          return shouldIgnore(rel)
        },
      })

      this.chokidar.on('add', (absPath) => this.handleChokidarFileEvent('add', absPath))
      this.chokidar.on('change', (absPath) => this.handleChokidarFileEvent('change', absPath))
      this.chokidar.on('unlink', (absPath) => this.handleChokidarFileEvent('unlink', absPath))
      this.chokidar.on('error', (err) => {
        console.warn('[CanvasFileWatcher] chokidar error:', (err as Error).message)
      })
    } catch (err) {
      console.warn('[CanvasFileWatcher] chokidar init failed — live edits limited to gateway-tools path:', (err as Error).message)
      this.chokidar = null
    }
  }

  private handleChokidarFileEvent(op: 'add' | 'change' | 'unlink', absPath: string): void {
    const rel = relative(this.workspaceDir, absPath)
    if (shouldIgnore(rel)) return
    const path = rel.split('\\').join('/')

    if (op === 'unlink') {
      if (this.shouldDedupe('file.deleted', path)) return
      this.broadcast({ type: 'file.deleted', path })
      if (isBuildableFile(path)) this.onRebuildCallback?.()
      return
    }

    let mtime = Date.now()
    try {
      const s = statSync(absPath)
      mtime = Math.floor(s.mtimeMs)
    } catch {
      /* deleted mid-race, fall back to Date.now() */
    }
    if (this.shouldDedupe('file.changed', path)) return
    this.broadcast({ type: 'file.changed', path, mtime })
    if (isBuildableFile(path)) this.onRebuildCallback?.()
  }

  private shouldDedupe(type: string, path: string): boolean {
    const key = `${type}:${path}`
    const now = Date.now()
    const last = this.recentEvents.get(key) ?? 0
    if (now - last < this.DEDUPE_WINDOW_MS) return true
    this.recentEvents.set(key, now)
    // Garbage-collect stale entries opportunistically so the map doesn't
    // grow unbounded under heavy traffic.
    if (this.recentEvents.size > 2048) {
      const cutoff = now - this.DEDUPE_WINDOW_MS * 10
      for (const [k, t] of this.recentEvents) {
        if (t < cutoff) this.recentEvents.delete(k)
      }
    }
    return false
  }

  setOnRebuild(callback: () => void): void {
    this.onRebuildCallback = callback
  }

  /**
   * Explicit notifier used by gateway-tools.ts. Runs synchronously before
   * the tool call returns — redundant with chokidar but faster (no debounce
   * or filesystem stat) and survives watcher init failures.
   */
  onFileChanged(relativePath: string, _absolutePath: string): void {
    const path = relativePath.split('\\').join('/')
    if (this.shouldDedupe('file.changed', path)) return
    this.broadcast({ type: 'file.changed', path, mtime: Date.now() })
    if (isBuildableFile(path)) {
      this.onRebuildCallback?.()
    }
  }

  onFileDeleted(relativePath: string): void {
    const path = relativePath.split('\\').join('/')
    if (this.shouldDedupe('file.deleted', path)) return
    this.broadcast({ type: 'file.deleted', path })
    if (isBuildableFile(path)) {
      this.onRebuildCallback?.()
    }
  }

  broadcastReload(): void {
    this.broadcast({ type: 'reload' })
  }

  getInitEvent(): CanvasEvent {
    return { type: 'init' }
  }

  subscribe(fn: (event: CanvasEvent) => void): void {
    this.subscribers.add(fn)
  }

  unsubscribe(fn: (event: CanvasEvent) => void): void {
    this.subscribers.delete(fn)
  }

  broadcast(event: CanvasEvent): void {
    for (const fn of this.subscribers) {
      try { fn(event) } catch { /* subscriber crashed — isolate */ }
    }
  }

  /** Test-only: stop the chokidar watcher. */
  close(): void {
    this.chokidar?.close().catch(() => {})
    this.chokidar = null
  }
}
