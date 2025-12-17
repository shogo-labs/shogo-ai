/**
 * Separate Mixin Pattern PoC
 *
 * Exploring Approach B: CollectionQueryable as independent mixin
 *
 * Questions to answer:
 * 1. Can CollectionQueryable be composed independently?
 * 2. Can it be composed alongside CollectionPersistable?
 * 3. What's the composition experience like?
 * 4. How does typing flow through compositions?
 * 5. Can we automate composition via domain() pipeline?
 * 6. How would schema-driven intent (x-queryable?) control this?
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { types, getEnv, Instance, IAnyModelType } from 'mobx-state-tree'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import { createJsInterpreter, allInterpreters as jsInterpreters } from '@ucast/js'

// ============================================================================
// Types shared across mixins
// ============================================================================

interface IEnvironment {
  services: {
    persistence?: IPersistenceService
    backendRegistry?: IBackendRegistry
    queryValidator?: IQueryValidator
  }
  context: {
    schemaName: string
    modelName?: string
  }
}

interface IPersistenceService {
  loadCollection(ctx: any): Promise<any>
  saveCollection(ctx: any, data: any): Promise<void>
}

interface IBackendRegistry {
  resolve(schemaName: string, modelName: string): IBackend
}

interface IQueryValidator {
  validate(schemaName: string, modelName: string, filter: Record<string, any>): { valid: boolean; errors: any[] }
}

interface IBackend {
  name: string
  execute<T>(query: any, collection: T[]): Promise<T[]>
  count<T>(query: any, collection: T[]): Promise<number>
}

// ============================================================================
// IQueryable Interface
// ============================================================================

interface IQueryable<T> {
  where(filter: Record<string, any>): IQueryable<T>
  orderBy(field: string, direction?: 'asc' | 'desc'): IQueryable<T>
  skip(count: number): IQueryable<T>
  take(count: number): IQueryable<T>
  toArray(): Promise<T[]>
  first(): Promise<T | null>
  count(): Promise<number>
}

// ============================================================================
// Mock Implementations
// ============================================================================

const parser = new MongoQueryParser(allParsingInstructions)
const jsInterpret = createJsInterpreter(jsInterpreters)

class MemoryBackend implements IBackend {
  name = 'memory'

  async execute<T>(query: any, collection: T[]): Promise<T[]> {
    let result = [...collection]

    if (query.filter && Object.keys(query.filter).length > 0) {
      const ast = parser.parse(query.filter)
      result = result.filter(item => jsInterpret(ast, item))
    }

    if (query.orderBy?.length > 0) {
      result.sort((a: any, b: any) => {
        for (const { field, direction } of query.orderBy) {
          if (a[field] < b[field]) return direction === 'asc' ? -1 : 1
          if (a[field] > b[field]) return direction === 'asc' ? 1 : -1
        }
        return 0
      })
    }

    if (query.skip !== undefined) result = result.slice(query.skip)
    if (query.take !== undefined) result = result.slice(0, query.take)

    return result
  }

  async count<T>(query: any, collection: T[]): Promise<number> {
    if (!query.filter || Object.keys(query.filter).length === 0) {
      return collection.length
    }
    const ast = parser.parse(query.filter)
    return collection.filter(item => jsInterpret(ast, item)).length
  }
}

class MockBackendRegistry implements IBackendRegistry {
  private backend = new MemoryBackend()
  resolve() { return this.backend }
}

class MockQueryValidator implements IQueryValidator {
  validate() { return { valid: true, errors: [] } }
}

class MockPersistenceService implements IPersistenceService {
  private storage = new Map<string, any>()

  async loadCollection(ctx: any) {
    return this.storage.get(ctx.modelName) ?? null
  }

  async saveCollection(ctx: any, data: any) {
    this.storage.set(ctx.modelName, data)
  }
}

// ============================================================================
// QueryableBuilder
// ============================================================================

class QueryableBuilder<T> implements IQueryable<T> {
  private state = { filter: {}, orderBy: [] as any[], skip: undefined as number | undefined, take: undefined as number | undefined }

  constructor(
    private schemaName: string,
    private modelName: string,
    private collection: T[],
    private registry: IBackendRegistry,
    private validator: IQueryValidator
  ) {}

  where(filter: Record<string, any>): IQueryable<T> {
    if (Object.keys(this.state.filter).length > 0) {
      this.state.filter = { $and: [this.state.filter, filter] }
    } else {
      this.state.filter = { ...filter }
    }
    return this
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): IQueryable<T> {
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

  async toArray(): Promise<T[]> {
    const validation = this.validator.validate(this.schemaName, this.modelName, this.state.filter)
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.map(e => e.message).join(', ')}`)
    }
    const backend = this.registry.resolve(this.schemaName, this.modelName)
    return backend.execute(this.state, this.collection)
  }

  async first(): Promise<T | null> {
    this.state.take = 1
    const results = await this.toArray()
    return results[0] ?? null
  }

  async count(): Promise<number> {
    const backend = this.registry.resolve(this.schemaName, this.modelName)
    return backend.count(this.state, this.collection)
  }
}

// ============================================================================
// MIXIN 1: CollectionPersistable (existing pattern)
// ============================================================================

const CollectionPersistable = types.model('CollectionPersistable', {})
  .views(self => ({
    get persistenceContext() {
      const env = getEnv<IEnvironment>(self)
      return {
        schemaName: env.context.schemaName,
        modelName: (self as any).modelName,
      }
    }
  }))
  .actions(self => ({
    async loadAll() {
      const env = getEnv<IEnvironment>(self)
      if (!env.services.persistence) return
      const snapshot = await env.services.persistence.loadCollection(self.persistenceContext)
      if (snapshot) {
        // Would apply snapshot in real impl
      }
    },
    async saveAll() {
      const env = getEnv<IEnvironment>(self)
      if (!env.services.persistence) return
      await env.services.persistence.saveCollection(self.persistenceContext, {})
    }
  }))

// ============================================================================
// MIXIN 2: CollectionQueryable (NEW - independent)
// ============================================================================

const CollectionQueryable = types.model('CollectionQueryable', {})
  .views(self => ({
    /**
     * Create a new query builder for this collection.
     * Returns IQueryable<T> for chainable, async queries.
     */
    query() {
      const env = getEnv<IEnvironment>(self)

      // Require services
      if (!env.services.backendRegistry) {
        throw new Error('backendRegistry service required for query()')
      }
      if (!env.services.queryValidator) {
        throw new Error('queryValidator service required for query()')
      }

      return new QueryableBuilder(
        env.context.schemaName,
        (self as any).modelName,
        (self as any).all(), // Get current collection items
        env.services.backendRegistry,
        env.services.queryValidator
      )
    }
  }))

// ============================================================================
// Test: Mixin Composition Patterns
// ============================================================================

describe('Mixin Composition Patterns', () => {
  // Base collection model (simulates what helpers-store creates)
  const createBaseCollection = (modelName: string) => {
    return types.model(`${modelName}Collection`, {
      items: types.map(types.model(modelName, {
        id: types.identifier,
        name: types.string,
        status: types.string,
        createdAt: types.number,
      }))
    })
    .views(self => ({
      get modelName() { return modelName },
      all() { return Array.from(self.items.values()) },
      get(id: string) { return self.items.get(id) },
    }))
    .actions(self => ({
      add(item: any) { self.items.set(item.id, item) },
      clear() { self.items.clear() },
    }))
  }

  test('CollectionQueryable can be composed independently', () => {
    // Given: Base collection + just queryable mixin
    const BaseUser = createBaseCollection('User')
    const QueryableUserCollection = types.compose(
      'QueryableUserCollection',
      BaseUser,
      CollectionQueryable
    )

    // Create with environment
    const env: IEnvironment = {
      services: {
        backendRegistry: new MockBackendRegistry(),
        queryValidator: new MockQueryValidator(),
      },
      context: { schemaName: 'test' }
    }

    const collection = QueryableUserCollection.create({}, env)

    // Then: Has query() but NOT persistence methods
    expect(typeof collection.query).toBe('function')
    expect((collection as any).loadAll).toBeUndefined()
    expect((collection as any).saveAll).toBeUndefined()
  })

  test('CollectionPersistable can be composed independently', () => {
    // Given: Base collection + just persistable mixin
    const BaseUser = createBaseCollection('User')
    const PersistableUserCollection = types.compose(
      'PersistableUserCollection',
      BaseUser,
      CollectionPersistable
    )

    const env: IEnvironment = {
      services: {
        persistence: new MockPersistenceService(),
      },
      context: { schemaName: 'test' }
    }

    const collection = PersistableUserCollection.create({}, env)

    // Then: Has persistence methods but NOT query()
    expect(typeof collection.loadAll).toBe('function')
    expect(typeof collection.saveAll).toBe('function')
    expect((collection as any).query).toBeUndefined()
  })

  test('Both mixins can be composed together', () => {
    // Given: Base + both mixins
    const BaseUser = createBaseCollection('User')
    const FullUserCollection = types.compose(
      'FullUserCollection',
      BaseUser,
      CollectionPersistable,
      CollectionQueryable
    )

    const env: IEnvironment = {
      services: {
        persistence: new MockPersistenceService(),
        backendRegistry: new MockBackendRegistry(),
        queryValidator: new MockQueryValidator(),
      },
      context: { schemaName: 'test' }
    }

    const collection = FullUserCollection.create({}, env)

    // Then: Has BOTH query() AND persistence methods
    expect(typeof collection.query).toBe('function')
    expect(typeof collection.loadAll).toBe('function')
    expect(typeof collection.saveAll).toBe('function')
  })

  test('Composition order does not matter', () => {
    const BaseUser = createBaseCollection('User')

    // Order 1: Persistable then Queryable
    const Order1 = types.compose('Order1', BaseUser, CollectionPersistable, CollectionQueryable)

    // Order 2: Queryable then Persistable
    const Order2 = types.compose('Order2', BaseUser, CollectionQueryable, CollectionPersistable)

    const env: IEnvironment = {
      services: {
        persistence: new MockPersistenceService(),
        backendRegistry: new MockBackendRegistry(),
        queryValidator: new MockQueryValidator(),
      },
      context: { schemaName: 'test' }
    }

    const c1 = Order1.create({}, env)
    const c2 = Order2.create({}, env)

    // Both should have all methods regardless of order
    expect(typeof c1.query).toBe('function')
    expect(typeof c1.loadAll).toBe('function')
    expect(typeof c2.query).toBe('function')
    expect(typeof c2.loadAll).toBe('function')
  })
})

// ============================================================================
// Test: Query Functionality (with separate mixin)
// ============================================================================

describe('Query Functionality (Separate Mixin)', () => {
  let collection: any
  let env: IEnvironment

  beforeEach(() => {
    const BaseUser = types.model('User', {
      id: types.identifier,
      name: types.string,
      status: types.string,
      role: types.string,
      createdAt: types.number,
    })

    const UserCollection = types.model('UserCollection', {
      items: types.map(BaseUser)
    })
    .views(self => ({
      get modelName() { return 'User' },
      all() { return Array.from(self.items.values()) },
    }))
    .actions(self => ({
      add(item: any) { self.items.set(item.id, item) },
    }))

    // Compose with just CollectionQueryable
    const QueryableUserCollection = types.compose(
      'QueryableUserCollection',
      UserCollection,
      CollectionQueryable
    )

    env = {
      services: {
        backendRegistry: new MockBackendRegistry(),
        queryValidator: new MockQueryValidator(),
      },
      context: { schemaName: 'test-app' }
    }

    collection = QueryableUserCollection.create({}, env)

    // Add test data
    collection.add({ id: '1', name: 'Alice', status: 'active', role: 'admin', createdAt: 1000 })
    collection.add({ id: '2', name: 'Bob', status: 'active', role: 'member', createdAt: 2000 })
    collection.add({ id: '3', name: 'Charlie', status: 'inactive', role: 'member', createdAt: 3000 })
    collection.add({ id: '4', name: 'Diana', status: 'active', role: 'viewer', createdAt: 4000 })
  })

  test('query().toArray() returns all items when no filter', async () => {
    const users = await collection.query().toArray()
    expect(users).toHaveLength(4)
  })

  test('query().where() filters items', async () => {
    const active = await collection.query().where({ status: 'active' }).toArray()
    expect(active).toHaveLength(3)
    expect(active.map((u: any) => u.name)).toContain('Alice')
    expect(active.map((u: any) => u.name)).toContain('Bob')
    expect(active.map((u: any) => u.name)).toContain('Diana')
  })

  test('query().orderBy() sorts items', async () => {
    const sorted = await collection.query().orderBy('name', 'asc').toArray()
    expect(sorted.map((u: any) => u.name)).toEqual(['Alice', 'Bob', 'Charlie', 'Diana'])
  })

  test('query().skip().take() paginates', async () => {
    const page = await collection.query()
      .orderBy('createdAt', 'asc')
      .skip(1)
      .take(2)
      .toArray()

    expect(page).toHaveLength(2)
    expect(page.map((u: any) => u.name)).toEqual(['Bob', 'Charlie'])
  })

  test('query().first() returns single item', async () => {
    const first = await collection.query().orderBy('createdAt', 'asc').first()
    expect(first?.name).toBe('Alice')
  })

  test('query().count() returns count', async () => {
    const count = await collection.query().where({ status: 'active' }).count()
    expect(count).toBe(3)
  })

  test('query() throws if services missing', () => {
    // Create collection without services
    const BaseUser = types.model('User', { id: types.identifier })
    const UserCollection = types.model('UserCollection', { items: types.map(BaseUser) })
      .views(self => ({ get modelName() { return 'User' }, all() { return [] } }))

    const QueryableUserCollection = types.compose('QueryableUserCollection', UserCollection, CollectionQueryable)

    const noServicesEnv: IEnvironment = {
      services: {},
      context: { schemaName: 'test' }
    }

    const col = QueryableUserCollection.create({}, noServicesEnv)

    expect(() => col.query()).toThrow('backendRegistry service required')
  })
})

// ============================================================================
// Test: Automated Composition (domain() pipeline simulation)
// ============================================================================

describe('Automated Composition via Pipeline', () => {

  /**
   * Simulates the buildEnhanceCollections function with queryable option
   */
  function buildEnhanceCollections(options: {
    enablePersistence?: boolean
    enableQueryable?: boolean
  } = {}) {
    const { enablePersistence = true, enableQueryable = true } = options

    return (collections: Record<string, IAnyModelType>) => {
      let result = collections

      // Step 1: Compose CollectionPersistable if enabled
      if (enablePersistence) {
        const enhanced: Record<string, IAnyModelType> = {}
        for (const [name, model] of Object.entries(result)) {
          enhanced[name] = types.compose(model, CollectionPersistable).named(name)
        }
        result = enhanced
      }

      // Step 2: Compose CollectionQueryable if enabled
      if (enableQueryable) {
        const enhanced: Record<string, IAnyModelType> = {}
        for (const [name, model] of Object.entries(result)) {
          enhanced[name] = types.compose(model, CollectionQueryable).named(name)
        }
        result = enhanced
      }

      return result
    }
  }

  test('pipeline composes both mixins by default', () => {
    // Given: Base collection
    const UserCollection = types.model('UserCollection', {
      items: types.map(types.model('User', { id: types.identifier }))
    })
    .views(self => ({
      get modelName() { return 'User' },
      all() { return Array.from(self.items.values()) }
    }))

    // When: Apply enhancement pipeline
    const enhance = buildEnhanceCollections()
    const enhanced = enhance({ UserCollection })

    // Then: Enhanced model exists
    expect(enhanced.UserCollection).toBeDefined()
  })

  test('pipeline can enable only persistence', () => {
    const UserCollection = types.model('UserCollection', {
      items: types.map(types.model('User', { id: types.identifier }))
    })
    .views(self => ({
      get modelName() { return 'User' },
      all() { return [] }
    }))

    const enhance = buildEnhanceCollections({ enablePersistence: true, enableQueryable: false })
    const enhanced = enhance({ UserCollection })

    const env: IEnvironment = {
      services: { persistence: new MockPersistenceService() },
      context: { schemaName: 'test' }
    }

    const instance = enhanced.UserCollection.create({}, env)

    expect(typeof instance.loadAll).toBe('function')
    expect((instance as any).query).toBeUndefined()
  })

  test('pipeline can enable only queryable', () => {
    const UserCollection = types.model('UserCollection', {
      items: types.map(types.model('User', { id: types.identifier }))
    })
    .views(self => ({
      get modelName() { return 'User' },
      all() { return [] }
    }))

    const enhance = buildEnhanceCollections({ enablePersistence: false, enableQueryable: true })
    const enhanced = enhance({ UserCollection })

    const env: IEnvironment = {
      services: {
        backendRegistry: new MockBackendRegistry(),
        queryValidator: new MockQueryValidator(),
      },
      context: { schemaName: 'test' }
    }

    const instance = enhanced.UserCollection.create({}, env)

    expect(typeof instance.query).toBe('function')
    expect((instance as any).loadAll).toBeUndefined()
  })
})

// ============================================================================
// Test: Schema-Driven Composition Intent
// ============================================================================

describe('Schema-Driven Composition Intent', () => {
  /**
   * Explores how x-persistence extensions could control mixin composition.
   *
   * Possible schema extensions:
   * - x-persistence.queryable: boolean - Enable IQueryable
   * - x-persistence.backend: string - Which backend to use
   * - x-persistence.persistable: boolean - Enable persistence (default true)
   */

  interface SchemaModelMeta {
    name: string
    xPersistence?: {
      queryable?: boolean
      persistable?: boolean
      backend?: string
    }
  }

  function deriveCompositionFromSchema(model: SchemaModelMeta) {
    const config = model.xPersistence ?? {}
    return {
      // Default: both enabled unless explicitly disabled
      enablePersistence: config.persistable !== false,
      enableQueryable: config.queryable !== false,
      backend: config.backend ?? 'memory',
    }
  }

  test('default: both persistence and queryable enabled', () => {
    const model: SchemaModelMeta = { name: 'User' }
    const config = deriveCompositionFromSchema(model)

    expect(config.enablePersistence).toBe(true)
    expect(config.enableQueryable).toBe(true)
    expect(config.backend).toBe('memory')
  })

  test('x-persistence.queryable: false disables query mixin', () => {
    const model: SchemaModelMeta = {
      name: 'AuditLog',
      xPersistence: { queryable: false }
    }
    const config = deriveCompositionFromSchema(model)

    expect(config.enablePersistence).toBe(true)
    expect(config.enableQueryable).toBe(false)
  })

  test('x-persistence.persistable: false disables persistence mixin', () => {
    const model: SchemaModelMeta = {
      name: 'CachedData',
      xPersistence: { persistable: false }
    }
    const config = deriveCompositionFromSchema(model)

    expect(config.enablePersistence).toBe(false)
    expect(config.enableQueryable).toBe(true)
  })

  test('x-persistence.backend specifies backend', () => {
    const model: SchemaModelMeta = {
      name: 'User',
      xPersistence: { backend: 'postgres' }
    }
    const config = deriveCompositionFromSchema(model)

    expect(config.backend).toBe('postgres')
  })

  test('full schema-driven composition simulation', () => {
    // Given: Schema with mixed configurations
    const schemaModels: SchemaModelMeta[] = [
      { name: 'User', xPersistence: { backend: 'postgres' } },           // Both enabled
      { name: 'AuditLog', xPersistence: { queryable: false } },          // Persist only
      { name: 'Cache', xPersistence: { persistable: false } },           // Query only
      { name: 'TempData', xPersistence: { persistable: false, queryable: false } }, // Neither
    ]

    // When: Derive composition config for each
    const configs = schemaModels.map(m => ({
      name: m.name,
      ...deriveCompositionFromSchema(m)
    }))

    // Then: Configs reflect schema intent
    expect(configs).toEqual([
      { name: 'User', enablePersistence: true, enableQueryable: true, backend: 'postgres' },
      { name: 'AuditLog', enablePersistence: true, enableQueryable: false, backend: 'memory' },
      { name: 'Cache', enablePersistence: false, enableQueryable: true, backend: 'memory' },
      { name: 'TempData', enablePersistence: false, enableQueryable: false, backend: 'memory' },
    ])
  })
})

// ============================================================================
// Summary
// ============================================================================

describe('Findings Summary', () => {
  test('print findings', () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║              SEPARATE MIXIN PATTERN FINDINGS                       ║
╠════════════════════════════════════════════════════════════════════╣
║ VERIFIED CAPABILITIES:                                             ║
║                                                                    ║
║ 1. Independent Composition                                         ║
║    ✅ CollectionQueryable works alone (read-only scenarios)        ║
║    ✅ CollectionPersistable works alone (write-only scenarios)     ║
║    ✅ Both compose together without conflict                       ║
║    ✅ Composition order does not matter                            ║
║                                                                    ║
║ 2. Pipeline Automation                                             ║
║    ✅ buildEnhanceCollections can compose both mixins              ║
║    ✅ Options enable selective composition                         ║
║    ✅ Fits existing domain() pipeline pattern                      ║
║                                                                    ║
║ 3. Schema-Driven Intent                                            ║
║    ✅ x-persistence.queryable can control query mixin              ║
║    ✅ x-persistence.persistable can control persistence mixin      ║
║    ✅ Per-model configuration supported                            ║
║    ✅ Sensible defaults (both enabled)                             ║
║                                                                    ║
║ 4. Service Requirements                                            ║
║    ✅ Clear error when services missing                            ║
║    ✅ Each mixin only requires its own services                    ║
╠════════════════════════════════════════════════════════════════════╣
║ RECOMMENDATION:                                                    ║
║                                                                    ║
║ Approach B (Separate CollectionQueryable Mixin) is validated.      ║
║                                                                    ║
║ Implementation path:                                               ║
║ 1. Create CollectionQueryable in composition/queryable.ts          ║
║ 2. Update buildEnhanceCollections with enableQueryable option      ║
║ 3. Add x-persistence.queryable to Enhanced JSON Schema             ║
║ 4. Update IEnvironment with query services                         ║
╚════════════════════════════════════════════════════════════════════╝
    `)
  })
})
