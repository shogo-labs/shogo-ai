/**
 * Filesystem-based persistence implementation.
 *
 * Stores collections as JSON files following the pattern:
 * {location}/{schemaName}/data/{modelName}.json
 *
 * Example: .schemas/app-builder-project/data/Task.json
 *
 * This implementation reuses existing low-level file I/O utilities from io.ts
 * for consistency with the rest of the codebase.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { ensureDir, readJson, writeJson, exists } from './io'
import { loadSchema as loadSchemaFromDisk, listSchemas as listSchemasFromDisk } from './schema-io'
import type { IPersistenceService, PersistenceContext, EntityContext } from './types'

export class FileSystemPersistence implements IPersistenceService {
  /**
   * Save an entire collection snapshot to a JSON file.
   * Creates directory structure if it doesn't exist.
   */
  async saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void> {
    const filePath = this.buildCollectionPath(ctx)
    await ensureDir(path.dirname(filePath))
    await writeJson(filePath, snapshot)
  }

  /**
   * Load an entire collection snapshot from a JSON file.
   * Returns null if file doesn't exist (expected case).
   * Throws error for other failures (permission denied, invalid JSON, etc.).
   */
  async loadCollection(ctx: PersistenceContext): Promise<any | null> {
    const filePath = this.buildCollectionPath(ctx)

    // Check if file exists first to avoid error handling
    if (!await exists(filePath)) {
      return null
    }

    try {
      return await readJson(filePath)
    } catch (error: any) {
      // readJson might throw for invalid JSON
      throw error
    }
  }

  /**
   * Save a single entity within a collection.
   *
   * Implementation: Read collection → Update entity → Write collection
   *
   * ⚠️ WARNING: This uses a read-modify-write pattern which is NOT safe for
   * concurrent writes to the same collection. Multiple simultaneous calls can
   * result in lost updates (last write wins). For batch updates, use saveAll().
   * Future units may add queueing or optimistic locking.
   */
  async saveEntity(ctx: EntityContext, snapshot: any): Promise<void> {
    // Load existing collection or create empty one
    const collection = await this.loadCollection(ctx) || { items: {} }

    // Update the specific entity
    collection.items[ctx.entityId] = snapshot

    // Write back the entire collection
    await this.saveCollection(ctx, collection)
  }

  /**
   * Load a single entity from a collection.
   * Returns null if collection doesn't exist or entity not found.
   */
  async loadEntity(ctx: EntityContext): Promise<any | null> {
    const collection = await this.loadCollection(ctx)
    if (!collection || !collection.items) {
      return null
    }

    return collection.items[ctx.entityId] || null
  }

  /**
   * Build the file path for a collection.
   *
   * Pattern: {location || '.schemas'}/{schemaName}/data/{modelName}.json
   *
   * Uses path.join() for cross-platform compatibility (handles Windows backslashes).
   *
   * @private
   */
  private buildCollectionPath(ctx: PersistenceContext): string {
    const baseDir = ctx.location || '.schemas'
    return path.join(baseDir, ctx.schemaName, 'data', `${ctx.modelName}.json`)
  }

  // === Schema operations (for isomorphic support) ===

  /**
   * Load a schema from disk.
   * Delegates to schema-io.ts for actual file operations.
   */
  async loadSchema(name: string, location?: string): Promise<{
    metadata: { name: string; id?: string; views?: Record<string, any> }
    enhanced: any
  } | null> {
    try {
      return await loadSchemaFromDisk(name, location)
    } catch (error: any) {
      // Return null for "not found" errors, re-throw others
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * List available schemas from disk.
   * Delegates to schema-io.ts for actual directory listing.
   */
  async listSchemas(location?: string): Promise<string[]> {
    // schema-io listSchemas doesn't support workspace param, but returns objects
    // We just need the names
    const schemas = await listSchemasFromDisk()
    return schemas.map(s => s.name)
  }
}
