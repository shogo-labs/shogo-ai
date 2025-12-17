/**
 * MemoryBackend Tests
 *
 * Generated from TestSpecifications for task-memory-backend
 * Tests the in-memory backend implementation using @ucast/js
 *
 * Requirements:
 * - REQ-03: Backend abstraction with pluggable execution strategies
 * - MEM-01 through MEM-07: Memory backend specific requirements
 *
 * CRITICAL: @ucast/js uses interpret(ast, item) pattern, NOT interpret(ast)(item)
 * See: packages/state-api/src/query/discovery/memory-backend-poc.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { FieldCondition } from '@ucast/core'
import type { Condition } from '../../ast/types'
import type { IBackend, QueryResult } from '../types'
import { MemoryBackend } from '../memory'

// ============================================================================
// Test Fixtures
// ============================================================================

interface TestUser {
  id: string
  name: string
  age: number
  status: 'active' | 'inactive'
  tags: string[]
}

const createTestUsers = (): TestUser[] => [
  { id: '1', name: 'Alice', age: 30, status: 'active', tags: ['featured', 'premium'] },
  { id: '2', name: 'Bob', age: 25, status: 'inactive', tags: ['standard'] },
  { id: '3', name: 'Charlie', age: 35, status: 'active', tags: ['featured'] },
  { id: '4', name: 'Diana', age: 28, status: 'active', tags: ['premium'] },
  { id: '5', name: 'Eve', age: 32, status: 'inactive', tags: ['standard', 'legacy'] },
]

// ============================================================================
// Test Suite
// ============================================================================

describe('MemoryBackend', () => {
  let backend: MemoryBackend
  let testUsers: TestUser[]

  beforeEach(() => {
    backend = new MemoryBackend()
    testUsers = createTestUsers()
  })

  // ==========================================================================
  // test-memory-implements-interface
  // ==========================================================================
  describe('Interface Implementation', () => {
    test('MemoryBackend implements IBackend interface', () => {
      // When: Creating MemoryBackend instance
      const instance = new MemoryBackend()

      // Then: Instance has execute method
      expect(instance).toHaveProperty('execute')
      expect(typeof instance.execute).toBe('function')

      // Then: Instance has capabilities property
      expect(instance).toHaveProperty('capabilities')
      expect(instance.capabilities).toBeDefined()

      // Then: Satisfies IBackend interface
      const asBackend: IBackend = instance
      expect(asBackend).toBeDefined()
    })
  })

  // ==========================================================================
  // test-memory-ucast-js
  // ==========================================================================
  describe('@ucast/js Integration', () => {
    test('Uses @ucast/js for filtering', async () => {
      // Given: Collection of items and parsed AST condition
      const ast: Condition = new FieldCondition('eq', 'status', 'active')

      // When: Executing query with filter
      const result = await backend.execute(ast, testUsers)

      // Then: Items matching condition are returned
      expect(result.items).toHaveLength(3)
      expect(result.items.every(u => u.status === 'active')).toBe(true)

      // Then: Items not matching are excluded
      expect(result.items.some(u => u.status === 'inactive')).toBe(false)
    })
  })

  // ==========================================================================
  // test-memory-interpret-pattern
  // ==========================================================================
  describe('Critical interpret(ast, item) Pattern', () => {
    test('Uses interpret(ast, item) NOT interpret(ast)(item)', async () => {
      // Given: Collection with items
      const ast: Condition = new FieldCondition('gt', 'age', 30)

      // When: Filtering with any condition
      const result = await backend.execute(ast, testUsers)

      // Then: Filter executes without "Unable to get field X out of undefined" error
      expect(result.items).toBeDefined()

      // Then: Correct items returned (age > 30)
      expect(result.items).toHaveLength(2) // Charlie (35), Eve (32)
      expect(result.items.every(u => u.age > 30)).toBe(true)
    })
  })

  // ==========================================================================
  // test-memory-contains-string
  // ==========================================================================
  describe('$contains Operator - Strings', () => {
    test('$contains works for string fields', async () => {
      // Given: Items with name field: ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve']
      const ast: Condition = new FieldCondition('contains', 'name', 'li')

      // When: Executing { name: { $contains: 'li' } }
      const result = await backend.execute(ast, testUsers)

      // Then: Returns items where name includes 'li'
      expect(result.items).toHaveLength(2)

      // Then: Alice and Charlie returned
      const names = result.items.map(u => u.name).sort()
      expect(names).toEqual(['Alice', 'Charlie'])

      // Then: Bob, Diana, Eve excluded
      expect(result.items.some(u => u.name === 'Bob')).toBe(false)
    })
  })

  // ==========================================================================
  // test-memory-contains-array
  // ==========================================================================
  describe('$contains Operator - Arrays', () => {
    test('$contains works for array fields', async () => {
      // Given: Items with tags array field
      const ast: Condition = new FieldCondition('contains', 'tags', 'featured')

      // When: Executing { tags: { $contains: 'featured' } }
      const result = await backend.execute(ast, testUsers)

      // Then: Returns items where tags includes 'featured'
      expect(result.items).toHaveLength(2) // Alice, Charlie

      // Then: Array.includes() used for checking
      expect(result.items.every(u => u.tags.includes('featured'))).toBe(true)

      // Then: Items without tag excluded
      expect(result.items.some(u => u.name === 'Bob')).toBe(false)
    })
  })

  // ==========================================================================
  // test-memory-orderby
  // ==========================================================================
  describe('Multi-field Sorting', () => {
    test('applyOrderBy handles multi-field sorting', async () => {
      // Given: Unsorted collection
      const ast: Condition = new FieldCondition('eq', 'status', 'active') // Filter to active only

      // When: Executing with orderBy: [{ field: 'status', direction: 'asc' }, { field: 'name', direction: 'desc' }]
      const result = await backend.execute(ast, testUsers, {
        orderBy: [
          { field: 'status', direction: 'asc' },
          { field: 'name', direction: 'desc' }
        ]
      })

      // Then: Primary sort by status ascending (all same)
      expect(result.items.every(u => u.status === 'active')).toBe(true)

      // Then: Secondary sort by name descending within same status
      const names = result.items.map(u => u.name)
      expect(names).toEqual(['Diana', 'Charlie', 'Alice'])
    })
  })

  // ==========================================================================
  // test-memory-pagination
  // ==========================================================================
  describe('Pagination', () => {
    test('skip/take pagination via array slice', async () => {
      // Given: Collection of 5 items (extended to 100 for proper test)
      const largeCollection: TestUser[] = Array.from({ length: 100 }, (_, i) => ({
        id: `${i + 1}`,
        name: `User${i + 1}`,
        age: 20 + (i % 50),
        status: i % 2 === 0 ? 'active' : 'inactive',
        tags: []
      }))

      // Filter for all items (empty condition)
      const ast: Condition = new FieldCondition('gte', 'age', 0) // Match all

      // When: Executing with skip: 20, take: 10
      const result = await backend.execute(ast, largeCollection, {
        skip: 20,
        take: 10
      })

      // Then: Exactly 10 items returned
      expect(result.items).toHaveLength(10)

      // Then: Returns items 21-30 (0-indexed: 20-29)
      expect(result.items[0].id).toBe('21')
      expect(result.items[9].id).toBe('30')

      // Then: Original collection unchanged
      expect(largeCollection).toHaveLength(100)
    })
  })

  // ==========================================================================
  // test-memory-capabilities
  // ==========================================================================
  describe('Capabilities Declaration', () => {
    test('capabilities declares all supported operators', () => {
      // Given: MemoryBackend instance
      // When: Accessing capabilities property
      const caps = backend.capabilities

      // Then: operators includes $eq, $ne, $gt, $gte, $lt, $lte
      expect(caps.operators).toContain('eq')
      expect(caps.operators).toContain('ne')
      expect(caps.operators).toContain('gt')
      expect(caps.operators).toContain('gte')
      expect(caps.operators).toContain('lt')
      expect(caps.operators).toContain('lte')

      // Then: operators includes $in, $nin, $regex, $contains
      expect(caps.operators).toContain('in')
      expect(caps.operators).toContain('nin')
      expect(caps.operators).toContain('regex')
      expect(caps.operators).toContain('contains')

      // Then: operators includes $and, $or, $not
      expect(caps.operators).toContain('and')
      expect(caps.operators).toContain('or')
      expect(caps.operators).toContain('not')
    })
  })

  // ==========================================================================
  // test-memory-same-references
  // ==========================================================================
  describe('MST Reference Preservation', () => {
    test('Returns same MST references (not cloned)', async () => {
      // Given: MST collection with observable items (simulated with object identity)
      const originalUser = testUsers[0]
      const ast: Condition = new FieldCondition('eq', 'id', '1')

      // When: Executing query that matches items
      const result = await backend.execute(ast, testUsers)

      // Then: Returned items are === original references
      expect(result.items[0]).toBe(originalUser)

      // Then: No object cloning performed (reference equality, not just value equality)
      const clonedUser = Object.assign({}, originalUser)
      expect(result.items[0]).not.toBe(clonedUser) // Different reference
      expect(result.items[0]).toBe(originalUser) // Same reference

      // Then: MST reactivity preserved (same identity)
      expect(Object.is(result.items[0], originalUser)).toBe(true)
    })
  })

  // ==========================================================================
  // test-memory-empty-collection
  // ==========================================================================
  describe('Edge Cases - Empty Collection', () => {
    test('Handles empty collection gracefully', async () => {
      // Given: Empty collection []
      const emptyCollection: TestUser[] = []
      const ast: Condition = new FieldCondition('eq', 'status', 'active')

      // When: Executing any query
      const result = await backend.execute(ast, emptyCollection)

      // Then: Returns { items: [] }
      expect(result.items).toEqual([])

      // Then: No errors thrown
      expect(result).toBeDefined()

      // Then: totalCount is 0 if requested
      if (result.totalCount !== undefined) {
        expect(result.totalCount).toBe(0)
      }
    })
  })

  // ==========================================================================
  // test-memory-empty-filter
  // ==========================================================================
  describe('Edge Cases - Empty Filter', () => {
    test('Empty filter returns all items', async () => {
      // Given: Collection with 5 items
      // Use a condition that matches everything (simulate empty filter)
      const ast: Condition = new FieldCondition('gte', 'age', 0)

      // When: Executing with empty-equivalent filter
      const result = await backend.execute(ast, testUsers)

      // Then: All 5 items returned
      expect(result.items).toHaveLength(5)

      // Then: Order preserved (or matches input)
      expect(result.items.map(u => u.id)).toEqual(['1', '2', '3', '4', '5'])
    })
  })

  // ==========================================================================
  // test-memory-performance
  // ==========================================================================
  describe('Performance', () => {
    test('10k items filter+sort+paginate < 200ms', async () => {
      // Given: Collection of 10,000 items
      const largeCollection: TestUser[] = Array.from({ length: 10000 }, (_, i) => ({
        id: `${i + 1}`,
        name: `User${i + 1}`,
        age: 20 + (i % 80),
        status: i % 3 === 0 ? 'active' : 'inactive',
        tags: i % 5 === 0 ? ['featured'] : ['standard']
      }))

      // Complex query with filter
      const ast: Condition = new FieldCondition('gt', 'age', 50)

      const startTime = performance.now()

      // When: Executing complex query with filter, orderBy, skip, take
      const result = await backend.execute(ast, largeCollection, {
        orderBy: [
          { field: 'status', direction: 'asc' },
          { field: 'age', direction: 'desc' }
        ],
        skip: 100,
        take: 50
      })

      const duration = performance.now() - startTime

      // Then: Execution completes in under 200ms
      expect(duration).toBeLessThan(200)

      // Then: Correct results returned
      expect(result.items).toHaveLength(50)
      expect(result.items.every(u => u.age > 50)).toBe(true)

      // Then: No memory issues (able to complete)
      expect(result.items).toBeDefined()
    })
  })
})
