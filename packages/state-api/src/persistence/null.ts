/**
 * No-op (in-memory) persistence implementation for testing.
 *
 * Stores data in a Map rather than writing to disk. Useful for:
 * - Unit tests that don't need real file I/O
 * - Temporary runtime stores that shouldn't persist
 * - Development/debugging where persistence isn't needed
 *
 * Data is lost when the process exits. Call clear() to reset between tests.
 */
import type { IPersistenceService, PersistenceContext, EntityContext } from './types'

export class NullPersistence implements IPersistenceService {
  /**
   * In-memory storage keyed by composite key.
   * Key format: "{location}:{schemaName}:{modelName}"
   *
   * This ensures workspace isolation even though we're in memory.
   */
  private store = new Map<string, any>()

  /**
   * Save collection snapshot to memory.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const key = this.buildKey(ctx)
    this.store.set(key, snapshot)
  }

  /**
   * Load collection snapshot from memory.
   * Returns null if not found.
   * Applies filter if provided (simulates partition pushdown behavior).
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    const key = this.buildKey(ctx)
    const collection = this.store.get(key)

    if (!collection) {
      return null
    }

    // Apply filter if provided (consistent with FileSystemPersistence)
    if (ctx.filter && collection.items) {
      const filteredItems: Record<string, any> = {}
      for (const [id, entity] of Object.entries(collection.items)) {
        const matches = Object.entries(ctx.filter).every(
          ([filterKey, value]) => (entity as any)[filterKey] === value
        )
        if (matches) {
          filteredItems[id] = entity
        }
      }
      return { items: filteredItems }
    }

    return collection
  }

  /**
   * Save single entity to memory.
   * Uses read-modify-write pattern like FileSystemPersistence.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    const collectionKey = this.buildKey(ctx)
    const collection = this.store.get(collectionKey) || { items: {} }

    collection.items[ctx.entityId] = snapshot
    this.store.set(collectionKey, collection)
  }

  /**
   * Load single entity from memory.
   * Returns null if collection or entity not found.
   */
  async loadEntity(ctx: EntityContext): Promise<any | null> {
    const collectionKey = this.buildKey(ctx)
    const collection = this.store.get(collectionKey)

    if (!collection || !collection.items) {
      return null
    }

    return collection.items[ctx.entityId] || null
  }

  /**
   * Clear all stored data.
   * Useful for test cleanup to avoid cross-test contamination.
   */
  clear(): void {
    this.store.clear()
  }

  /**
   * Build composite cache key for storage.
   *
   * Format: "{location}:{schemaName}:{modelName}"
   * Default location: "default"
   *
   * This ensures workspace isolation - same schema+model in different
   * locations are stored separately.
   *
   * @private
   */
  private buildKey(ctx: PersistenceContext): string {
    return `${ctx.location || 'default'}:${ctx.schemaName}:${ctx.modelName}`
  }
}
