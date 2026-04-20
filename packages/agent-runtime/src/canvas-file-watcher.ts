// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasFileWatcher — Detects workspace file changes and triggers rebuilds.
 *
 * Watches for writes to src/ (and other buildable paths) in the workspace.
 * File changes trigger a Vite rebuild via the onRebuild callback. After the
 * build completes, a 'reload' event is broadcast so the iframe picks up the
 * new build.
 */

const BUILDABLE_PREFIXES = ['src/', 'index.html', 'vite.config', 'tsconfig', 'postcss'] as const
const BUILDABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.html', '.json'] as const

function isBuildableFile(relativePath: string): boolean {
  if (BUILDABLE_PREFIXES.some(p => relativePath.startsWith(p))) {
    return BUILDABLE_EXTENSIONS.some(ext => relativePath.endsWith(ext))
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

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
  }

  setOnRebuild(callback: () => void): void {
    this.onRebuildCallback = callback
  }

  onFileChanged(relativePath: string, _absolutePath: string): void {
    this.broadcast({ type: 'file.changed', path: relativePath, mtime: Date.now() })
    if (isBuildableFile(relativePath)) {
      this.onRebuildCallback?.()
    }
  }

  onFileDeleted(relativePath: string): void {
    this.broadcast({ type: 'file.deleted', path: relativePath })
    if (isBuildableFile(relativePath)) {
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
      try { fn(event) } catch {}
    }
  }
}
