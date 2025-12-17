/**
 * Memory Backend PoC
 *
 * Testing against requirements from spec/03-memory-backend.md:
 * - MEM-01: Execute all comparison operators against JS values
 * - MEM-02: Execute logical operators with short-circuit evaluation
 * - MEM-03: Support orderBy with multi-field sorting
 * - MEM-04: Support skip/take pagination
 * - MEM-05: Handle MST reference resolution in filters
 * - MEM-06: Return MST instances (not plain objects)
 * - MEM-07: Declare capabilities via BackendCapabilities
 *
 * Evaluating: @ucast/js (already installed from query-ast PoC)
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { FieldCondition, CompoundCondition, type Condition } from '@ucast/core'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import {
  createJsInterpreter,
  allInterpreters,
  eq, ne, gt, gte, lt, lte,
  within as $in, nin,
  regex,
  and, or, not,
} from '@ucast/js'

// ============================================================================
// CUSTOM $contains INTERPRETER
// ============================================================================

/**
 * Custom interpreter for $contains operator.
 * Checks if a string contains substring or array contains element.
 */
function contains(condition: FieldCondition<any>, object: any, { get }: { get: (obj: any, field: string) => any }) {
  const value = get(object, condition.field)

  if (typeof value === 'string' && typeof condition.value === 'string') {
    return value.includes(condition.value)
  }

  if (Array.isArray(value)) {
    return value.includes(condition.value)
  }

  return false
}

// Extended interpreters with $contains
const extendedInterpreters = {
  ...allInterpreters,
  contains,
}

// Parser with $contains support
const parser = new MongoQueryParser({
  ...allParsingInstructions,
  $contains: { type: 'field' as const },
})

// Interpreter
const interpret = createJsInterpreter(extendedInterpreters)

// ============================================================================
// BACKEND CAPABILITIES
// ============================================================================

interface BackendCapabilities {
  operators: Set<string>
  features: {
    orderBy: boolean
    pagination: boolean
    include: boolean
    select: boolean
    groupBy: boolean
  }
  optimizations: {
    supportsNativeCount: boolean
    supportsNativeExists: boolean
    supportsStreaming: boolean
  }
}

const memoryCapabilities: BackendCapabilities = {
  operators: new Set([
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
    'in', 'nin', 'regex', 'contains',
    'and', 'or', 'not'
  ]),
  features: {
    orderBy: true,
    pagination: true,
    include: false,  // All data already in memory
    select: false,   // Return full entities
    groupBy: false   // Not supported initially
  },
  optimizations: {
    supportsNativeCount: false,  // Must filter all, then count
    supportsNativeExists: false,
    supportsStreaming: false
  }
}

// ============================================================================
// MEMORY BACKEND IMPLEMENTATION
// ============================================================================

interface QueryDescriptor {
  filter?: object
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>
  skip?: number
  take?: number
}

/**
 * Memory backend implementation using @ucast/js for filtering.
 * Handles orderBy, skip, take separately (not part of @ucast).
 */
class MemoryBackend {
  readonly name = 'memory'
  readonly capabilities = memoryCapabilities

  /**
   * Execute query against an array of items.
   * Returns filtered, sorted, paginated results.
   */
  execute<T>(items: T[], query: QueryDescriptor): T[] {
    let results = [...items]

    // 1. Filter using @ucast/js
    if (query.filter && Object.keys(query.filter).length > 0) {
      const ast = parser.parse(query.filter)
      results = results.filter(item => interpret(ast, item))
    }

    // 2. Sort (MEM-03)
    if (query.orderBy && query.orderBy.length > 0) {
      results = this.applyOrderBy(results, query.orderBy)
    }

    // 3. Paginate (MEM-04)
    if (query.skip !== undefined) {
      results = results.slice(query.skip)
    }
    if (query.take !== undefined) {
      results = results.slice(0, query.take)
    }

    return results
  }

  /**
   * Count matching items without full materialization.
   */
  count<T>(items: T[], filter?: object): number {
    if (!filter || Object.keys(filter).length === 0) {
      return items.length
    }
    const ast = parser.parse(filter)
    return items.filter(item => interpret(ast, item)).length
  }

  /**
   * Check if any items match.
   */
  any<T>(items: T[], filter?: object): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return items.length > 0
    }
    const ast = parser.parse(filter)
    return items.some(item => interpret(ast, item))
  }

  /**
   * Multi-field sorting with direction support.
   */
  private applyOrderBy<T>(items: T[], orderBy: Array<{ field: string; direction: 'asc' | 'desc' }>): T[] {
    return items.sort((a, b) => {
      for (const { field, direction } of orderBy) {
        const aVal = this.getNestedValue(a, field)
        const bVal = this.getNestedValue(b, field)

        let comparison = 0
        if (aVal < bVal) comparison = -1
        else if (aVal > bVal) comparison = 1

        if (comparison !== 0) {
          return direction === 'desc' ? -comparison : comparison
        }
      }
      return 0
    })
  }

  /**
   * Get nested value from object using dot notation.
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj)
  }
}

// ============================================================================
// TEST DATA
// ============================================================================

interface TestUser {
  id: string
  name: string
  email: string
  age: number
  status: 'active' | 'inactive' | 'pending'
  tags: string[]
  organizationId: string
  createdAt: string
}

interface TestOrganization {
  id: string
  name: string
  tier: 'free' | 'pro' | 'enterprise'
}

const organizations: TestOrganization[] = [
  { id: 'org-1', name: 'Acme Corp', tier: 'enterprise' },
  { id: 'org-2', name: 'Startup Inc', tier: 'pro' },
  { id: 'org-3', name: 'Hobby Shop', tier: 'free' },
]

const users: TestUser[] = [
  { id: '1', name: 'Alice Smith', email: 'alice@acme.com', age: 30, status: 'active', tags: ['admin', 'developer'], organizationId: 'org-1', createdAt: '2025-01-15' },
  { id: '2', name: 'Bob Jones', email: 'bob@startup.io', age: 25, status: 'active', tags: ['developer'], organizationId: 'org-2', createdAt: '2025-02-20' },
  { id: '3', name: 'Carol White', email: 'carol@acme.com', age: 35, status: 'inactive', tags: ['admin'], organizationId: 'org-1', createdAt: '2024-06-10' },
  { id: '4', name: 'Dave Brown', email: 'dave@hobby.net', age: 22, status: 'pending', tags: [], organizationId: 'org-3', createdAt: '2025-03-01' },
  { id: '5', name: 'Eve Davis', email: 'eve@startup.io', age: 28, status: 'active', tags: ['developer', 'lead'], organizationId: 'org-2', createdAt: '2025-01-05' },
]

// ============================================================================
// TESTS
// ============================================================================

describe('Memory Backend PoC', () => {
  let backend: MemoryBackend

  beforeAll(() => {
    backend = new MemoryBackend()
  })

  describe('MEM-01: Comparison Operators', () => {
    test('$eq - equality', () => {
      const results = backend.execute(users, { filter: { status: 'active' } })
      expect(results).toHaveLength(3)
      expect(results.map(u => u.id)).toEqual(['1', '2', '5'])
    })

    test('$ne - not equal', () => {
      const results = backend.execute(users, { filter: { status: { $ne: 'active' } } })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.id)).toEqual(['3', '4'])
    })

    test('$gt - greater than', () => {
      const results = backend.execute(users, { filter: { age: { $gt: 28 } } })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Carol White'])
    })

    test('$gte - greater than or equal', () => {
      const results = backend.execute(users, { filter: { age: { $gte: 28 } } })
      expect(results).toHaveLength(3) // 30, 35, 28
    })

    test('$lt - less than', () => {
      const results = backend.execute(users, { filter: { age: { $lt: 25 } } })
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Dave Brown')
    })

    test('$lte - less than or equal', () => {
      const results = backend.execute(users, { filter: { age: { $lte: 25 } } })
      expect(results).toHaveLength(2) // 25, 22
    })

    test('$in - in array', () => {
      const results = backend.execute(users, { filter: { status: { $in: ['active', 'pending'] } } })
      expect(results).toHaveLength(4)
    })

    test('$nin - not in array', () => {
      const results = backend.execute(users, { filter: { status: { $nin: ['inactive', 'pending'] } } })
      expect(results).toHaveLength(3)
    })

    test('$regex - regular expression', () => {
      const results = backend.execute(users, { filter: { email: { $regex: '@acme\\.com$' } } })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Carol White'])
    })

    test('$contains - string containment', () => {
      const results = backend.execute(users, { filter: { name: { $contains: 'Smith' } } })
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Alice Smith')
    })

    test('$contains - array containment', () => {
      const results = backend.execute(users, { filter: { tags: { $contains: 'admin' } } })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Carol White'])
    })
  })

  describe('MEM-02: Logical Operators', () => {
    test('implicit $and - multiple conditions', () => {
      const results = backend.execute(users, {
        filter: { status: 'active', age: { $gte: 28 } }
      })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Eve Davis'])
    })

    test('explicit $and', () => {
      const results = backend.execute(users, {
        filter: {
          $and: [
            { status: 'active' },
            { organizationId: 'org-2' }
          ]
        }
      })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Bob Jones', 'Eve Davis'])
    })

    test('$or - disjunction', () => {
      const results = backend.execute(users, {
        filter: {
          $or: [
            { status: 'inactive' },
            { status: 'pending' }
          ]
        }
      })
      expect(results).toHaveLength(2)
    })

    test('$not - negation (field level)', () => {
      const results = backend.execute(users, {
        filter: {
          status: { $not: { $eq: 'active' } }
        }
      })
      expect(results).toHaveLength(2)
    })

    test('nested logical operators', () => {
      const results = backend.execute(users, {
        filter: {
          $and: [
            { status: 'active' },
            {
              $or: [
                { age: { $lt: 26 } },
                { tags: { $contains: 'admin' } }
              ]
            }
          ]
        }
      })
      // Active users who are either <26 or have admin tag
      // Alice (active, admin), Bob (active, 25), Eve (active, 28, lead)
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Bob Jones'])
    })
  })

  describe('MEM-03: orderBy with multi-field sorting', () => {
    test('single field ascending', () => {
      const results = backend.execute(users, {
        orderBy: [{ field: 'age', direction: 'asc' }]
      })
      expect(results.map(u => u.age)).toEqual([22, 25, 28, 30, 35])
    })

    test('single field descending', () => {
      const results = backend.execute(users, {
        orderBy: [{ field: 'age', direction: 'desc' }]
      })
      expect(results.map(u => u.age)).toEqual([35, 30, 28, 25, 22])
    })

    test('multi-field sorting', () => {
      const results = backend.execute(users, {
        orderBy: [
          { field: 'organizationId', direction: 'asc' },
          { field: 'age', direction: 'desc' }
        ]
      })
      // org-1: Carol (35), Alice (30)
      // org-2: Eve (28), Bob (25)
      // org-3: Dave (22)
      expect(results.map(u => u.name)).toEqual([
        'Carol White', 'Alice Smith',  // org-1
        'Eve Davis', 'Bob Jones',       // org-2
        'Dave Brown'                    // org-3
      ])
    })

    test('string field sorting', () => {
      const results = backend.execute(users, {
        orderBy: [{ field: 'name', direction: 'asc' }]
      })
      expect(results.map(u => u.name)).toEqual([
        'Alice Smith', 'Bob Jones', 'Carol White', 'Dave Brown', 'Eve Davis'
      ])
    })

    test('date string sorting', () => {
      const results = backend.execute(users, {
        orderBy: [{ field: 'createdAt', direction: 'asc' }]
      })
      expect(results.map(u => u.createdAt)).toEqual([
        '2024-06-10', '2025-01-05', '2025-01-15', '2025-02-20', '2025-03-01'
      ])
    })
  })

  describe('MEM-04: skip/take pagination', () => {
    test('take only', () => {
      const results = backend.execute(users, { take: 2 })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.id)).toEqual(['1', '2'])
    })

    test('skip only', () => {
      const results = backend.execute(users, { skip: 3 })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.id)).toEqual(['4', '5'])
    })

    test('skip and take', () => {
      const results = backend.execute(users, { skip: 1, take: 2 })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.id)).toEqual(['2', '3'])
    })

    test('pagination with orderBy', () => {
      const results = backend.execute(users, {
        orderBy: [{ field: 'age', direction: 'asc' }],
        skip: 1,
        take: 2
      })
      // Sorted by age: 22, 25, 28, 30, 35
      // Skip 1, take 2: 25, 28
      expect(results.map(u => u.age)).toEqual([25, 28])
    })

    test('pagination with filter and orderBy', () => {
      const results = backend.execute(users, {
        filter: { status: 'active' },
        orderBy: [{ field: 'age', direction: 'desc' }],
        skip: 1,
        take: 1
      })
      // Active users: Alice(30), Bob(25), Eve(28)
      // Sorted by age desc: 30, 28, 25
      // Skip 1, take 1: 28 (Eve)
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Eve Davis')
    })
  })

  describe('MEM-05: Reference ID filtering', () => {
    test('filter by reference ID', () => {
      const results = backend.execute(users, {
        filter: { organizationId: 'org-1' }
      })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Alice Smith', 'Carol White'])
    })

    test('filter by reference ID with $in', () => {
      const results = backend.execute(users, {
        filter: { organizationId: { $in: ['org-1', 'org-3'] } }
      })
      expect(results).toHaveLength(3)
    })

    test('filter by reference ID with other conditions', () => {
      const results = backend.execute(users, {
        filter: {
          organizationId: 'org-2',
          status: 'active'
        }
      })
      expect(results).toHaveLength(2)
      expect(results.map(u => u.name)).toEqual(['Bob Jones', 'Eve Davis'])
    })
  })

  describe('MEM-06: Return original objects (MST instances)', () => {
    test('returned objects are same references', () => {
      const results = backend.execute(users, { filter: { id: '1' } })
      expect(results[0]).toBe(users[0]) // Same object reference
    })

    test('original array not mutated by sort', () => {
      const originalOrder = users.map(u => u.id)
      backend.execute(users, {
        orderBy: [{ field: 'age', direction: 'desc' }]
      })
      expect(users.map(u => u.id)).toEqual(originalOrder)
    })
  })

  describe('MEM-07: Backend capabilities', () => {
    test('declares all operators', () => {
      expect(backend.capabilities.operators.has('eq')).toBe(true)
      expect(backend.capabilities.operators.has('regex')).toBe(true)
      expect(backend.capabilities.operators.has('contains')).toBe(true)
    })

    test('declares features correctly', () => {
      expect(backend.capabilities.features.orderBy).toBe(true)
      expect(backend.capabilities.features.pagination).toBe(true)
      expect(backend.capabilities.features.include).toBe(false)
      expect(backend.capabilities.features.groupBy).toBe(false)
    })

    test('declares optimizations correctly', () => {
      expect(backend.capabilities.optimizations.supportsNativeCount).toBe(false)
      expect(backend.capabilities.optimizations.supportsNativeExists).toBe(false)
    })
  })

  describe('count() and any() methods', () => {
    test('count without filter', () => {
      expect(backend.count(users)).toBe(5)
    })

    test('count with filter', () => {
      expect(backend.count(users, { status: 'active' })).toBe(3)
    })

    test('any without filter', () => {
      expect(backend.any(users)).toBe(true)
      expect(backend.any([])).toBe(false)
    })

    test('any with filter - exists', () => {
      expect(backend.any(users, { status: 'active' })).toBe(true)
    })

    test('any with filter - not exists', () => {
      expect(backend.any(users, { status: 'deleted' })).toBe(false)
    })
  })

  describe('Edge cases', () => {
    test('empty filter returns all', () => {
      const results = backend.execute(users, { filter: {} })
      expect(results).toHaveLength(5)
    })

    test('no filter returns all', () => {
      const results = backend.execute(users, {})
      expect(results).toHaveLength(5)
    })

    test('filter returns empty when no matches', () => {
      const results = backend.execute(users, { filter: { status: 'deleted' } })
      expect(results).toHaveLength(0)
    })

    test('skip beyond array length returns empty', () => {
      const results = backend.execute(users, { skip: 100 })
      expect(results).toHaveLength(0)
    })

    test('take 0 returns empty', () => {
      const results = backend.execute(users, { take: 0 })
      expect(results).toHaveLength(0)
    })
  })
})

describe('Nested Path Filtering (Reference Traversal)', () => {
  // Create denormalized data to test nested path filtering
  interface DenormalizedUser {
    id: string
    name: string
    organization: {
      id: string
      name: string
      tier: string
    }
  }

  const denormalizedUsers: DenormalizedUser[] = [
    { id: '1', name: 'Alice', organization: { id: 'org-1', name: 'Acme Corp', tier: 'enterprise' } },
    { id: '2', name: 'Bob', organization: { id: 'org-2', name: 'Startup Inc', tier: 'pro' } },
    { id: '3', name: 'Carol', organization: { id: 'org-1', name: 'Acme Corp', tier: 'enterprise' } },
  ]

  const backend = new MemoryBackend()

  test('filter by nested property', () => {
    const results = backend.execute(denormalizedUsers, {
      filter: { 'organization.tier': 'enterprise' }
    })
    expect(results).toHaveLength(2)
    expect(results.map(u => u.name)).toEqual(['Alice', 'Carol'])
  })

  test('filter by nested property with operators', () => {
    const results = backend.execute(denormalizedUsers, {
      filter: { 'organization.name': { $contains: 'Corp' } }
    })
    expect(results).toHaveLength(2)
  })

  test('orderBy nested property', () => {
    const results = backend.execute(denormalizedUsers, {
      orderBy: [{ field: 'organization.tier', direction: 'asc' }]
    })
    // enterprise, enterprise, pro
    expect(results.map(u => u.organization.tier)).toEqual(['enterprise', 'enterprise', 'pro'])
  })
})

describe('Performance (Sanity Check)', () => {
  // Generate larger dataset
  const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
    id: `user-${i}`,
    name: `User ${i}`,
    age: 18 + (i % 50),
    status: i % 3 === 0 ? 'active' : i % 3 === 1 ? 'inactive' : 'pending',
    score: Math.random() * 100,
  }))

  const backend = new MemoryBackend()

  test('10k items - simple filter', () => {
    const start = performance.now()
    const results = backend.execute(largeDataset, { filter: { status: 'active' } })
    const elapsed = performance.now() - start

    expect(results.length).toBeGreaterThan(3000)
    expect(elapsed).toBeLessThan(100) // Should complete in under 100ms
  })

  test('10k items - complex filter', () => {
    const start = performance.now()
    const results = backend.execute(largeDataset, {
      filter: {
        $and: [
          { status: 'active' },
          { age: { $gte: 25, $lte: 40 } },
          { score: { $gt: 50 } }
        ]
      }
    })
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(100)
  })

  test('10k items - filter + sort + paginate', () => {
    const start = performance.now()
    const results = backend.execute(largeDataset, {
      filter: { status: 'active' },
      orderBy: [{ field: 'score', direction: 'desc' }],
      skip: 100,
      take: 20
    })
    const elapsed = performance.now() - start

    expect(results).toHaveLength(20)
    expect(elapsed).toBeLessThan(200) // Sort is O(n log n)
  })
})
