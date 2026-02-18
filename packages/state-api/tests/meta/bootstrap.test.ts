/**
 * Tests for runtime store cache (Unit 3: Workspace-Aware Caching)
 *
 * These tests verify the bug fix for workspace isolation. Previously, the cache
 * was keyed only by schemaId, causing multiple workspaces to share the same
 * runtime store and corrupting data. Now cache keys include location dimension.
 *
 * Bug Fix: https://github.com/your-org/shogo-state-api/issues/XXX
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  getRuntimeStore,
  cacheRuntimeStore,
  clearRuntimeStores,
  removeRuntimeStore,
  getCachedSchemaIds
} from '../../src/meta/bootstrap'

describe('Runtime Store Cache - Workspace-Aware Caching (Unit 3)', () => {
  beforeEach(() => {
    clearRuntimeStores()
  })

  describe('Backward Compatibility', () => {
    test('caches and retrieves store without location parameter', () => {
      const mockStore = { type: 'mock-store-1', data: 'test' }
      cacheRuntimeStore('schema-123', mockStore)

      const retrieved = getRuntimeStore('schema-123')
      expect(retrieved).toBe(mockStore)
      expect(retrieved.type).toBe('mock-store-1')
    })

    test('undefined location is equivalent to no location', () => {
      const mockStore = { type: 'default-store' }
      cacheRuntimeStore('schema-456', mockStore, undefined)

      const retrieved = getRuntimeStore('schema-456')
      expect(retrieved).toBe(mockStore)
    })
  })

  describe('Workspace Isolation', () => {
    test('different locations create separate cache entries', () => {
      const store1 = { type: 'workspace-1-store', data: 'A' }
      const store2 = { type: 'workspace-2-store', data: 'B' }

      cacheRuntimeStore('schema-1', store1, '/workspace1')
      cacheRuntimeStore('schema-1', store2, '/workspace2')

      const retrieved1 = getRuntimeStore('schema-1', '/workspace1')
      const retrieved2 = getRuntimeStore('schema-1', '/workspace2')

      expect(retrieved1).toBe(store1)
      expect(retrieved2).toBe(store2)
      expect(retrieved1).not.toBe(retrieved2)
    })

    test('same schema + different locations do not conflict', () => {
      const schemaId = 'shared-schema-789'
      const storeA = { workspace: 'A', data: [1, 2, 3] }
      const storeB = { workspace: 'B', data: [4, 5, 6] }
      const storeC = { workspace: 'C', data: [7, 8, 9] }

      cacheRuntimeStore(schemaId, storeA, '/path/to/workspace-a')
      cacheRuntimeStore(schemaId, storeB, '/path/to/workspace-b')
      cacheRuntimeStore(schemaId, storeC, '/path/to/workspace-c')

      expect(getRuntimeStore(schemaId, '/path/to/workspace-a')).toBe(storeA)
      expect(getRuntimeStore(schemaId, '/path/to/workspace-b')).toBe(storeB)
      expect(getRuntimeStore(schemaId, '/path/to/workspace-c')).toBe(storeC)
    })

    test('empty string location is treated as no location', () => {
      const mockStore = { type: 'default-store' }
      cacheRuntimeStore('schema-empty', mockStore, '')

      const retrieved = getRuntimeStore('schema-empty')
      expect(retrieved).toBe(mockStore)
    })
  })

  describe('Cache Operations', () => {
    test('cache miss returns undefined', () => {
      expect(getRuntimeStore('non-existent-schema')).toBeUndefined()
      expect(getRuntimeStore('schema-1', '/non-existent-workspace')).toBeUndefined()
    })

    test('removeRuntimeStore removes specific location', () => {
      const store1 = { id: 1 }
      const store2 = { id: 2 }

      cacheRuntimeStore('schema-remove', store1, '/workspace1')
      cacheRuntimeStore('schema-remove', store2, '/workspace2')

      const removed = removeRuntimeStore('schema-remove', '/workspace1')
      expect(removed).toBe(true)

      expect(getRuntimeStore('schema-remove', '/workspace1')).toBeUndefined()
      expect(getRuntimeStore('schema-remove', '/workspace2')).toBe(store2)
    })

    test('removeRuntimeStore returns false if not in cache', () => {
      const removed = removeRuntimeStore('schema-not-cached', '/workspace')
      expect(removed).toBe(false)
    })

    test('clearRuntimeStores clears all entries', () => {
      cacheRuntimeStore('schema-1', {}, '/workspace1')
      cacheRuntimeStore('schema-1', {}, '/workspace2')
      cacheRuntimeStore('schema-2', {})

      clearRuntimeStores()

      expect(getRuntimeStore('schema-1', '/workspace1')).toBeUndefined()
      expect(getRuntimeStore('schema-1', '/workspace2')).toBeUndefined()
      expect(getRuntimeStore('schema-2')).toBeUndefined()
    })

    test('getCachedSchemaIds returns composite keys', () => {
      cacheRuntimeStore('schema-1', {}, '/workspace1')
      cacheRuntimeStore('schema-1', {}, '/workspace2')
      cacheRuntimeStore('schema-2', {})

      const keys = getCachedSchemaIds()

      expect(keys).toContain('/workspace1::schema-1')
      expect(keys).toContain('/workspace2::schema-1')
      expect(keys).toContain('schema-2')
      expect(keys).toHaveLength(3)
    })
  })

  describe('Edge Cases', () => {
    test('special characters in location are preserved', () => {
      const mockStore = { type: 's3-store' }
      const s3Location = 's3://bucket/prefix/path'
      const windowsPath = 'C:\\workspace\\project'

      cacheRuntimeStore('schema-s3', mockStore, s3Location)
      cacheRuntimeStore('schema-windows', { type: 'windows' }, windowsPath)

      expect(getRuntimeStore('schema-s3', s3Location)).toBe(mockStore)
      expect(getRuntimeStore('schema-windows', windowsPath).type).toBe('windows')
    })

    test('double colon separator prevents collisions', () => {
      // These should NOT collide because we use :: separator
      const store1 = { collisionTest: 'store1' }
      const store2 = { collisionTest: 'store2' }

      // Location "a:b" with schema "c" → "a:b::c"
      cacheRuntimeStore('c', store1, 'a:b')

      // Location "a" with schema "b:c" → "a::b:c"
      cacheRuntimeStore('b:c', store2, 'a')

      const retrieved1 = getRuntimeStore('c', 'a:b')
      const retrieved2 = getRuntimeStore('b:c', 'a')

      expect(retrieved1).toBe(store1)
      expect(retrieved2).toBe(store2)
      expect(retrieved1.collisionTest).toBe('store1')
      expect(retrieved2.collisionTest).toBe('store2')

      // Verify cache keys are indeed different
      const keys = getCachedSchemaIds()
      expect(keys).toContain('a:b::c')
      expect(keys).toContain('a::b:c')
      expect(keys).toHaveLength(2)
    })
  })
})
