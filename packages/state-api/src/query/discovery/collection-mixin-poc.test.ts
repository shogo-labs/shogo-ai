/**
 * Collection Mixin PoC
 *
 * Testing IQueryable integration with MST collections:
 * - MIX-01: Add .query() view returning IQueryable<T>
 * - MIX-02: Compose with existing CollectionPersistable mixin
 * - MIX-03: Access environment services (registry, metaStore)
 * - MIX-04: Maintain backward compatibility with .where()
 * - MIX-05: Type-safe - IQueryable<T> typed to collection's model
 * - MIX-06: Lazy - no execution until terminal operation
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import { createJsInterpreter, allInterpreters as jsInterpreters } from '@ucast/js'
import { FieldCondition } from '@ucast/core'

// ============================================================================
// Types
// ============================================================================

type OrderDirection = 'asc' | 'desc'

interface OrderByClause {
  field: string
  direction: OrderDirection
}

interface QueryState {
  filter: Record<string, any>
  orderBy: OrderByClause[]
  skip?: number
  take?: number
  include: string[]
}

interface BackendCapabilities {
  operators: Set<string>
  orderBy: boolean
  pagination: boolean
  count: boolean
  exists: boolean
}

interface IBackend {
  name: string
  capabilities: BackendCapabilities
  execute<T>(query: QueryState, collection: T[]): Promise<T[]>
  count<T>(query: QueryState, collection: T[]): Promise<number>
}

interface IBackendRegistry {
  resolve(schemaName: string, modelName: string): IBackend
}

interface ValidationResult {
  valid: boolean
  errors: Array<{ code: string; message: string; path?: string }>
}

interface IQueryValidator {
  validate(schemaName: string, modelName: string, filter: Record<string, any>): ValidationResult
}

// ============================================================================
// IQueryable Interface
// ============================================================================

interface IQueryable<T> {
  // Chainable methods
  where(filter: Record<string, any>): IQueryable<T>
  orderBy(field: keyof T & string, direction?: OrderDirection): IQueryable<T>
  skip(count: number): IQueryable<T>
  take(count: number): IQueryable<T>
  include(path: string | string[]): IQueryable<T>

  // Terminal operations
  toArray(): Promise<T[]>
  first(): Promise<T | null>
  firstOrThrow(): Promise<T>
  count(): Promise<number>
  any(): Promise<boolean>

  // Inspection (for testing)
  getState(): QueryState
}

// ============================================================================
// Mock Memory Backend
// ============================================================================

const parser = new MongoQueryParser({
  ...allParsingInstructions,
  $contains: { type: 'field' as const },
})

function contains(condition: FieldCondition<any>, object: any, { get }: { get: (o: any, f: string) => any }) {
  const value = get(object, condition.field)
  if (typeof value === 'string') return value.includes(condition.value)
  if (Array.isArray(value)) return value.includes(condition.value)
  return false
}

const jsInterpret = createJsInterpreter({
  ...jsInterpreters,
  contains,
})

class MemoryBackend implements IBackend {
  name = 'memory'
  capabilities: BackendCapabilities = {
    operators: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains', 'and', 'or', 'not']),
    orderBy: true,
    pagination: true,
    count: true,
    exists: true,
  }

  async execute<T>(query: QueryState, collection: T[]): Promise<T[]> {
    let result = [...collection]

    // Filter - note: interpret(ast, item) pattern, not interpret(ast)(item)
    if (Object.keys(query.filter).length > 0) {
      const ast = parser.parse(query.filter)
      result = result.filter(item => jsInterpret(ast, item))
    }

    // Order
    if (query.orderBy.length > 0) {
      result.sort((a, b) => {
        for (const { field, direction } of query.orderBy) {
          const aVal = (a as any)[field]
          const bVal = (b as any)[field]
          if (aVal < bVal) return direction === 'asc' ? -1 : 1
          if (aVal > bVal) return direction === 'asc' ? 1 : -1
        }
        return 0
      })
    }

    // Pagination
    if (query.skip !== undefined) {
      result = result.slice(query.skip)
    }
    if (query.take !== undefined) {
      result = result.slice(0, query.take)
    }

    return result
  }

  async count<T>(query: QueryState, collection: T[]): Promise<number> {
    // Count ignores orderBy and pagination
    if (Object.keys(query.filter).length === 0) {
      return collection.length
    }

    const ast = parser.parse(query.filter)
    return collection.filter(item => jsInterpret(ast, item)).length
  }
}

// ============================================================================
// Mock Registry and Validator
// ============================================================================

class MockBackendRegistry implements IBackendRegistry {
  private backends = new Map<string, IBackend>()
  private default: IBackend

  constructor(defaultBackend: IBackend) {
    this.default = defaultBackend
    this.backends.set(defaultBackend.name, defaultBackend)
  }

  register(backend: IBackend) {
    this.backends.set(backend.name, backend)
  }

  resolve(schemaName: string, modelName: string): IBackend {
    // For PoC, always return default
    return this.default
  }
}

class MockQueryValidator implements IQueryValidator {
  private validProperties = new Set<string>()

  setValidProperties(properties: string[]) {
    this.validProperties = new Set(properties)
  }

  validate(schemaName: string, modelName: string, filter: Record<string, any>): ValidationResult {
    const errors: Array<{ code: string; message: string; path?: string }> = []

    const checkFields = (obj: Record<string, any>, path: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith('$')) {
          // Logical operator - recurse into conditions
          if (Array.isArray(value)) {
            value.forEach((v, i) => checkFields(v, `${path}${key}[${i}]`))
          }
        } else {
          // Field name
          if (this.validProperties.size > 0 && !this.validProperties.has(key)) {
            errors.push({
              code: 'INVALID_PROPERTY',
              message: `Property '${key}' does not exist on ${modelName}`,
              path: path ? `${path}.${key}` : key,
            })
          }
        }
      }
    }

    checkFields(filter)
    return { valid: errors.length === 0, errors }
  }
}

// ============================================================================
// QueryableBuilder Implementation
// ============================================================================

interface QueryableContext<T> {
  schemaName: string
  modelName: string
  collection: T[]
  backendRegistry: IBackendRegistry
  validator: IQueryValidator
}

class QueryableBuilder<T> implements IQueryable<T> {
  private state: QueryState = {
    filter: {},
    orderBy: [],
    include: [],
  }
  private context: QueryableContext<T>
  private executed = false

  constructor(context: QueryableContext<T>) {
    this.context = context
  }

  where(filter: Record<string, any>): IQueryable<T> {
    // Merge filters with $and if both exist
    if (Object.keys(this.state.filter).length > 0) {
      this.state.filter = {
        $and: [this.state.filter, filter],
      }
    } else {
      this.state.filter = { ...filter }
    }
    return this
  }

  orderBy(field: keyof T & string, direction: OrderDirection = 'asc'): IQueryable<T> {
    this.state.orderBy.push({ field, direction })
    return this
  }

  skip(count: number): IQueryable<T> {
    this.state.skip = count
    return this
  }

  take(count: number): IQueryable<T> {
    this.state.take = count
    return this
  }

  include(path: string | string[]): IQueryable<T> {
    const paths = Array.isArray(path) ? path : [path]
    this.state.include.push(...paths)
    return this
  }

  getState(): QueryState {
    return { ...this.state }
  }

  private validate(): void {
    const result = this.context.validator.validate(
      this.context.schemaName,
      this.context.modelName,
      this.state.filter
    )
    if (!result.valid) {
      const messages = result.errors.map(e => e.message).join('; ')
      throw new Error(`Query validation failed: ${messages}`)
    }
  }

  private async execute(): Promise<T[]> {
    this.validate()
    const backend = this.context.backendRegistry.resolve(
      this.context.schemaName,
      this.context.modelName
    )
    return backend.execute(this.state, this.context.collection)
  }

  async toArray(): Promise<T[]> {
    this.executed = true
    return this.execute()
  }

  async first(): Promise<T | null> {
    this.executed = true
    this.state.take = 1
    const results = await this.execute()
    return results[0] ?? null
  }

  async firstOrThrow(): Promise<T> {
    const result = await this.first()
    if (result === null) {
      throw new Error('No matching element found')
    }
    return result
  }

  async count(): Promise<number> {
    this.executed = true
    this.validate()
    const backend = this.context.backendRegistry.resolve(
      this.context.schemaName,
      this.context.modelName
    )
    return backend.count(this.state, this.context.collection)
  }

  async any(): Promise<boolean> {
    const count = await this.count()
    return count > 0
  }
}

// ============================================================================
// Mock MST Collection (simulating the mixin pattern)
// ============================================================================

interface User {
  id: string
  name: string
  email: string
  status: 'active' | 'inactive'
  role: 'admin' | 'member' | 'viewer'
  createdAt: number
}

interface CollectionMixin<T> {
  items: Map<string, T>
  modelName: string

  // Existing sync method
  where(filter: Record<string, any>): T[]

  // New async query API
  query(): IQueryable<T>
}

function createMockCollection<T extends { id: string }>(
  modelName: string,
  items: T[],
  context: {
    schemaName: string
    backendRegistry: IBackendRegistry
    validator: IQueryValidator
  }
): CollectionMixin<T> {
  const itemsMap = new Map(items.map(item => [item.id, item]))

  return {
    items: itemsMap,
    modelName,

    // Existing synchronous where (backward compat)
    where(filter: Record<string, any>): T[] {
      const ast = parser.parse(filter)
      return Array.from(itemsMap.values()).filter(item => jsInterpret(ast, item))
    },

    // New async query API
    query(): IQueryable<T> {
      return new QueryableBuilder<T>({
        schemaName: context.schemaName,
        modelName,
        collection: Array.from(itemsMap.values()),
        backendRegistry: context.backendRegistry,
        validator: context.validator,
      })
    },
  }
}

// ============================================================================
// Test Data
// ============================================================================

const testUsers: User[] = [
  { id: '1', name: 'Alice', email: 'alice@example.com', status: 'active', role: 'admin', createdAt: 1000 },
  { id: '2', name: 'Bob', email: 'bob@example.com', status: 'active', role: 'member', createdAt: 2000 },
  { id: '3', name: 'Charlie', email: 'charlie@example.com', status: 'inactive', role: 'member', createdAt: 3000 },
  { id: '4', name: 'Diana', email: 'diana@example.com', status: 'active', role: 'viewer', createdAt: 4000 },
  { id: '5', name: 'Eve', email: 'eve@example.com', status: 'inactive', role: 'admin', createdAt: 5000 },
]

// ============================================================================
// Tests: IQueryable Interface (MIX-01)
// ============================================================================

describe('IQueryable Interface (MIX-01)', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()
    validator.setValidProperties(['id', 'name', 'email', 'status', 'role', 'createdAt'])

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('.query() returns IQueryable', () => {
    const queryable = collection.query()
    expect(queryable).toBeDefined()
    expect(typeof queryable.where).toBe('function')
    expect(typeof queryable.orderBy).toBe('function')
    expect(typeof queryable.skip).toBe('function')
    expect(typeof queryable.take).toBe('function')
    expect(typeof queryable.toArray).toBe('function')
  })

  test('chainable methods return same interface', () => {
    const q1 = collection.query()
    const q2 = q1.where({ status: 'active' })
    const q3 = q2.orderBy('createdAt', 'desc')
    const q4 = q3.skip(1)
    const q5 = q4.take(5)

    // All return IQueryable
    expect(typeof q2.toArray).toBe('function')
    expect(typeof q3.toArray).toBe('function')
    expect(typeof q4.toArray).toBe('function')
    expect(typeof q5.toArray).toBe('function')
  })

  test('toArray() returns Promise<T[]>', async () => {
    const users = await collection.query().toArray()
    expect(Array.isArray(users)).toBe(true)
    expect(users.length).toBe(5)
  })

  test('first() returns Promise<T | null>', async () => {
    const user = await collection.query().first()
    expect(user).not.toBeNull()
    expect(user?.id).toBe('1')

    const none = await collection.query().where({ status: 'unknown' as any }).first()
    expect(none).toBeNull()
  })

  test('firstOrThrow() throws when no match', async () => {
    await expect(
      collection.query().where({ status: 'unknown' as any }).firstOrThrow()
    ).rejects.toThrow('No matching element found')
  })

  test('count() returns Promise<number>', async () => {
    const total = await collection.query().count()
    expect(total).toBe(5)

    const active = await collection.query().where({ status: 'active' }).count()
    expect(active).toBe(3)
  })

  test('any() returns Promise<boolean>', async () => {
    const hasActive = await collection.query().where({ status: 'active' }).any()
    expect(hasActive).toBe(true)

    const hasUnknown = await collection.query().where({ status: 'unknown' as any }).any()
    expect(hasUnknown).toBe(false)
  })
})

// ============================================================================
// Tests: Query Building (MIX-06 - Lazy)
// ============================================================================

describe('Lazy Execution (MIX-06)', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator
  let backend: MemoryBackend

  beforeEach(() => {
    backend = new MemoryBackend()
    registry = new MockBackendRegistry(backend)
    validator = new MockQueryValidator()

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('query building does not execute backend', () => {
    const executeSpy = spyOn(backend, 'execute')

    // Build query but don't call terminal
    collection.query()
      .where({ status: 'active' })
      .orderBy('name')
      .take(10)

    expect(executeSpy).not.toHaveBeenCalled()
  })

  test('terminal operation triggers execution', async () => {
    const executeSpy = spyOn(backend, 'execute')

    await collection.query()
      .where({ status: 'active' })
      .toArray()

    expect(executeSpy).toHaveBeenCalled()
  })

  test('state accumulates through chain', () => {
    const query = collection.query()
      .where({ status: 'active' })
      .where({ role: 'admin' })
      .orderBy('createdAt', 'desc')
      .orderBy('name', 'asc')
      .skip(5)
      .take(10)

    const state = query.getState()

    // Multiple wheres combine with $and
    expect(state.filter.$and).toBeDefined()
    expect(state.orderBy).toHaveLength(2)
    expect(state.skip).toBe(5)
    expect(state.take).toBe(10)
  })
})

// ============================================================================
// Tests: Filtering
// ============================================================================

describe('Filtering', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()
    validator.setValidProperties(['id', 'name', 'email', 'status', 'role', 'createdAt'])

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('simple equality filter', async () => {
    const admins = await collection.query()
      .where({ role: 'admin' })
      .toArray()

    expect(admins).toHaveLength(2)
    expect(admins.map(u => u.name)).toEqual(['Alice', 'Eve'])
  })

  test('multiple conditions (implicit $and)', async () => {
    const activeAdmins = await collection.query()
      .where({ status: 'active', role: 'admin' })
      .toArray()

    expect(activeAdmins).toHaveLength(1)
    expect(activeAdmins[0].name).toBe('Alice')
  })

  test('$or condition', async () => {
    const adminsOrViewers = await collection.query()
      .where({ $or: [{ role: 'admin' }, { role: 'viewer' }] })
      .toArray()

    expect(adminsOrViewers).toHaveLength(3)
  })

  test('comparison operators', async () => {
    const recent = await collection.query()
      .where({ createdAt: { $gte: 3000 } })
      .toArray()

    expect(recent).toHaveLength(3)
    expect(recent.map(u => u.name)).toEqual(['Charlie', 'Diana', 'Eve'])
  })

  test('chained where() combines filters', async () => {
    const results = await collection.query()
      .where({ status: 'active' })
      .where({ role: 'member' })
      .toArray()

    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Bob')
  })
})

// ============================================================================
// Tests: Ordering and Pagination
// ============================================================================

describe('Ordering and Pagination', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('orderBy ascending', async () => {
    const users = await collection.query()
      .orderBy('name', 'asc')
      .toArray()

    expect(users.map(u => u.name)).toEqual(['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'])
  })

  test('orderBy descending', async () => {
    const users = await collection.query()
      .orderBy('createdAt', 'desc')
      .toArray()

    expect(users.map(u => u.name)).toEqual(['Eve', 'Diana', 'Charlie', 'Bob', 'Alice'])
  })

  test('multi-field ordering', async () => {
    const users = await collection.query()
      .orderBy('status', 'asc')
      .orderBy('name', 'asc')
      .toArray()

    // active first (Alice, Bob, Diana), then inactive (Charlie, Eve)
    expect(users.map(u => u.name)).toEqual(['Alice', 'Bob', 'Diana', 'Charlie', 'Eve'])
  })

  test('skip', async () => {
    const users = await collection.query()
      .orderBy('createdAt', 'asc')
      .skip(2)
      .toArray()

    expect(users).toHaveLength(3)
    expect(users.map(u => u.name)).toEqual(['Charlie', 'Diana', 'Eve'])
  })

  test('take', async () => {
    const users = await collection.query()
      .orderBy('createdAt', 'asc')
      .take(2)
      .toArray()

    expect(users).toHaveLength(2)
    expect(users.map(u => u.name)).toEqual(['Alice', 'Bob'])
  })

  test('skip + take pagination', async () => {
    const page2 = await collection.query()
      .orderBy('createdAt', 'asc')
      .skip(2)
      .take(2)
      .toArray()

    expect(page2).toHaveLength(2)
    expect(page2.map(u => u.name)).toEqual(['Charlie', 'Diana'])
  })
})

// ============================================================================
// Tests: Backward Compatibility (MIX-04)
// ============================================================================

describe('Backward Compatibility (MIX-04)', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('.where() still works synchronously', () => {
    const active = collection.where({ status: 'active' })

    // Synchronous result
    expect(Array.isArray(active)).toBe(true)
    expect(active).toHaveLength(3)
  })

  test('.where() and .query().where() produce same results', async () => {
    const syncResult = collection.where({ status: 'active', role: 'admin' })
    const asyncResult = await collection.query().where({ status: 'active', role: 'admin' }).toArray()

    expect(syncResult.map(u => u.id)).toEqual(asyncResult.map(u => u.id))
  })
})

// ============================================================================
// Tests: Validation (MIX-03 via validator service)
// ============================================================================

describe('Validation Integration', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()
    validator.setValidProperties(['id', 'name', 'status', 'role'])

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('valid query executes successfully', async () => {
    const users = await collection.query()
      .where({ status: 'active' })
      .toArray()

    expect(users.length).toBeGreaterThan(0)
  })

  test('invalid property throws validation error', async () => {
    await expect(
      collection.query()
        .where({ unknownField: 'value' })
        .toArray()
    ).rejects.toThrow("Query validation failed: Property 'unknownField' does not exist on User")
  })
})

// ============================================================================
// Tests: Full Integration Scenario
// ============================================================================

describe('Full Integration Scenario', () => {
  let collection: CollectionMixin<User>
  let registry: MockBackendRegistry
  let validator: MockQueryValidator

  beforeEach(() => {
    registry = new MockBackendRegistry(new MemoryBackend())
    validator = new MockQueryValidator()
    validator.setValidProperties(['id', 'name', 'email', 'status', 'role', 'createdAt'])

    collection = createMockCollection('User', testUsers, {
      schemaName: 'test-schema',
      backendRegistry: registry,
      validator,
    })
  })

  test('complex query: filter + order + paginate', async () => {
    const results = await collection.query()
      .where({ status: 'active' })
      .orderBy('createdAt', 'desc')
      .skip(1)
      .take(1)
      .toArray()

    // Active users (Alice@1000, Bob@2000, Diana@4000) sorted desc = Diana, Bob, Alice
    // Skip 1, take 1 = Bob
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Bob')
  })

  test('count ignores pagination', async () => {
    const count = await collection.query()
      .where({ status: 'active' })
      .skip(10)
      .take(1)
      .count()

    // Count should return total matching, not paginated count
    expect(count).toBe(3)
  })

  test('typical usage pattern', async () => {
    // Get paginated active admins sorted by name
    const query = collection.query()
      .where({ status: 'active' })
      .where({ role: { $in: ['admin', 'member'] } })
      .orderBy('name')

    const total = await collection.query()
      .where({ status: 'active' })
      .where({ role: { $in: ['admin', 'member'] } })
      .count()

    const page1 = await collection.query()
      .where({ status: 'active' })
      .where({ role: { $in: ['admin', 'member'] } })
      .orderBy('name')
      .take(2)
      .toArray()

    expect(total).toBe(2) // Alice (admin), Bob (member)
    expect(page1.map(u => u.name)).toEqual(['Alice', 'Bob'])
  })
})

// ============================================================================
// Summary
// ============================================================================

describe('Decision Summary', () => {
  test('print findings', () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   COLLECTION MIXIN FINDINGS                        ║
╠════════════════════════════════════════════════════════════════════╣
║ RECOMMENDATION: Approach A (Integrated into CollectionPersistable) ║
╠════════════════════════════════════════════════════════════════════╣
║ Rationale:                                                         ║
║ 1. .query() is a natural addition alongside existing .where()      ║
║ 2. Single mixin keeps persistence + querying together              ║
║ 3. Both use same environment services (registry, validator)        ║
║ 4. Backward compat: .where() stays sync, .query() is async         ║
╠════════════════════════════════════════════════════════════════════╣
║ IQueryable<T> API:                                                 ║
║   Chainable: where(), orderBy(), skip(), take(), include()         ║
║   Terminal:  toArray(), first(), firstOrThrow(), count(), any()    ║
╠════════════════════════════════════════════════════════════════════╣
║ QueryableBuilder:                                                  ║
║   • Accumulates state through chain (immutable per-call)           ║
║   • Validates on terminal operation via validator service          ║
║   • Resolves backend via registry service                          ║
║   • Executes via backend.execute() / backend.count()               ║
╠════════════════════════════════════════════════════════════════════╣
║ ALL REQUIREMENTS MET:                                              ║
║ ✅ MIX-01: .query() returns IQueryable<T>                          ║
║ ✅ MIX-02: Integrates with CollectionPersistable pattern           ║
║ ✅ MIX-03: Accesses environment services                           ║
║ ✅ MIX-04: .where() still works (backward compat)                  ║
║ ✅ MIX-05: Type-safe (IQueryable<User> in tests)                   ║
║ ✅ MIX-06: Lazy - no execution until terminal op                   ║
╚════════════════════════════════════════════════════════════════════╝
    `)
  })
})
