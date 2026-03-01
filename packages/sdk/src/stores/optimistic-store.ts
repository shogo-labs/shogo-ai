/**
 * OptimisticStore
 *
 * A generic MobX store with optimistic updates and automatic rollback.
 * Used by generated store files for CRUD operations.
 */

import { makeAutoObservable, runInAction } from 'mobx'
import type { HttpClient } from '../http/client.js'

// ============================================================================
// Types
// ============================================================================

export interface OptimisticStoreConfig<T> {
  /** HTTP client for API calls */
  http: HttpClient
  /** API endpoint (e.g., '/api/workspaces') */
  endpoint: string
  /** Transform API response to store format (optional) */
  transform?: (item: any) => T
}

export interface StoreState {
  isLoading: boolean
  error: string | null
}

// ============================================================================
// OptimisticStore
// ============================================================================

/**
 * Generic store with optimistic updates and rollback.
 *
 * @example
 * ```typescript
 * const workspaceStore = new OptimisticStore<WorkspaceType>({
 *   http: httpClient,
 *   endpoint: '/api/workspaces',
 * })
 *
 * // Load all
 * await workspaceStore.loadAll()
 *
 * // Create (optimistic)
 * const workspace = await workspaceStore.create({ name: 'My Workspace' })
 *
 * // Update (optimistic)
 * await workspaceStore.update(workspace.id, { name: 'Updated' })
 *
 * // Delete (optimistic)
 * await workspaceStore.delete(workspace.id)
 * ```
 */
export class OptimisticStore<T extends { id: string }> {
  /** All items in the store */
  items = new Map<string, T>()

  /** Loading state */
  isLoading = false

  /** Last error message */
  error: string | null = null

  /** Items currently being created (temp ID -> optimistic item) */
  pendingCreates = new Map<string, T>()

  /** Items currently being updated (ID -> previous state for rollback) */
  pendingUpdates = new Map<string, T>()

  /** Items currently being deleted */
  pendingDeletes = new Set<string>()

  private http: HttpClient
  private endpoint: string
  private transform: (item: any) => T

  constructor(config: OptimisticStoreConfig<T>) {
    this.http = config.http
    this.endpoint = config.endpoint
    this.transform = config.transform ?? ((x) => x as T)
    // Mark non-observable properties to avoid MobX tracking them
    makeAutoObservable(this, {
      http: false,
      endpoint: false,
      transform: false,
    } as any)
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /** Get all items as array */
  get all(): T[] {
    return Array.from(this.items.values())
  }

  /** Get item by ID */
  get(id: string): T | undefined {
    return this.items.get(id)
  }

  /** Check if an item has a pending operation */
  isPending(id: string): boolean {
    return (
      this.pendingCreates.has(id) ||
      this.pendingUpdates.has(id) ||
      this.pendingDeletes.has(id)
    )
  }

  /** Check if item is being created */
  isCreating(id: string): boolean {
    return this.pendingCreates.has(id)
  }

  /** Check if item is being updated */
  isUpdating(id: string): boolean {
    return this.pendingUpdates.has(id)
  }

  /** Check if item is being deleted */
  isDeleting(id: string): boolean {
    return this.pendingDeletes.has(id)
  }

  // ==========================================================================
  // Read Operations
  // ==========================================================================

  /**
   * Load all items from the API
   */
  async loadAll(params?: Record<string, string>): Promise<T[]> {
    runInAction(() => {
      this.isLoading = true
      this.error = null
    })

    try {
      const { data } = await this.http.get<{ ok: boolean; items?: any[] }>(
        this.endpoint,
        params
      )

      if (!data?.ok || !data.items) {
        throw new Error('Invalid API response')
      }

      const items = data.items.map(this.transform)

      runInAction(() => {
        this.items.clear()
        for (const item of items) {
          this.items.set(item.id, item)
        }
        this.isLoading = false
      })

      return items
    } catch (error) {
      runInAction(() => {
        this.error = error instanceof Error ? error.message : 'Failed to load'
        this.isLoading = false
      })
      throw error
    }
  }

  /**
   * Load a single item by ID
   */
  async loadById(id: string): Promise<T> {
    try {
      const { data } = await this.http.get<{ ok: boolean; data?: any }>(
        `${this.endpoint}/${id}`
      )

      if (!data?.ok || !data.data) {
        throw new Error('Item not found')
      }

      const item = this.transform(data.data)

      runInAction(() => {
        this.items.set(item.id, item)
      })

      return item
    } catch (error) {
      runInAction(() => {
        this.error = error instanceof Error ? error.message : 'Failed to load'
      })
      throw error
    }
  }

  // ==========================================================================
  // Create (Optimistic)
  // ==========================================================================

  /**
   * Create a new item with optimistic update.
   * Item appears immediately, rolls back on failure.
   */
  async create(input: Partial<T>): Promise<T> {
    const tempId = `temp-${crypto.randomUUID()}`
    const now = new Date()

    // Create optimistic item with temp ID and timestamps
    const optimistic = {
      ...input,
      id: tempId,
      createdAt: now,
      updatedAt: now,
    } as unknown as T

    // Optimistic: add immediately
    runInAction(() => {
      this.pendingCreates.set(tempId, optimistic)
      this.items.set(tempId, optimistic)
      this.error = null
    })

    try {
      const { data } = await this.http.post<{ ok: boolean; data?: any }>(
        this.endpoint,
        input
      )

      if (!data?.ok || !data.data) {
        throw new Error('Create failed')
      }

      const item = this.transform(data.data)

      // Success: replace temp with real item
      runInAction(() => {
        this.pendingCreates.delete(tempId)
        this.items.delete(tempId)
        this.items.set(item.id, item)
      })

      return item
    } catch (error) {
      // Rollback: remove optimistic item
      runInAction(() => {
        this.pendingCreates.delete(tempId)
        this.items.delete(tempId)
        this.error = error instanceof Error ? error.message : 'Create failed'
      })
      throw error
    }
  }

  // ==========================================================================
  // Update (Optimistic)
  // ==========================================================================

  /**
   * Update an item with optimistic update.
   * Changes appear immediately, roll back on failure.
   */
  async update(id: string, changes: Partial<T>): Promise<T> {
    // Validate ID
    if (!id || typeof id !== 'string') {
      console.error('[OptimisticStore] update called with invalid id:', id)
      throw new Error('Invalid ID')
    }

    const existing = this.items.get(id)
    if (!existing) {
      throw new Error('Item not found')
    }

    // Don't allow concurrent updates to same item
    if (this.pendingUpdates.has(id)) {
      throw new Error('Update already in progress')
    }

    const previousState = { ...existing }

    // Optimistic: update immediately
    runInAction(() => {
      this.pendingUpdates.set(id, previousState)
      this.items.set(id, {
        ...existing,
        ...changes,
        updatedAt: new Date(),
      } as T)
      this.error = null
    })

    try {
      const { data } = await this.http.patch<{ ok: boolean; data?: any }>(
        `${this.endpoint}/${id}`,
        changes
      )

      if (!data?.ok || !data.data) {
        throw new Error('Update failed')
      }

      const item = this.transform(data.data)

      // Success: apply server response
      runInAction(() => {
        this.pendingUpdates.delete(id)
        this.items.set(id, item)
      })

      return item
    } catch (error) {
      // Rollback: restore previous state
      runInAction(() => {
        this.pendingUpdates.delete(id)
        this.items.set(id, previousState)
        this.error = error instanceof Error ? error.message : 'Update failed'
      })
      throw error
    }
  }

  // ==========================================================================
  // Delete (Optimistic)
  // ==========================================================================

  /**
   * Delete an item with optimistic update.
   * Item disappears immediately, reappears on failure.
   */
  async delete(id: string): Promise<void> {
    // Validate ID
    if (!id || typeof id !== 'string') {
      console.error('[OptimisticStore] delete called with invalid id:', id)
      throw new Error('Invalid ID')
    }

    const existing = this.items.get(id)
    if (!existing) {
      return // Already deleted
    }

    // Don't allow concurrent deletes
    if (this.pendingDeletes.has(id)) {
      return
    }

    // Optimistic: remove immediately
    runInAction(() => {
      this.pendingDeletes.add(id)
      this.items.delete(id)
      this.error = null
    })

    try {
      await this.http.delete(`${this.endpoint}/${id}`)

      // Success: confirm deletion
      runInAction(() => {
        this.pendingDeletes.delete(id)
      })
    } catch (error) {
      // Rollback: restore item
      runInAction(() => {
        this.pendingDeletes.delete(id)
        this.items.set(id, existing)
        this.error = error instanceof Error ? error.message : 'Delete failed'
      })
      throw error
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /** Clear error state */
  clearError(): void {
    this.error = null
  }

  /** Clear all data */
  clear(): void {
    this.items.clear()
    this.pendingCreates.clear()
    this.pendingUpdates.clear()
    this.pendingDeletes.clear()
    this.error = null
    this.isLoading = false
  }

  /**
   * Add an item directly to the store (for external updates like WebSocket)
   */
  addItem(item: T): void {
    this.items.set(item.id, item)
  }

  /**
   * Remove an item directly from the store (for external updates like WebSocket)
   */
  removeItem(id: string): void {
    this.items.delete(id)
  }

  /**
   * Update an item directly in the store (for external updates like WebSocket)
   */
  updateItem(id: string, changes: Partial<T>): void {
    const existing = this.items.get(id)
    if (existing) {
      this.items.set(id, { ...existing, ...changes } as T)
    }
  }
}
