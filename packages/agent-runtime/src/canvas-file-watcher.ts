// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasFileWatcher — Detects canvas file changes and broadcasts SSE events.
 *
 * Registered as a post-hook on write_file/edit_file/delete_file when
 * canvasMode === 'code'. Maps workspace files to canvas surfaces:
 *   - canvas/*.{tsx,ts,jsx,js} → surface code (surfaceId = filename without ext)
 *   - canvas/*.data.json       → surface data (surfaceId = filename without .data.json)
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { basename, join } from 'path'

const CODE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const

function getCodeSurfaceId(fileName: string): string | null {
  for (const ext of CODE_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return basename(fileName, ext)
    }
  }
  return null
}

function isCodeFile(fileName: string): boolean {
  return CODE_EXTENSIONS.some(ext => fileName.endsWith(ext))
}

export interface CanvasEvent {
  type: 'init' | 'renderCode' | 'dataUpdate' | 'removeSurface'
  surfaceId?: string
  title?: string
  code?: string
  data?: Record<string, unknown>
  surfaces?: Array<{ surfaceId: string; title: string; code: string; data: Record<string, unknown> }>
}

export class CanvasFileWatcher {
  private static instance: CanvasFileWatcher | null = null

  /** Returns a process-wide singleton for the given workspace. */
  static getInstance(workspaceDir: string): CanvasFileWatcher {
    if (!CanvasFileWatcher.instance) {
      CanvasFileWatcher.instance = new CanvasFileWatcher(workspaceDir)
    }
    return CanvasFileWatcher.instance
  }

  private subscribers = new Set<(event: CanvasEvent) => void>()
  private workspaceDir: string
  private surfaceCode = new Map<string, string>()
  private surfaceData = new Map<string, Record<string, unknown>>()
  private surfaceTitles = new Map<string, string>()

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir
    this.loadExisting()
  }

  private loadExisting() {
    const canvasDir = join(this.workspaceDir, 'canvas')
    if (!existsSync(canvasDir)) return

    const files = readdirSync(canvasDir)
    for (const file of files) {
      const fullPath = join(canvasDir, file)
      const surfaceId = getCodeSurfaceId(file)
      if (surfaceId && !file.includes('/')) {
        try {
          const code = readFileSync(fullPath, 'utf-8')
          this.surfaceCode.set(surfaceId, code)
          this.surfaceTitles.set(surfaceId, this.titleFromId(surfaceId))
        } catch {}
      } else if (file.endsWith('.data.json')) {
        const dataId = basename(file, '.data.json')
        try {
          const data = JSON.parse(readFileSync(fullPath, 'utf-8'))
          this.surfaceData.set(dataId, data)
        } catch {}
      }
    }
  }

  private titleFromId(surfaceId: string): string {
    return surfaceId
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  }

  /**
   * Called by write_file/edit_file post-hook after a file is written.
   */
  onFileChanged(relativePath: string, absolutePath: string): void {
    if (!relativePath.startsWith('canvas/')) return

    const fileName = relativePath.slice('canvas/'.length)

    if (isCodeFile(fileName) && !fileName.includes('/')) {
      const surfaceId = getCodeSurfaceId(fileName)
      if (!surfaceId) return
      try {
        const code = readFileSync(absolutePath, 'utf-8')
        this.surfaceCode.set(surfaceId, code)
        const title = this.titleFromId(surfaceId)
        this.surfaceTitles.set(surfaceId, title)
        this.broadcast({ type: 'renderCode', surfaceId, title, code })
      } catch {}
    }

    if (fileName.endsWith('.data.json') && !fileName.includes('/')) {
      const surfaceId = basename(fileName, '.data.json')
      try {
        const data = JSON.parse(readFileSync(absolutePath, 'utf-8'))
        this.surfaceData.set(surfaceId, data)
        this.broadcast({ type: 'dataUpdate', surfaceId, data })
      } catch {}
    }
  }

  /**
   * Called by delete_file post-hook.
   */
  onFileDeleted(relativePath: string): void {
    if (!relativePath.startsWith('canvas/')) return

    const fileName = relativePath.slice('canvas/'.length)

    if (isCodeFile(fileName) && !fileName.includes('/')) {
      const surfaceId = getCodeSurfaceId(fileName)
      if (!surfaceId) return
      this.surfaceCode.delete(surfaceId)
      this.surfaceTitles.delete(surfaceId)
      this.broadcast({ type: 'removeSurface', surfaceId })
    }

    if (fileName.endsWith('.data.json') && !fileName.includes('/')) {
      const surfaceId = basename(fileName, '.data.json')
      this.surfaceData.delete(surfaceId)
    }
  }

  /**
   * Build the init payload for a new SSE subscriber.
   */
  getInitEvent(): CanvasEvent {
    const surfaces: CanvasEvent['surfaces'] = []
    for (const [surfaceId, code] of this.surfaceCode) {
      surfaces.push({
        surfaceId,
        title: this.surfaceTitles.get(surfaceId) || surfaceId,
        code,
        data: this.surfaceData.get(surfaceId) || {},
      })
    }
    return { type: 'init', surfaces }
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
