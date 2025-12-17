/**
 * Backend Registry PoC
 *
 * Testing registry patterns for backend resolution:
 * - REG-01: Register backends by name at startup
 * - REG-02: Resolve backend from model's x-persistence.backend
 * - REG-03: Fall back to schema's x-persistence.backend
 * - REG-04: Fall back to default backend (memory)
 * - REG-05: Throw clear error if backend not registered
 * - REG-06: Integrate with MST environment DI pattern
 */

import { describe, test, expect, beforeEach } from 'bun:test'

// ============================================================================
// Types - IBackend interface (minimal for registry testing)
// ============================================================================

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
  execute<T>(query: any, collection: T[]): Promise<T[]>
}

// ============================================================================
// Types - Registry interface
// ============================================================================

interface IBackendRegistry {
  register(backend: IBackend): void
  get(name: string): IBackend
  has(name: string): boolean
  resolve(schemaName: string, modelName: string): IBackend
  setDefault(name: string): void
  getDefault(): IBackend
}

// ============================================================================
// Types - Mock meta-store for resolution
// ============================================================================

interface XPersistence {
  backend?: string
  table?: string
}

interface ModelMeta {
  name: string
  xPersistence?: XPersistence
}

interface SchemaMeta {
  name: string
  xPersistence?: XPersistence
  models: Map<string, ModelMeta>
}

// ============================================================================
// Mock Backends
// ============================================================================

function createMockBackend(name: string, operators: string[] = []): IBackend {
  return {
    name,
    capabilities: {
      operators: new Set(operators),
      orderBy: true,
      pagination: true,
      count: true,
      exists: true,
    },
    execute: async <T>(query: any, collection: T[]) => collection,
  }
}

const memoryBackend = createMockBackend('memory', [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains',
  'and', 'or', 'not',
])

const postgresBackend = createMockBackend('postgres', [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains',
  'and', 'or', 'not',
])

const sqliteBackend = createMockBackend('sqlite', [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
  'and', 'or', 'not',
])

// ============================================================================
// Implementation: Backend Registry
// ============================================================================

class BackendRegistry implements IBackendRegistry {
  private backends = new Map<string, IBackend>()
  private defaultBackendName: string = 'memory'
  private schemaMetaStore: Map<string, SchemaMeta>

  constructor(schemaMetaStore: Map<string, SchemaMeta>) {
    this.schemaMetaStore = schemaMetaStore
  }

  register(backend: IBackend): void {
    if (this.backends.has(backend.name)) {
      console.warn(`Backend '${backend.name}' already registered, overwriting`)
    }
    this.backends.set(backend.name, backend)
  }

  get(name: string): IBackend {
    const backend = this.backends.get(name)
    if (!backend) {
      const available = Array.from(this.backends.keys()).join(', ')
      throw new Error(
        `Backend '${name}' not registered. Available backends: ${available || 'none'}`
      )
    }
    return backend
  }

  has(name: string): boolean {
    return this.backends.has(name)
  }

  setDefault(name: string): void {
    if (!this.backends.has(name)) {
      throw new Error(`Cannot set default to unregistered backend '${name}'`)
    }
    this.defaultBackendName = name
  }

  getDefault(): IBackend {
    return this.get(this.defaultBackendName)
  }

  /**
   * Resolution cascade:
   * 1. Model's x-persistence.backend
   * 2. Schema's x-persistence.backend
   * 3. Registry default
   */
  resolve(schemaName: string, modelName: string): IBackend {
    const schema = this.schemaMetaStore.get(schemaName)

    if (schema) {
      // 1. Check model's x-persistence.backend
      const model = schema.models.get(modelName)
      if (model?.xPersistence?.backend) {
        return this.get(model.xPersistence.backend)
      }

      // 2. Check schema's x-persistence.backend
      if (schema.xPersistence?.backend) {
        return this.get(schema.xPersistence.backend)
      }
    }

    // 3. Fall back to default
    return this.getDefault()
  }

  /** Get registered backend names for debugging */
  list(): string[] {
    return Array.from(this.backends.keys())
  }
}

// ============================================================================
// Test: Registration (REG-01)
// ============================================================================

describe('Backend Registration (REG-01)', () => {
  let registry: BackendRegistry
  let metaStore: Map<string, SchemaMeta>

  beforeEach(() => {
    metaStore = new Map()
    registry = new BackendRegistry(metaStore)
  })

  test('register backend by name', () => {
    registry.register(memoryBackend)
    expect(registry.has('memory')).toBe(true)
    expect(registry.get('memory')).toBe(memoryBackend)
  })

  test('register multiple backends', () => {
    registry.register(memoryBackend)
    registry.register(postgresBackend)
    registry.register(sqliteBackend)

    expect(registry.list()).toEqual(['memory', 'postgres', 'sqlite'])
  })

  test('overwrite existing backend with warning', () => {
    const backend1 = createMockBackend('memory')
    const backend2 = createMockBackend('memory')

    registry.register(backend1)
    registry.register(backend2)

    expect(registry.get('memory')).toBe(backend2)
  })
})

// ============================================================================
// Test: Error Handling (REG-05)
// ============================================================================

describe('Error Handling (REG-05)', () => {
  let registry: BackendRegistry
  let metaStore: Map<string, SchemaMeta>

  beforeEach(() => {
    metaStore = new Map()
    registry = new BackendRegistry(metaStore)
    registry.register(memoryBackend)
  })

  test('throw on unregistered backend', () => {
    expect(() => registry.get('postgres')).toThrow(
      "Backend 'postgres' not registered. Available backends: memory"
    )
  })

  test('error message lists available backends', () => {
    registry.register(postgresBackend)

    expect(() => registry.get('mysql')).toThrow(
      "Backend 'mysql' not registered. Available backends: memory, postgres"
    )
  })

  test('throw on setting unregistered default', () => {
    expect(() => registry.setDefault('postgres')).toThrow(
      "Cannot set default to unregistered backend 'postgres'"
    )
  })
})

// ============================================================================
// Test: Resolution Cascade (REG-02, REG-03, REG-04)
// ============================================================================

describe('Resolution Cascade', () => {
  let registry: BackendRegistry
  let metaStore: Map<string, SchemaMeta>

  beforeEach(() => {
    metaStore = new Map()
    registry = new BackendRegistry(metaStore)
    registry.register(memoryBackend)
    registry.register(postgresBackend)
    registry.register(sqliteBackend)
  })

  test('REG-04: fall back to default when no config', () => {
    // No schema in meta-store
    const backend = registry.resolve('unknown-schema', 'UnknownModel')
    expect(backend.name).toBe('memory') // default
  })

  test('REG-03: resolve from schema x-persistence.backend', () => {
    metaStore.set('my-schema', {
      name: 'my-schema',
      xPersistence: { backend: 'postgres' },
      models: new Map([
        ['User', { name: 'User' }], // No model-level override
        ['Task', { name: 'Task' }],
      ]),
    })

    expect(registry.resolve('my-schema', 'User').name).toBe('postgres')
    expect(registry.resolve('my-schema', 'Task').name).toBe('postgres')
  })

  test('REG-02: resolve from model x-persistence.backend', () => {
    metaStore.set('my-schema', {
      name: 'my-schema',
      xPersistence: { backend: 'postgres' }, // Schema default
      models: new Map([
        ['User', { name: 'User' }], // No override → postgres
        ['AuditLog', {
          name: 'AuditLog',
          xPersistence: { backend: 'sqlite' }, // Model override
        }],
      ]),
    })

    expect(registry.resolve('my-schema', 'User').name).toBe('postgres')
    expect(registry.resolve('my-schema', 'AuditLog').name).toBe('sqlite')
  })

  test('full cascade: model → schema → default', () => {
    metaStore.set('schema-a', {
      name: 'schema-a',
      xPersistence: { backend: 'postgres' },
      models: new Map([
        ['Model1', { name: 'Model1', xPersistence: { backend: 'sqlite' } }],
        ['Model2', { name: 'Model2' }],
      ]),
    })

    metaStore.set('schema-b', {
      name: 'schema-b',
      // No schema-level backend
      models: new Map([
        ['Model3', { name: 'Model3' }],
      ]),
    })

    // Model override → sqlite
    expect(registry.resolve('schema-a', 'Model1').name).toBe('sqlite')
    // Schema default → postgres
    expect(registry.resolve('schema-a', 'Model2').name).toBe('postgres')
    // Registry default → memory
    expect(registry.resolve('schema-b', 'Model3').name).toBe('memory')
  })

  test('unknown model falls back correctly', () => {
    metaStore.set('my-schema', {
      name: 'my-schema',
      xPersistence: { backend: 'postgres' },
      models: new Map(),
    })

    // Model doesn't exist, but schema has default
    const backend = registry.resolve('my-schema', 'NonExistent')
    expect(backend.name).toBe('postgres')
  })
})

// ============================================================================
// Test: Default Backend
// ============================================================================

describe('Default Backend', () => {
  let registry: BackendRegistry
  let metaStore: Map<string, SchemaMeta>

  beforeEach(() => {
    metaStore = new Map()
    registry = new BackendRegistry(metaStore)
    registry.register(memoryBackend)
    registry.register(postgresBackend)
  })

  test('default is memory initially', () => {
    expect(registry.getDefault().name).toBe('memory')
  })

  test('can change default backend', () => {
    registry.setDefault('postgres')
    expect(registry.getDefault().name).toBe('postgres')
  })

  test('resolve uses new default', () => {
    registry.setDefault('postgres')
    const backend = registry.resolve('unknown', 'Model')
    expect(backend.name).toBe('postgres')
  })
})

// ============================================================================
// Test: Environment Integration Pattern (REG-06)
// ============================================================================

describe('Environment Integration (REG-06)', () => {
  // Simulating MST environment pattern

  interface MockEnvironment {
    services: {
      backendRegistry: IBackendRegistry
    }
    context: {
      schemaName: string
    }
  }

  function createEnvironment(schemaName: string): MockEnvironment {
    const metaStore = new Map<string, SchemaMeta>()
    metaStore.set(schemaName, {
      name: schemaName,
      xPersistence: { backend: 'postgres' },
      models: new Map([
        ['User', { name: 'User' }],
        ['Cache', { name: 'Cache', xPersistence: { backend: 'memory' } }],
      ]),
    })

    const registry = new BackendRegistry(metaStore)
    registry.register(memoryBackend)
    registry.register(postgresBackend)

    return {
      services: { backendRegistry: registry },
      context: { schemaName },
    }
  }

  test('resolve backend via environment', () => {
    const env = createEnvironment('my-app')

    // Simulating collection accessing registry
    const userBackend = env.services.backendRegistry.resolve(
      env.context.schemaName,
      'User'
    )
    const cacheBackend = env.services.backendRegistry.resolve(
      env.context.schemaName,
      'Cache'
    )

    expect(userBackend.name).toBe('postgres')
    expect(cacheBackend.name).toBe('memory')
  })

  test('different environments can have different registries', () => {
    const prodEnv = createEnvironment('prod-schema')
    const testEnv = createEnvironment('test-schema')

    // Test env could use different default
    ;(testEnv.services.backendRegistry as BackendRegistry).setDefault('memory')

    // Both work independently
    expect(prodEnv.services.backendRegistry.getDefault().name).toBe('memory')
    expect(testEnv.services.backendRegistry.getDefault().name).toBe('memory')
  })
})

// ============================================================================
// Test: Global Singleton vs Per-Environment
// ============================================================================

describe('Singleton vs Per-Environment Decision', () => {
  test('Approach B: Per-Environment - each env has own registry', () => {
    const metaStore1 = new Map<string, SchemaMeta>()
    const metaStore2 = new Map<string, SchemaMeta>()

    const registry1 = new BackendRegistry(metaStore1)
    const registry2 = new BackendRegistry(metaStore2)

    registry1.register(memoryBackend)
    registry2.register(postgresBackend)

    // Completely independent
    expect(registry1.has('memory')).toBe(true)
    expect(registry1.has('postgres')).toBe(false)
    expect(registry2.has('memory')).toBe(false)
    expect(registry2.has('postgres')).toBe(true)
  })

  test('testing is easy with per-environment pattern', () => {
    // In tests, create fresh registry with mock backends
    const testMetaStore = new Map<string, SchemaMeta>()
    const testRegistry = new BackendRegistry(testMetaStore)

    const mockBackend = createMockBackend('test-backend')
    testRegistry.register(mockBackend)
    testRegistry.setDefault('test-backend')

    // Test code uses injected registry, no global state to clean up
    expect(testRegistry.getDefault().name).toBe('test-backend')
  })
})

// ============================================================================
// Test: Factory Pattern (alternative to constructor injection)
// ============================================================================

describe('Factory Pattern', () => {
  function createBackendRegistry(options: {
    metaStore: Map<string, SchemaMeta>
    backends?: IBackend[]
    defaultBackend?: string
  }): IBackendRegistry {
    const registry = new BackendRegistry(options.metaStore)

    // Register provided backends
    for (const backend of options.backends ?? []) {
      registry.register(backend)
    }

    // Set default if provided
    if (options.defaultBackend && registry.has(options.defaultBackend)) {
      registry.setDefault(options.defaultBackend)
    }

    return registry
  }

  test('factory creates configured registry', () => {
    const metaStore = new Map<string, SchemaMeta>()
    const registry = createBackendRegistry({
      metaStore,
      backends: [memoryBackend, postgresBackend],
      defaultBackend: 'postgres',
    })

    expect(registry.list()).toEqual(['memory', 'postgres'])
    expect(registry.getDefault().name).toBe('postgres')
  })

  test('factory with minimal config', () => {
    const metaStore = new Map<string, SchemaMeta>()
    const registry = createBackendRegistry({ metaStore })

    expect(registry.list()).toEqual([])
  })
})

// ============================================================================
// Test: Real Meta-Store Integration Shape
// ============================================================================

describe('Meta-Store Integration Shape', () => {
  /**
   * In real implementation, we'd query the actual meta-store.
   * Here we test the interface shape we need from meta-store.
   */

  interface RealMetaStoreQuery {
    getSchema(name: string): SchemaMeta | undefined
    getModel(schemaName: string, modelName: string): ModelMeta | undefined
  }

  class BackendRegistryWithMetaStore implements IBackendRegistry {
    private backends = new Map<string, IBackend>()
    private defaultBackendName = 'memory'
    private metaStore: RealMetaStoreQuery

    constructor(metaStore: RealMetaStoreQuery) {
      this.metaStore = metaStore
    }

    register(backend: IBackend): void {
      this.backends.set(backend.name, backend)
    }

    get(name: string): IBackend {
      const backend = this.backends.get(name)
      if (!backend) throw new Error(`Backend '${name}' not registered`)
      return backend
    }

    has(name: string): boolean {
      return this.backends.has(name)
    }

    setDefault(name: string): void {
      if (!this.has(name)) throw new Error(`Backend '${name}' not registered`)
      this.defaultBackendName = name
    }

    getDefault(): IBackend {
      return this.get(this.defaultBackendName)
    }

    resolve(schemaName: string, modelName: string): IBackend {
      // Query meta-store
      const model = this.metaStore.getModel(schemaName, modelName)
      if (model?.xPersistence?.backend) {
        return this.get(model.xPersistence.backend)
      }

      const schema = this.metaStore.getSchema(schemaName)
      if (schema?.xPersistence?.backend) {
        return this.get(schema.xPersistence.backend)
      }

      return this.getDefault()
    }

    list(): string[] {
      return Array.from(this.backends.keys())
    }
  }

  test('works with query-based meta-store interface', () => {
    // Mock meta-store with query methods
    const mockMetaStore: RealMetaStoreQuery = {
      getSchema: (name) => {
        if (name === 'my-schema') {
          return {
            name: 'my-schema',
            xPersistence: { backend: 'postgres' },
            models: new Map(),
          }
        }
        return undefined
      },
      getModel: (schemaName, modelName) => {
        if (schemaName === 'my-schema' && modelName === 'Cache') {
          return { name: 'Cache', xPersistence: { backend: 'memory' } }
        }
        return undefined
      },
    }

    const registry = new BackendRegistryWithMetaStore(mockMetaStore)
    registry.register(memoryBackend)
    registry.register(postgresBackend)

    expect(registry.resolve('my-schema', 'User').name).toBe('postgres')
    expect(registry.resolve('my-schema', 'Cache').name).toBe('memory')
  })
})

// ============================================================================
// Summary
// ============================================================================

describe('Decision Summary', () => {
  test('print findings', () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   BACKEND REGISTRY FINDINGS                        ║
╠════════════════════════════════════════════════════════════════════╣
║ RECOMMENDATION: Approach B (Per-Environment Instance)              ║
╠════════════════════════════════════════════════════════════════════╣
║ Rationale:                                                         ║
║ 1. Matches existing MST environment DI pattern                     ║
║ 2. Easy to test - no global state to clean up                      ║
║ 3. Supports different backends per environment (test vs prod)      ║
║ 4. Registry instance passed via environment.services               ║
╠════════════════════════════════════════════════════════════════════╣
║ Implementation:                                                    ║
║ • BackendRegistry class with register/get/has/resolve/setDefault   ║
║ • Resolution cascade: model → schema → default                     ║
║ • Factory function for easy construction with config               ║
║ • Meta-store integration via query interface                       ║
╠════════════════════════════════════════════════════════════════════╣
║ Environment Shape:                                                 ║
║   interface IEnvironment {                                         ║
║     services: {                                                    ║
║       persistence: IPersistenceService                             ║
║       backendRegistry: IBackendRegistry  // NEW                    ║
║     }                                                              ║
║   }                                                                ║
╠════════════════════════════════════════════════════════════════════╣
║ ALL REQUIREMENTS MET:                                              ║
║ ✅ REG-01: Register backends by name at startup                    ║
║ ✅ REG-02: Resolve from model x-persistence.backend                ║
║ ✅ REG-03: Fall back to schema x-persistence.backend               ║
║ ✅ REG-04: Fall back to default backend (memory)                   ║
║ ✅ REG-05: Clear error on unregistered backend                     ║
║ ✅ REG-06: Environment DI integration                              ║
╚════════════════════════════════════════════════════════════════════╝
    `)
  })
})
