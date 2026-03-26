// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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
import { dirname, join } from 'path'
import type {
  DynamicAppMessage,
  SurfaceState,
  ComponentDefinition,
  ActionEvent,
  HookDefinitions,
  HookAction,
  RecomputeAction,
  ValidateAction,
  CascadeDeleteAction,
  TransformAction,
  LogAction,
  DeleteComponentsMessage,
} from './dynamic-app-types'
import { ManagedApiRuntime, type ModelDefinition, type ManagedModelHooks, type ManagedHookResult, type ManagedHookContext } from './managed-api-runtime'
import { ToolBackedApiRuntime, type ToolBindingConfig } from './tool-backed-api-runtime'
import type { MCPClientManager } from './mcp-client'

type SSEWriter = (message: DynamicAppMessage) => void

function generateHookId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 25; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

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
  private runtimes = new Map<string, ManagedApiRuntime>()
  private toolRuntimes = new Map<string, ToolBackedApiRuntime>()
  /** Tracks model → dataPath bindings per surface so mutations can auto-refresh filtered views */
  private queryBindings = new Map<string, Map<string, Array<{ dataPath: string; params?: { where?: Record<string, unknown>; orderBy?: string; limit?: number } }>>>()
  /** Stored MCPClientManager reference for deferred bindings and reactive invalidation */
  private mcpClientRef: MCPClientManager | null = null
  /** Deferred tool bindings queued before the target surface exists */
  private deferredToolBindings = new Map<string, Array<{
    config: Omit<ToolBindingConfig, 'cache'> & { cache?: { enabled: boolean; ttlSeconds?: number }; dataPath?: string }
  }>>()

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

    const deferred = this.deferredToolBindings.get(surfaceId)
    if (deferred && deferred.length > 0 && this.mcpClientRef) {
      this.deferredToolBindings.delete(surfaceId)
      for (const { config } of deferred) {
        this.bindToolApi(surfaceId, config, this.mcpClientRef)
      }
    }

    // Apply wildcard deferred bindings (auto-bind from Composio installs)
    const wildcardDeferred = this.deferredToolBindings.get('*')
    if (wildcardDeferred && wildcardDeferred.length > 0 && this.mcpClientRef) {
      this.deferredToolBindings.delete('*')
      for (const { config } of wildcardDeferred) {
        this.bindToolApi(surfaceId, config, this.mcpClientRef)
      }
    }

    return {
      ok: true,
      surfaceId,
      status: 'visible',
      message: `Surface "${surfaceId}" created and visible to the user. Add components with canvas_update next.`,
    }
  }

  updateComponents(surfaceId: string, components: ComponentDefinition[], merge?: boolean): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    if (!merge) {
      surface.components.clear()
    }
    for (const comp of components) {
      surface.components.set(comp.id, comp)
    }
    surface.updatedAt = new Date().toISOString()

    this.broadcast({ type: 'updateComponents', surfaceId, components, merge: !!merge })
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

  /**
   * Stream preview components during tool-call generation.
   * Lazily creates the surface if it doesn't exist yet (handles parallel
   * canvas_create + canvas_update). Skips validation and disk persistence —
   * the final tool execution reconciles the full state.
   */
  streamPreviewComponents(surfaceId: string, components: ComponentDefinition[]): void {
    let surface = this.surfaces.get(surfaceId)
    if (!surface) {
      const now = new Date().toISOString()
      surface = {
        surfaceId,
        components: new Map(),
        dataModel: {},
        createdAt: now,
        updatedAt: now,
      }
      this.surfaces.set(surfaceId, surface)
      this.broadcast({ type: 'createSurface', surfaceId })
    }

    for (const comp of components) {
      surface.components.set(comp.id, comp)
    }
    surface.updatedAt = new Date().toISOString()

    this.broadcast({ type: 'updateComponents', surfaceId, components, merge: true })
  }

  updateData(surfaceId: string, path: string | undefined, value: unknown): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    // Auto-parse JSON strings — LLMs frequently send stringified JSON instead of native objects/arrays
    const resolved = autoParseJsonString(value)

    if (!path || path === '/') {
      if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
        surface.dataModel = resolved as Record<string, unknown>
      } else {
        return { ok: false, error: 'Root data model must be an object' }
      }
    } else {
      setByPointer(surface.dataModel, path, resolved)
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

  patchData(surfaceId: string, operations: Array<{ op: string; path: string; value?: unknown }>): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    const results: string[] = []
    for (const op of operations) {
      const { path } = op
      if (!path || !path.startsWith('/')) {
        results.push(`Skipped invalid path "${path}" — must start with /`)
        continue
      }
      const current = getByPointer(surface.dataModel, path)
      switch (op.op) {
        case 'increment': {
          const amount = typeof op.value === 'number' ? op.value : 1
          const newVal = (typeof current === 'number' ? current : 0) + amount
          setByPointer(surface.dataModel, path, newVal)
          results.push(`${path}: ${current} → ${newVal}`)
          break
        }
        case 'decrement': {
          const amount = typeof op.value === 'number' ? op.value : 1
          const newVal = (typeof current === 'number' ? current : 0) - amount
          setByPointer(surface.dataModel, path, newVal)
          results.push(`${path}: ${current} → ${newVal}`)
          break
        }
        case 'toggle': {
          const newVal = !current
          setByPointer(surface.dataModel, path, newVal)
          results.push(`${path}: ${current} → ${newVal}`)
          break
        }
        case 'append': {
          const arr = Array.isArray(current) ? current : []
          arr.push(op.value)
          setByPointer(surface.dataModel, path, arr)
          results.push(`${path}: appended item (now ${arr.length} items)`)
          break
        }
        case 'set': {
          setByPointer(surface.dataModel, path, op.value)
          results.push(`${path}: set to ${JSON.stringify(op.value)}`)
          break
        }
        default:
          results.push(`Unknown operation "${op.op}" — use increment, decrement, toggle, append, or set`)
      }
    }

    surface.updatedAt = new Date().toISOString()
    this.broadcast({ type: 'updateData', surfaceId, path: '/', value: surface.dataModel })
    this.scheduleSave()

    return {
      ok: true,
      surfaceId,
      status: 'data_patched',
      operations: results,
      message: `Applied ${operations.length} operation(s) on "${surfaceId}". Bound components now reflect the changes.`,
    }
  }

  deleteSurface(surfaceId: string): Record<string, unknown> {
    if (!this.surfaces.has(surfaceId)) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist` }
    }

    this.surfaces.delete(surfaceId)
    this.queryBindings.delete(surfaceId)
    const runtime = this.runtimes.get(surfaceId)
    if (runtime) {
      runtime.destroy()
      this.runtimes.delete(surfaceId)
    }
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

  deleteComponents(surfaceId: string, componentIds: string[]): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist` }
    }

    const deleted: string[] = []
    for (const id of componentIds) {
      if (surface.components.has(id)) {
        surface.components.delete(id)
        deleted.push(id)
      }
    }

    if (deleted.length === 0) {
      return { ok: false, error: 'None of the specified component IDs were found' }
    }

    const deletedSet = new Set(deleted)
    const updatedParents: ComponentDefinition[] = []
    for (const [, comp] of surface.components) {
      if (Array.isArray(comp.children)) {
        const filtered = (comp.children as string[]).filter((id) => !deletedSet.has(id))
        if (filtered.length !== (comp.children as string[]).length) {
          comp.children = filtered
          updatedParents.push(comp)
        }
      }
      if (comp.child && deletedSet.has(comp.child)) {
        delete comp.child
        updatedParents.push(comp)
      }
    }

    surface.updatedAt = new Date().toISOString()

    if (updatedParents.length > 0) {
      this.broadcast({ type: 'updateComponents', surfaceId, components: updatedParents })
    }
    this.broadcast({ type: 'deleteComponents', surfaceId, componentIds: deleted } as DeleteComponentsMessage)
    this.scheduleSave()

    return {
      ok: true,
      surfaceId,
      deleted,
      updatedParents: updatedParents.map((p) => p.id),
      totalComponents: surface.components.size,
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
    this.deliverActionAsync(event).catch((err) => {
      console.error('[DynamicAppManager] Action delivery failed:', err)
    })
  }

  /**
   * Async version of deliverAction that returns the mutation result.
   * Used by canvas_trigger_action to actually verify mutations succeeded.
   */
  async deliverActionAsync(event: ActionEvent): Promise<{
    handled: boolean
    mutation?: boolean
    result?: { ok: boolean; status?: number; error?: string; dataPath?: string; itemCount?: number }
  }> {
    // sendToAgent actions skip mutation/inference — fall through to actionQueue/waiters
    if (event.context?._sendToAgent) {
      const idx = this.actionWaiters.findIndex((w) => {
        if (w.surfaceId && w.surfaceId !== event.surfaceId) return false
        if (w.actionName && w.actionName !== event.name) return false
        return true
      })
      if (idx >= 0) {
        const waiter = this.actionWaiters.splice(idx, 1)[0]
        clearTimeout(waiter.timeout)
        waiter.resolve(event)
        return { handled: true, mutation: false }
      }
      this.actionQueue.push(event)
      if (this.actionQueue.length > 100) this.actionQueue.shift()
      return { handled: true, mutation: false }
    }

    // Handle auto-derived delete from Checkbox/Select/Delete button system
    if (event.name === '__delete_item__') {
      const ctx = event.context as { collectionPath?: string; itemId?: string } | undefined
      if (ctx?.collectionPath && ctx?.itemId) {
        const result = await this.handleDeleteItem(event.surfaceId, ctx.collectionPath, ctx.itemId)
        return { handled: true, mutation: true, result }
      }
      return { handled: false, mutation: false, result: { ok: false, error: 'Missing collectionPath or itemId in __delete_item__ context' } }
    }

    const mutation = event.context?._mutation as
      | { endpoint: string; method: string; body?: unknown }
      | undefined
    if (mutation) {
      if (mutation.method?.toUpperCase() === 'OPEN') return { handled: true, mutation: true }
      const runtime = this.runtimes.get(event.surfaceId)
      if (runtime && runtime.isReady()) {
        const result = await this.executeMutation(event.surfaceId, runtime, mutation)
        return { handled: true, mutation: true, result }
      }
      return { handled: false, mutation: true, result: { ok: false, error: 'No API runtime available for this surface' } }
    }

    if (!mutation) {
      const runtime = this.runtimes.get(event.surfaceId)
      if (runtime && runtime.isReady()) {
        const inferred = this.inferMutation(runtime, event)
        if (inferred) {
          const result = await this.executeMutation(event.surfaceId, runtime, inferred)
          return { handled: true, mutation: true, result }
        }
      }
    }

    const idx = this.actionWaiters.findIndex((w) => {
      if (w.surfaceId && w.surfaceId !== event.surfaceId) return false
      if (w.actionName && w.actionName !== event.name) return false
      return true
    })

    if (idx >= 0) {
      const waiter = this.actionWaiters.splice(idx, 1)[0]
      clearTimeout(waiter.timeout)
      waiter.resolve(event)
      return { handled: true, mutation: false }
    } else {
      this.actionQueue.push(event)
      if (this.actionQueue.length > 100) this.actionQueue.shift()
      return { handled: true, mutation: false }
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-Derived Mutations (Checkbox / Select / Delete button)
  // ---------------------------------------------------------------------------

  /**
   * Reverse-lookup queryBindings to find the model name and runtime for a given
   * collection data path (e.g., "/tasks" → model "Task", endpoint "/api/tasks").
   */
  private findModelForDataPath(surfaceId: string, collectionPath: string): {
    modelName: string
    endpoint: string
    runtime: ManagedApiRuntime
  } | null {
    const surfaceBindings = this.queryBindings.get(surfaceId)
    if (!surfaceBindings) return null

    const runtime = this.runtimes.get(surfaceId)
    if (!runtime || !runtime.isReady()) return null

    for (const [modelName, bindings] of surfaceBindings) {
      for (const binding of bindings) {
        if (binding.dataPath === collectionPath) {
          const endpointInfo = runtime.getModelEndpointInfo()
          const matched = endpointInfo.find(e => e.name === modelName)
          if (matched) {
            return { modelName, endpoint: matched.endpoint, runtime }
          }
        }
      }
    }
    return null
  }

  /**
   * Auto-derive and execute a PATCH mutation from a data model path change.
   * Called when an interactive component (Checkbox, Select) with dataPath
   * reports a change with { persist: true }.
   *
   * Path format: /collectionPath/index/field (e.g., /tasks/2/completed)
   */
  async handleDataChange(
    surfaceId: string,
    path: string,
    value: unknown,
  ): Promise<{ ok: boolean; error?: string; dataPath?: string }> {
    const segments = path.replace(/^\//, '').split('/')
    if (segments.length < 3) {
      return { ok: false, error: `Path "${path}" too short — expected /collection/index/field` }
    }

    const collectionPath = `/${segments[0]}`
    const itemIndex = parseInt(segments[1], 10)
    const field = segments.slice(2).join('/')

    if (isNaN(itemIndex)) {
      return { ok: false, error: `Invalid item index "${segments[1]}" in path "${path}"` }
    }

    const binding = this.findModelForDataPath(surfaceId, collectionPath)
    if (!binding) {
      return { ok: false, error: `No API binding found for data path "${collectionPath}"` }
    }

    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" not found` }
    }

    const collection = getByPointer(surface.dataModel, collectionPath)
    if (!Array.isArray(collection) || itemIndex >= collection.length) {
      return { ok: false, error: `No item at ${collectionPath}/${itemIndex}` }
    }

    const item = collection[itemIndex]
    const itemId = item?.id
    if (!itemId) {
      return { ok: false, error: `Item at ${collectionPath}/${itemIndex} has no id field` }
    }

    const result = await this.executeMutation(surfaceId, binding.runtime, {
      endpoint: `${binding.endpoint}/${itemId}`,
      method: 'PATCH',
      body: { [field]: value },
    })
    return result
  }

  /**
   * Auto-derive and execute a DELETE mutation for a DataList item.
   * Called when a Button with deleteAction dispatches __delete_item__.
   */
  async handleDeleteItem(
    surfaceId: string,
    collectionPath: string,
    itemId: string,
  ): Promise<{ ok: boolean; error?: string; dataPath?: string }> {
    const binding = this.findModelForDataPath(surfaceId, collectionPath)
    if (!binding) {
      return { ok: false, error: `No API binding found for data path "${collectionPath}"` }
    }

    const result = await this.executeMutation(surfaceId, binding.runtime, {
      endpoint: `${binding.endpoint}/${itemId}`,
      method: 'DELETE',
    })
    return result
  }

  /**
   * Attempt to derive a CRUD mutation from the action name and context.
   * Handles patterns like "save_hotel", "add_activity", "delete_todo",
   * "reserve_restaurant" by matching the noun to an API model endpoint.
   */
  private inferMutation(
    runtime: ManagedApiRuntime,
    event: ActionEvent,
  ): { endpoint: string; method: string; body?: unknown } | null {
    const name = event.name?.toLowerCase() ?? ''
    const ctx = event.context ?? {}

    const endpoints = runtime.getEndpoints()
    if (endpoints.length === 0) return null

    // Extract verb and noun from action name (e.g. "save_hotel" → verb="save", noun="hotel")
    const parts = name.split('_')
    if (parts.length < 2) return null

    const verb = parts[0]
    const noun = parts.slice(1).join('_')

    // Match noun to an endpoint (fuzzy: "hotel" matches "/api/hotels")
    const matchedEndpoint = endpoints.find((ep) => {
      const epNoun = ep.path.replace('/api/', '').toLowerCase()
      return epNoun.startsWith(noun) || noun.startsWith(epNoun.replace(/s$|es$|ies$/, ''))
    })
    if (!matchedEndpoint) return null

    const id = ctx.id ?? ctx.itemId ?? ctx[`${noun}Id`] ?? ctx[`${noun}_id`]

    switch (verb) {
      case 'save':
      case 'add':
      case 'create':
      case 'reserve':
      case 'book': {
        const body = { ...ctx }
        delete body.id
        delete body.itemId
        delete body._mutation
        if (id) {
          return { endpoint: `${matchedEndpoint.path}/${id}`, method: 'PATCH', body }
        }
        return { endpoint: matchedEndpoint.path, method: 'POST', body }
      }
      case 'delete':
      case 'remove':
      case 'cancel': {
        if (id) {
          return { endpoint: `${matchedEndpoint.path}/${id}`, method: 'DELETE' }
        }
        return null
      }
      case 'update':
      case 'edit':
      case 'toggle':
      case 'mark': {
        if (id) {
          const body = { ...ctx }
          delete body.id
          delete body.itemId
          delete body._mutation
          return { endpoint: `${matchedEndpoint.path}/${id}`, method: 'PATCH', body }
        }
        return null
      }
      default:
        return null
    }
  }

  async executeMutation(
    surfaceId: string,
    runtime: ManagedApiRuntime,
    mutation: { endpoint: string; method: string; body?: unknown },
  ): Promise<{ ok: boolean; status?: number; error?: string; dataPath?: string; itemCount?: number }> {
    const { endpoint, method, body } = mutation
    const url = `http://localhost${endpoint}`
    const req = new Request(url, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    })

    const res = await runtime.getApp().fetch(req)
    const json = await res.json() as Record<string, unknown>

    if (json.ok === false) {
      return { ok: false, status: res.status, error: json.error as string ?? 'Mutation returned ok: false' }
    }

    const upperMethod = method.toUpperCase()
    const collectionEndpoint =
      upperMethod === 'POST' ? endpoint : endpoint.replace(/\/[^/]+$/, '') || endpoint
    const listReq = new Request(`http://localhost${collectionEndpoint}`, { method: 'GET' })
    const listRes = await runtime.getApp().fetch(listReq)
    const listJson = await listRes.json() as Record<string, unknown>

    const dataPath = collectionEndpoint.replace(/^\/api/, '')
    if (Array.isArray(listJson.items)) {
      this.updateData(surfaceId, dataPath, listJson.items)

      // Refresh all filtered query bindings for the affected model
      const surfaceBindings = this.queryBindings.get(surfaceId)
      if (surfaceBindings) {
        const endpointInfo = runtime.getModelEndpointInfo()
        const matched = endpointInfo.find(e => e.endpoint === collectionEndpoint)
        if (matched) {
          const bindings = surfaceBindings.get(matched.name)
          if (bindings) {
            for (const binding of bindings) {
              if (binding.dataPath === dataPath) continue
              const queryResult = runtime.query(matched.name, binding.params) as any
              if (queryResult.ok && binding.dataPath) {
                this.updateData(surfaceId, binding.dataPath, queryResult.items)
              }
            }
          }
        }
      }

      this.recomputeCollectionSummaries(surfaceId, dataPath, listJson.items)

      return { ok: true, dataPath, itemCount: listJson.items.length }
    }
    return { ok: true, dataPath }
  }

  /**
   * After a collection is updated, scan the dataModel for summary objects
   * that reference counts derived from this collection (e.g., total, boolean
   * field counts, inverse counts) and recompute them automatically.
   */
  private recomputeCollectionSummaries(surfaceId: string, collectionPath: string, items: unknown[]): void {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) return

    const boolFields = new Map<string, number>()
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (typeof v === 'boolean') {
          boolFields.set(k, (boolFields.get(k) ?? 0) + (v ? 1 : 0))
        }
      }
    }

    for (const [key, value] of Object.entries(surface.dataModel)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const summary = value as Record<string, unknown>
      if (typeof summary.total !== 'number') continue

      const updated: Record<string, unknown> = {}
      let changed = false

      updated.total = items.length
      if (updated.total !== summary.total) changed = true

      for (const [sumKey, sumVal] of Object.entries(summary)) {
        if (sumKey === 'total' || typeof sumVal !== 'number') continue

        if (boolFields.has(sumKey)) {
          const newCount = boolFields.get(sumKey)!
          updated[sumKey] = newCount
          if (newCount !== sumVal) changed = true
        } else {
          // Check if this is an inverse of a boolean field (e.g., pending = total - completed)
          for (const [bf, trueCount] of boolFields) {
            if (bf in summary && typeof summary[bf] === 'number') {
              const oldInverse = (summary.total as number) - (summary[bf] as number)
              if (sumVal === oldInverse) {
                const newInverse = items.length - trueCount
                updated[sumKey] = newInverse
                if (newInverse !== sumVal) changed = true
                break
              }
            }
          }
        }
      }

      if (changed) {
        this.updateData(surfaceId, `/${key}`, { ...summary, ...updated })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Declarative Hooks
  // ---------------------------------------------------------------------------

  registerHooks(
    surfaceId: string,
    modelName: string,
    defs: HookDefinitions,
  ): { ok: boolean; registered: string[]; error?: string } {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) return { ok: false, registered: [], error: `Surface "${surfaceId}" not found` }

    const runtime = this.runtimes.get(surfaceId)
    if (!runtime || !runtime.isReady()) return { ok: false, registered: [], error: 'No API runtime for this surface. Call canvas_api_schema first.' }

    if (!surface.hookDefinitions) surface.hookDefinitions = {}
    surface.hookDefinitions[modelName] = defs

    const hooks = this.buildHookFunctions(surfaceId, modelName, defs, runtime)
    runtime.setModelHooks(modelName, hooks)
    this.scheduleSave()

    const registered: string[] = []
    for (const phase of ['beforeCreate', 'beforeUpdate', 'afterCreate', 'afterUpdate', 'afterDelete'] as const) {
      if (defs[phase]?.length) registered.push(`${phase}(${defs[phase]!.length})`)
    }
    return { ok: true, registered }
  }

  private buildHookFunctions(
    surfaceId: string,
    modelName: string,
    defs: HookDefinitions,
    runtime: ManagedApiRuntime,
  ): ManagedModelHooks {
    const hooks: ManagedModelHooks = {}

    // --- beforeCreate ---
    const beforeCreateActions = defs.beforeCreate ?? []
    if (beforeCreateActions.length) {
      hooks.beforeCreate = async (input, ctx) => {
        return this.runBeforeHooks(beforeCreateActions, input, ctx)
      }
    }

    // --- beforeUpdate ---
    const beforeUpdateActions = defs.beforeUpdate ?? []
    if (beforeUpdateActions.length) {
      hooks.beforeUpdate = async (_id, input, ctx) => {
        return this.runBeforeHooks(beforeUpdateActions, input, ctx)
      }
    }

    // --- afterCreate ---
    const afterCreateActions = defs.afterCreate ?? []
    if (afterCreateActions.length) {
      hooks.afterCreate = async (record, ctx) => {
        await this.runAfterHooks(surfaceId, modelName, 'create', afterCreateActions, record, ctx, runtime)
      }
    }

    // --- afterUpdate ---
    const afterUpdateActions = defs.afterUpdate ?? []
    if (afterUpdateActions.length) {
      hooks.afterUpdate = async (record, ctx) => {
        await this.runAfterHooks(surfaceId, modelName, 'update', afterUpdateActions, record, ctx, runtime)
      }
    }

    // --- afterDelete ---
    const afterDeleteActions = defs.afterDelete ?? []
    if (afterDeleteActions.length) {
      hooks.afterDelete = async (id, ctx) => {
        await this.runAfterHooks(surfaceId, modelName, 'delete', afterDeleteActions, { id } as Record<string, unknown>, ctx, runtime)
      }
    }

    return hooks
  }

  private runBeforeHooks(
    actions: HookAction[],
    input: Record<string, unknown>,
    _ctx: ManagedHookContext,
  ): ManagedHookResult | void {
    const data = { ...input }

    for (const action of actions) {
      if (action.action === 'validate') {
        const err = this.executeValidate(action, data)
        if (err) return { ok: false, error: err }
      } else if (action.action === 'transform') {
        this.executeTransform(action, data)
      }
    }

    return { ok: true, data }
  }

  private async runAfterHooks(
    surfaceId: string,
    modelName: string,
    operation: string,
    actions: HookAction[],
    record: Record<string, unknown>,
    ctx: ManagedHookContext,
    runtime: ManagedApiRuntime,
  ): Promise<void> {
    for (const action of actions) {
      try {
        switch (action.action) {
          case 'recompute':
            await this.executeRecompute(surfaceId, action, runtime)
            break
          case 'cascade-delete':
            this.executeCascadeDelete(action, record, ctx)
            break
          case 'log':
            this.executeLog(action, modelName, operation, record, ctx)
            break
        }
      } catch (err) {
        console.error(`[hooks] Error executing ${action.action} on ${modelName}:`, err)
      }
    }
  }

  private executeValidate(action: ValidateAction, data: Record<string, unknown>): string | null {
    const val = data[action.field]
    const msg = action.message

    switch (action.rule) {
      case 'required':
        if (val === undefined || val === null || val === '')
          return msg ?? `${action.field} is required`
        break
      case 'positive':
        if (typeof val !== 'number' || val <= 0)
          return msg ?? `${action.field} must be a positive number`
        break
      case 'min':
        if (typeof val === 'number' && typeof action.value === 'number' && val < action.value)
          return msg ?? `${action.field} must be at least ${action.value}`
        break
      case 'max':
        if (typeof val === 'number' && typeof action.value === 'number' && val > action.value)
          return msg ?? `${action.field} must be at most ${action.value}`
        break
      case 'pattern':
        if (typeof val === 'string' && typeof action.value === 'string' && !new RegExp(action.value).test(val))
          return msg ?? `${action.field} does not match required pattern`
        break
      case 'enum': {
        if (typeof action.value === 'string') {
          const allowed = action.value.split(',').map(s => s.trim())
          if (!allowed.includes(String(val)))
            return msg ?? `${action.field} must be one of: ${allowed.join(', ')}`
        }
        break
      }
    }
    return null
  }

  private executeTransform(action: TransformAction, data: Record<string, unknown>): void {
    const val = data[action.field]
    if (val === undefined || val === null) return

    switch (action.transform) {
      case 'lowercase':
        if (typeof val === 'string') data[action.field] = val.toLowerCase()
        break
      case 'uppercase':
        if (typeof val === 'string') data[action.field] = val.toUpperCase()
        break
      case 'trim':
        if (typeof val === 'string') data[action.field] = val.trim()
        break
      case 'round':
        if (typeof val === 'number') data[action.field] = Math.round(val)
        break
      case 'floor':
        if (typeof val === 'number') data[action.field] = Math.floor(val)
        break
      case 'ceil':
        if (typeof val === 'number') data[action.field] = Math.ceil(val)
        break
      case 'abs':
        if (typeof val === 'number') data[action.field] = Math.abs(val)
        break
    }
  }

  private async executeRecompute(
    surfaceId: string,
    action: RecomputeAction,
    runtime: ManagedApiRuntime,
  ): Promise<void> {
    const sourcePath = action.source.startsWith('/api') ? action.source : `/api${action.source}`
    const req = new Request(`http://localhost${sourcePath}`, { method: 'GET' })
    const res = await runtime.getApp().fetch(req)
    const json = await res.json() as Record<string, unknown>

    if (!Array.isArray(json.items)) return

    const items = json.items as Record<string, unknown>[]
    let result: unknown

    switch (action.aggregate) {
      case 'count':
        result = items.length
        break
      case 'sum':
        result = items.reduce((acc, item) => acc + (Number(item[action.field!]) || 0), 0)
        break
      case 'avg':
        result = items.length > 0
          ? items.reduce((acc, item) => acc + (Number(item[action.field!]) || 0), 0) / items.length
          : 0
        break
      case 'min':
        result = items.length > 0
          ? Math.min(...items.map(item => Number(item[action.field!]) || 0))
          : 0
        break
      case 'max':
        result = items.length > 0
          ? Math.max(...items.map(item => Number(item[action.field!]) || 0))
          : 0
        break
    }

    this.updateData(surfaceId, action.target, result)
  }

  private executeCascadeDelete(
    action: CascadeDeleteAction,
    record: Record<string, unknown>,
    ctx: ManagedHookContext,
  ): void {
    const parentId = record.id as string
    if (!parentId) return
    try {
      ctx.db.prepare(`DELETE FROM "${action.target}" WHERE "${action.foreignKey}" = ?`).run(parentId)
    } catch (err) {
      console.error(`[hooks] cascade-delete failed for ${action.target}.${action.foreignKey}:`, err)
    }
  }

  private executeLog(
    action: LogAction,
    modelName: string,
    operation: string,
    record: Record<string, unknown>,
    ctx: ManagedHookContext,
  ): void {
    const id = generateHookId()
    const now = new Date().toISOString()

    const builtins: Record<string, string> = {
      '$id': String(record.id ?? ''),
      '$operation': operation,
      '$model': modelName,
      '$timestamp': now,
    }

    const fields: Record<string, unknown> = {}
    if (action.fields) {
      for (const [col, template] of Object.entries(action.fields)) {
        fields[col] = builtins[template] ?? template
      }
    } else {
      fields.entityId = record.id ?? ''
      fields.action = operation
      fields.model = modelName
    }

    const allCols = ['id', 'createdAt', 'updatedAt', ...Object.keys(fields)]
    const colsSql = allCols.map(c => `"${c}"`).join(', ')
    const placeholders = allCols.map(() => '?').join(', ')
    const values = [id, now, now, ...Object.values(fields).map(v => typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''))]

    try {
      ctx.db.prepare(`INSERT INTO "${action.target}" (${colsSql}) VALUES (${placeholders})`).run(...values)
    } catch (err) {
      console.error(`[hooks] log insert into ${action.target} failed:`, err)
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
        apiModels: surface.apiModels,
        hookDefinitions: surface.hookDefinitions,
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

  /**
   * Public helper for canvas_update: attempt to infer a mutation for a button
   * component that has an action.name but no mutation defined.
   * Returns the inferred mutation or null if inference fails.
   */
  inferMutationForButton(
    surfaceId: string,
    actionName: string,
  ): { endpoint: string; method: string } | null {
    const runtime = this.runtimes.get(surfaceId)
    if (!runtime || !runtime.isReady()) return null

    const endpoints = runtime.getEndpoints()
    if (endpoints.length === 0) return null

    const name = actionName.toLowerCase()
    const parts = name.split('_')
    if (parts.length < 2) return null

    const verb = parts[0]
    const noun = parts.slice(1).join('_')

    const matchedEndpoint = endpoints.find((ep) => {
      const epNoun = ep.path.replace('/api/', '').toLowerCase()
      return epNoun.startsWith(noun) || noun.startsWith(epNoun.replace(/s$|es$|ies$/, ''))
    })
    if (!matchedEndpoint) return null

    switch (verb) {
      case 'save':
      case 'add':
      case 'create':
      case 'reserve':
      case 'book':
        return { endpoint: matchedEndpoint.path, method: 'POST' }
      case 'delete':
      case 'remove':
      case 'cancel':
        return { endpoint: `${matchedEndpoint.path}/:id`, method: 'DELETE' }
      case 'update':
      case 'edit':
      case 'toggle':
      case 'mark':
      case 'patch':
        return { endpoint: `${matchedEndpoint.path}/:id`, method: 'PATCH' }
      default:
        return null
    }
  }

  // ---------------------------------------------------------------------------
  // Managed API Runtime (per-surface data layer)
  // ---------------------------------------------------------------------------

  getOrCreateRuntime(surfaceId: string): ManagedApiRuntime {
    let runtime = this.runtimes.get(surfaceId)
    if (!runtime) {
      const workDir = this.persistPath
        ? join(dirname(this.persistPath), 'api-runtimes')
        : join(process.cwd(), '.dynamic-app-runtimes')
      runtime = new ManagedApiRuntime({ surfaceId, workDir })
      this.runtimes.set(surfaceId, runtime)
    }
    return runtime
  }

  getRuntime(surfaceId: string): ManagedApiRuntime | undefined {
    return this.runtimes.get(surfaceId)
  }

  applyApiSchema(surfaceId: string, models: ModelDefinition[], reset = false): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    const runtime = this.getOrCreateRuntime(surfaceId)
    const result = runtime.applySchema(models, reset)

    if (result.ok) {
      surface.apiModels = models as SurfaceState['apiModels']
      this.scheduleSave()

      const modelInfo = runtime.getModelEndpointInfo()
      this.broadcast({
        type: 'configureApi',
        surfaceId,
        models: modelInfo,
      })
    }

    return result
  }

  bindToolApi(
    surfaceId: string,
    config: Omit<ToolBindingConfig, 'cache'> & { cache?: { enabled: boolean; ttlSeconds?: number }; dataPath?: string },
    mcpClient: MCPClientManager,
  ): Record<string, unknown> {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) {
      return { ok: false, error: `Surface "${surfaceId}" does not exist. Create it with canvas_create first.` }
    }

    if (!this.mcpClientRef) {
      this.mcpClientRef = mcpClient
    }

    let toolRuntime = this.toolRuntimes.get(surfaceId)
    if (!toolRuntime) {
      toolRuntime = new ToolBackedApiRuntime(mcpClient)
      this.toolRuntimes.set(surfaceId, toolRuntime)
    }

    const bindingConfig: ToolBindingConfig = {
      ...config,
      dataPath: config.dataPath,
    } as ToolBindingConfig
    const result = toolRuntime.addBinding(bindingConfig)

    const endpointInfo = toolRuntime.getEndpointInfo()
    this.broadcast({
      type: 'configureApi',
      surfaceId,
      models: endpointInfo,
    })

    if (config.dataPath && config.bindings.list) {
      this.autoQueryToolBinding(surfaceId, config.model, config.dataPath, toolRuntime)
    }

    return {
      ok: true,
      model: result.model,
      endpoint: result.endpoint,
      methods: result.methods,
      dataPath: config.dataPath,
      message: `Bound "${result.model}" to tool-backed CRUD routes at ${result.endpoint}. Methods: ${result.methods.join(', ')}` +
        (config.dataPath ? `. Data auto-loaded at "${config.dataPath}".` : ''),
    }
  }

  /**
   * Fetch list data from a tool binding and push it into the surface data model.
   * Runs asynchronously — does not block the bindToolApi return.
   */
  private autoQueryToolBinding(
    surfaceId: string,
    model: string,
    dataPath: string,
    toolRuntime: ToolBackedApiRuntime,
  ): void {
    toolRuntime.fetchListData(model).then(result => {
      if (result.ok && result.items) {
        this.updateData(surfaceId, dataPath, result.items)
      }
    }).catch(err => {
      console.error(`[DynamicAppManager] Auto-query for ${model} failed:`, err)
    })
  }

  getToolRuntime(surfaceId: string): ToolBackedApiRuntime | undefined {
    return this.toolRuntimes.get(surfaceId)
  }

  /**
   * Queue a tool binding to be applied when the target surface is created.
   * Used by tool_install's `bind` option when the canvas doesn't exist yet.
   */
  deferToolBinding(
    surfaceId: string,
    config: Omit<ToolBindingConfig, 'cache'> & { cache?: { enabled: boolean; ttlSeconds?: number }; dataPath?: string },
    mcpClient: MCPClientManager,
  ): void {
    if (!this.mcpClientRef) {
      this.mcpClientRef = mcpClient
    }
    if (!this.deferredToolBindings.has(surfaceId)) {
      this.deferredToolBindings.set(surfaceId, [])
    }
    this.deferredToolBindings.get(surfaceId)!.push({ config })
  }

  /**
   * Check if a tool call matches any bound tool across all surfaces.
   * If so, invalidate the cache and re-push fresh data to the data model.
   * Called from the gateway's onAfterToolCall hook for reactive UI updates.
   */
  handleToolCallInvalidation(toolName: string): void {
    for (const [surfaceId, toolRuntime] of this.toolRuntimes) {
      const boundTools = toolRuntime.getBoundToolNames()
      const model = boundTools.get(toolName)
      if (!model) continue

      toolRuntime.invalidateCache(model)

      const binding = toolRuntime.getBindings().find(b => b.model === model)
      if (binding?.dataPath && binding.bindings.list) {
        this.autoQueryToolBinding(surfaceId, model, binding.dataPath, toolRuntime)
      }
    }
  }

  seedApiData(surfaceId: string, model: string, records: Record<string, unknown>[], upsert = false): Record<string, unknown> {
    const runtime = this.runtimes.get(surfaceId)
    if (!runtime || !runtime.isReady()) {
      return { ok: false, error: `No API runtime for surface "${surfaceId}". Call canvas_api_schema first.` }
    }
    const result = runtime.seed(model, records, upsert)

    if ((result as any).ok) {
      const surfaceBindings = this.queryBindings.get(surfaceId)
      const bindings = surfaceBindings?.get(model)
      if (bindings) {
        for (const binding of bindings) {
          const queryResult = runtime.query(model, binding.params) as any
          if (queryResult.ok && binding.dataPath) {
            this.updateData(surfaceId, binding.dataPath, queryResult.items)
          }
        }
      }
    }

    return result
  }

  queryApiData(
    surfaceId: string,
    model: string,
    params?: { where?: Record<string, unknown>; orderBy?: string; limit?: number },
    dataPath?: string,
  ): Record<string, unknown> {
    const runtime = this.runtimes.get(surfaceId)
    if (!runtime || !runtime.isReady()) {
      return { ok: false, error: `No API runtime for surface "${surfaceId}". Call canvas_api_schema first.` }
    }

    const result = runtime.query(model, params)

    if (result.ok) {
      // Re-broadcast configureApi so late-connecting SSE clients learn about the API
      const modelInfo = runtime.getModelEndpointInfo()
      this.broadcast({ type: 'configureApi', surfaceId, models: modelInfo })

      if (dataPath) {
        this.updateData(surfaceId, dataPath, result.items)

        // Register binding so mutations can auto-refresh this data path
        if (!this.queryBindings.has(surfaceId)) {
          this.queryBindings.set(surfaceId, new Map())
        }
        const surfaceBindings = this.queryBindings.get(surfaceId)!
        if (!surfaceBindings.has(model)) {
          surfaceBindings.set(model, [])
        }
        const modelBindings = surfaceBindings.get(model)!
        const existingIdx = modelBindings.findIndex(b => b.dataPath === dataPath)
        if (existingIdx >= 0) {
          modelBindings[existingIdx] = { dataPath, params }
        } else {
          modelBindings.push({ dataPath, params })
        }
      }
    }

    return result
  }

  clear(): void {
    this.surfaces.clear()
    this.queryBindings.clear()
    this.actionQueue.length = 0
    for (const w of this.actionWaiters) {
      clearTimeout(w.timeout)
      w.resolve(null as any)
    }
    this.actionWaiters.length = 0
    for (const runtime of this.runtimes.values()) {
      runtime.destroy()
    }
    this.runtimes.clear()
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
          apiModels: s.apiModels,
          hookDefinitions: s.hookDefinitions,
          createdAt: s.createdAt || new Date().toISOString(),
          updatedAt: s.updatedAt || new Date().toISOString(),
        })
        restored++
      }

      if (restored > 0) {
        console.log(`[DynamicAppManager] Restored ${restored} surface(s) from disk`)
      }

      // Restore API runtimes for surfaces that had active schemas
      let runtimesRestored = 0
      let hooksRestored = 0
      for (const [id, surface] of this.surfaces) {
        if (surface.apiModels && surface.apiModels.length > 0) {
          try {
            const runtime = this.getOrCreateRuntime(id)
            const result = runtime.applySchema(surface.apiModels as ModelDefinition[], false)
            if (result.ok) {
              runtimesRestored++
              // Re-register hooks from persisted definitions
              if (surface.hookDefinitions) {
                for (const [modelName, defs] of Object.entries(surface.hookDefinitions)) {
                  const hooks = this.buildHookFunctions(id, modelName, defs, runtime)
                  runtime.setModelHooks(modelName, hooks)
                  hooksRestored++
                }
              }
            } else {
              console.error(`[DynamicAppManager] Failed to restore runtime for "${id}":`, result.error)
            }
          } catch (err) {
            console.error(`[DynamicAppManager] Error restoring runtime for "${id}":`, err)
          }
        }
      }

      if (runtimesRestored > 0) {
        console.log(`[DynamicAppManager] Restored ${runtimesRestored} API runtime(s) and ${hooksRestored} hook registration(s) from disk`)
      }
    } catch (err) {
      console.error('[DynamicAppManager] Failed to load canvas state:', err)
    }
  }

  /**
   * Reload state from disk. Used after S3 sync downloads updated files.
   * Clears existing state and re-loads everything, then broadcasts
   * the new state to all connected SSE clients.
   */
  reloadFromDisk(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.destroy()
    }
    this.runtimes.clear()
    this.surfaces.clear()
    this.loadFromDisk()
    this.broadcastFullState()
  }

  /**
   * Broadcast the full current state to all connected SSE clients.
   * Sends a clearAll first so clients reset, then replays all surfaces.
   */
  private broadcastFullState(): void {
    if (this.sseClients.size === 0) return

    this.broadcast({ type: 'clearAll' } as any)

    for (const surface of this.surfaces.values()) {
      this.broadcast({
        type: 'createSurface',
        surfaceId: surface.surfaceId,
        title: surface.title,
        theme: (surface as any).theme,
      })

      const components = Object.values(surface.components) as ComponentDefinition[]
      if (components.length > 0) {
        this.broadcast({ type: 'updateComponents', surfaceId: surface.surfaceId, components })
      }

      if (Object.keys(surface.dataModel).length > 0) {
        this.broadcast({ type: 'updateData', surfaceId: surface.surfaceId, path: '/', value: surface.dataModel })
      }

      const runtime = this.runtimes.get(surface.surfaceId)
      if (runtime) {
        const modelInfo = runtime.getModelEndpointInfo()
        this.broadcast({ type: 'configureApi', surfaceId: surface.surfaceId, models: modelInfo })
      }
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

/**
 * LLMs frequently send JSON values as stringified JSON (e.g. `"[{\"id\":1}]"`)
 * instead of native JSON arrays/objects. Auto-parse when the string looks like
 * a JSON array or object so data bindings work correctly.
 */
function autoParseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
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
