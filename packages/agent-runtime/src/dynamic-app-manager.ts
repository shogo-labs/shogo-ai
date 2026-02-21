/**
 * Dynamic App State Manager
 *
 * In-memory state manager that tracks all active surfaces, their component
 * trees, and data models. Accepts protocol messages from MCP tools and
 * pushes them to connected SSE clients.
 *
 * Also manages a promise-based action queue so agents can await user
 * interactions via the canvas_action_wait tool.
 *
 * Canvas state is persisted to disk so it survives runtime restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type {
  DynamicAppMessage,
  SurfaceState,
  ComponentDefinition,
  ActionEvent,
} from './dynamic-app-types'

type SSEWriter = (message: DynamicAppMessage) => void

export class DynamicAppManager {
  private surfaces = new Map<string, SurfaceState>()
  private sseClients = new Set<SSEWriter>()
  private actionQueue: ActionEvent[] = []
  private actionWaiters: Array<{
    resolve: (event: ActionEvent) => void
    surfaceId?: string
    actionName?: string
    timeout: ReturnType<typeof setTimeout>
  }> = []
  private persistPath: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(persistPath?: string) {
    if (persistPath) {
      this.persistPath = persistPath
      this.loadFromDisk()
    }
  }

  // ---------------------------------------------------------------------------
  // SSE Client Management
  // ---------------------------------------------------------------------------

  addClient(writer: SSEWriter): () => void {
    this.sseClients.add(writer)
    return () => this.sseClients.delete(writer)
  }

  private broadcast(message: DynamicAppMessage): void {
    for (const writer of this.sseClients) {
      try {
        writer(message)
      } catch {
        this.sseClients.delete(writer)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Surface Operations
  // ---------------------------------------------------------------------------

  createSurface(surfaceId: string, title?: string, theme?: Record<string, string>): Record<string, unknown> {
    if (this.surfaces.has(surfaceId)) {
      return { ok: false, error: `Surface "${surfaceId}" already exists. Use canvas_update to modify it.` }
    }

    const now = new Date().toISOString()
    const surface: SurfaceState = {
      surfaceId,
      title,
      theme,
      components: new Map(),
      dataModel: {},
      createdAt: now,
      updatedAt: now,
    }
    this.surfaces.set(surfaceId, surface)

    this.broadcast({ type: 'createSurface', surfaceId, title, theme })
    this.scheduleSave()
    return {
      ok: true,
      surfaceId,
      status: 'visible',
      message: `Surface "${surfaceId}" created and visible to the user. Add components with canvas_update next.`,
    }
  }

  updateComponents(surfaceId: string, components: ComponentDefinition[]): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    for (const comp of components) {
      surface.components.set(comp.id, comp)
    }
    surface.updatedAt = new Date().toISOString()

    this.broadcast({ type: 'updateComponents', surfaceId, components })
    this.scheduleSave()

    return {
      ok: true,
      surfaceId,
      status: 'rendered',
      componentsUpdated: components.length,
      totalComponents: surface.components.size,
      hasRoot: surface.components.has('root'),
      componentTree: this.summarizeComponentTree(surface),
      message: `${components.length} component(s) rendered on "${surfaceId}". The user can see the UI now.`,
    }
  }

  updateData(surfaceId: string, path: string | undefined, value: unknown): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    if (!path || path === '/') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        surface.dataModel = value as Record<string, unknown>
      } else {
        return { ok: false, error: 'Root data model must be an object' }
      }
    } else {
      setByPointer(surface.dataModel, path, value)
    }

    surface.updatedAt = new Date().toISOString()
    this.broadcast({ type: 'updateData', surfaceId, path, value })
    this.scheduleSave()

    const dataKeys = Object.keys(surface.dataModel)
    return {
      ok: true,
      surfaceId,
      status: 'data_updated',
      path: path || '/',
      dataKeys,
      message: `Data updated on "${surfaceId}" at path "${path || '/'}". Bound components now reflect the new values. The user can see the updated data.`,
    }
  }

  deleteSurface(surfaceId: string): Record<string, unknown> {
    if (!this.surfaces.has(surfaceId)) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist` }
    }

    this.surfaces.delete(surfaceId)
    this.broadcast({ type: 'deleteSurface', surfaceId })
    this.scheduleSave()
    return {
      ok: true,
      surfaceId,
      status: 'deleted',
      remainingSurfaces: this.listSurfaces(),
      message: `Surface "${surfaceId}" removed from the canvas.`,
    }
  }

  /**
   * Produce a concise summary of a surface's component tree for agent feedback.
   */
  private summarizeComponentTree(surface: SurfaceState): string {
    const root = surface.components.get('root')
    if (!root) return '(no root component)'

    const lines: string[] = []
    const visit = (id: string, depth: number) => {
      const comp = surface.components.get(id)
      if (!comp) return
      const indent = '  '.repeat(depth)
      lines.push(`${indent}${comp.component}#${comp.id}`)
      const childIds: string[] = Array.isArray(comp.children)
        ? comp.children
        : comp.child ? [comp.child] : []
      for (const childId of childIds) {
        if (typeof childId === 'string') visit(childId, depth + 1)
      }
    }
    visit('root', 0)
    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Action Handling (user interaction -> agent)
  // ---------------------------------------------------------------------------

  deliverAction(event: ActionEvent): void {
    const idx = this.actionWaiters.findIndex((w) => {
      if (w.surfaceId && w.surfaceId !== event.surfaceId) return false
      if (w.actionName && w.actionName !== event.name) return false
      return true
    })

    if (idx >= 0) {
      const waiter = this.actionWaiters.splice(idx, 1)[0]
      clearTimeout(waiter.timeout)
      waiter.resolve(event)
    } else {
      this.actionQueue.push(event)
      if (this.actionQueue.length > 100) this.actionQueue.shift()
    }
  }

  waitForAction(surfaceId?: string, actionName?: string, timeoutMs = 120_000): Promise<ActionEvent | null> {
    const queued = this.actionQueue.findIndex((e) => {
      if (surfaceId && e.surfaceId !== surfaceId) return false
      if (actionName && e.name !== actionName) return false
      return true
    })

    if (queued >= 0) {
      return Promise.resolve(this.actionQueue.splice(queued, 1)[0])
    }

    return new Promise<ActionEvent | null>((resolve) => {
      const timeout = setTimeout(() => {
        const idx = this.actionWaiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) this.actionWaiters.splice(idx, 1)
        resolve(null)
      }, timeoutMs)

      this.actionWaiters.push({ resolve: resolve as (event: ActionEvent) => void, surfaceId, actionName, timeout })
    })
  }

  // ---------------------------------------------------------------------------
  // State Snapshot (for reconnection)
  // ---------------------------------------------------------------------------

  getState(): { surfaces: Record<string, unknown> } {
    const surfaces: Record<string, unknown> = {}
    for (const [id, surface] of this.surfaces) {
      surfaces[id] = {
        surfaceId: surface.surfaceId,
        title: surface.title,
        theme: surface.theme,
        components: Object.fromEntries(surface.components),
        dataModel: surface.dataModel,
        createdAt: surface.createdAt,
        updatedAt: surface.updatedAt,
      }
    }
    return { surfaces }
  }

  getSurface(surfaceId: string): SurfaceState | undefined {
    return this.surfaces.get(surfaceId)
  }

  listSurfaces(): string[] {
    return [...this.surfaces.keys()]
  }

  clear(): void {
    this.surfaces.clear()
    this.actionQueue.length = 0
    for (const w of this.actionWaiters) {
      clearTimeout(w.timeout)
      w.resolve(null as any)
    }
    this.actionWaiters.length = 0
    this.scheduleSave()
  }

  // ---------------------------------------------------------------------------
  // Disk Persistence
  // ---------------------------------------------------------------------------

  private scheduleSave(): void {
    if (!this.persistPath) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveToDisk(), 300)
  }

  private saveToDisk(): void {
    if (!this.persistPath) return
    try {
      const state = this.getState()
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.error('[DynamicAppManager] Failed to save canvas state:', err)
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf-8'))
      const surfacesObj = raw?.surfaces
      if (!surfacesObj || typeof surfacesObj !== 'object') return

      let restored = 0
      for (const [id, s] of Object.entries(surfacesObj) as [string, any][]) {
        const components = new Map<string, ComponentDefinition>()
        if (s.components && typeof s.components === 'object') {
          for (const [cid, cdef] of Object.entries(s.components)) {
            components.set(cid, cdef as ComponentDefinition)
          }
        }
        this.surfaces.set(id, {
          surfaceId: s.surfaceId || id,
          title: s.title,
          theme: s.theme,
          components,
          dataModel: s.dataModel || {},
          createdAt: s.createdAt || new Date().toISOString(),
          updatedAt: s.updatedAt || new Date().toISOString(),
        })
        restored++
      }

      if (restored > 0) {
        console.log(`[DynamicAppManager] Restored ${restored} surface(s) from disk`)
      }
    } catch (err) {
      console.error('[DynamicAppManager] Failed to load canvas state:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Pointer helpers (RFC 6901)
// ---------------------------------------------------------------------------

function parsePointer(pointer: string): string[] {
  if (!pointer || pointer === '/') return []
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${pointer}`)
  return pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function setByPointer(obj: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = parsePointer(pointer)
  if (parts.length === 0) return

  let current: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (current[key] === undefined || current[key] === null) {
      current[key] = isArrayIndex(parts[i + 1]) ? [] : {}
    }
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
}

export function getByPointer(obj: Record<string, unknown>, pointer: string): unknown {
  const parts = parsePointer(pointer)
  let current: unknown = obj
  for (const part of parts) {
    if (current === undefined || current === null) return undefined
    current = (current as any)[part]
  }
  return current
}

function isArrayIndex(key: string): boolean {
  return /^\d+$/.test(key)
}

// Singleton instance
let instance: DynamicAppManager | null = null

export function getDynamicAppManager(): DynamicAppManager {
  if (!instance) {
    instance = new DynamicAppManager()
  }
  return instance
}

export function initDynamicAppManager(persistPath: string): DynamicAppManager {
  if (instance) {
    instance.clear()
  }
  instance = new DynamicAppManager(persistPath)
  return instance
}

export function resetDynamicAppManager(): void {
  if (instance) {
    instance.clear()
  }
  instance = null
}
