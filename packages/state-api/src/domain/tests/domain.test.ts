/**
 * TDD Specs for domain() Composition API
 *
 * These tests define the expected behavior of the domain() function.
 * Tests should FAIL initially (RED phase) until implementation is complete.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { scope } from "arktype"
import { getSnapshot, types, isStateTreeNode, getEnv } from "mobx-state-tree"

// These imports will fail initially (TDD)
import { domain } from "../index"
import { isScope, isEnhancedJsonSchema } from "../types"
import { getEnhancements, clearEnhancementRegistry } from "../enhancement-registry"
import { getRuntimeStore, clearRuntimeStores } from "../../meta/runtime-store-cache"

// Test fixtures
const SimpleScope = scope({
  User: {
    id: "string.uuid",
    name: "string",
    email: "string",
  },
  Post: {
    id: "string.uuid",
    title: "string",
    authorId: "User",
  },
})

// Simple Enhanced JSON Schema fixture
const SimpleEnhancedJsonSchema = {
  $defs: {
    User: {
      type: "object" as const,
      "x-arktype": "User",
      properties: {
        id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
        name: { type: "string" as const },
        email: { type: "string" as const },
      },
      required: ["id", "name", "email"],
    },
    Post: {
      type: "object" as const,
      "x-arktype": "Post",
      properties: {
        id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
        title: { type: "string" as const },
        authorId: {
          type: "string" as const,
          "x-mst-type": "reference",
          "x-reference-type": "single",
          "x-arktype": "User",
        },
      },
      required: ["id", "title", "authorId"],
    },
  },
}

describe("domain() composition API", () => {
  beforeEach(() => {
    // Clear enhancement registry between tests
    clearEnhancementRegistry()
  })

  // ==========================================================
  // 1. BASIC DOMAIN CREATION
  // ==========================================================

  describe("1. Basic domain creation", () => {
    test("creates domain from ArkType scope", () => {
      // Given: An ArkType scope
      // When: we create a domain from it
      const result = domain({
        name: "test-domain",
        from: SimpleScope,
      })

      // Then: we get expected DomainResult shape
      expect(result).toBeDefined()
      expect(result.name).toBe("test-domain")
      expect(result.enhancedSchema).toBeDefined()
      expect(typeof result.createStore).toBe("function")
      expect(typeof result.register).toBe("function")
    })

    test("creates domain from Enhanced JSON Schema", () => {
      // Given: An Enhanced JSON Schema
      // When: we create a domain from it
      const result = domain({
        name: "test-domain",
        from: SimpleEnhancedJsonSchema,
      })

      // Then: we get expected DomainResult shape
      expect(result).toBeDefined()
      expect(result.name).toBe("test-domain")
      expect(result.enhancedSchema).toBeDefined()
      expect(typeof result.createStore).toBe("function")
      expect(typeof result.register).toBe("function")
    })

    test("both inputs produce structurally identical enhancedSchema", () => {
      // Given: Domain from scope and domain from schema
      const fromScope = domain({
        name: "from-scope",
        from: SimpleScope,
      })

      const fromSchema = domain({
        name: "from-schema",
        from: SimpleEnhancedJsonSchema,
      })

      // Then: Both have $defs with same entity names
      expect(fromScope.enhancedSchema.$defs).toBeDefined()
      expect(fromSchema.enhancedSchema.$defs).toBeDefined()
      expect(Object.keys(fromScope.enhancedSchema.$defs!)).toContain("User")
      expect(Object.keys(fromScope.enhancedSchema.$defs!)).toContain("Post")
      expect(Object.keys(fromSchema.enhancedSchema.$defs!)).toContain("User")
      expect(Object.keys(fromSchema.enhancedSchema.$defs!)).toContain("Post")
    })

    test("exposes RootStoreModel and models for type access", () => {
      // Given: A domain from ArkType scope
      const result = domain({
        name: "test-domain",
        from: SimpleScope,
      })

      // Then: RootStoreModel is exposed and is an MST model type
      expect(result.RootStoreModel).toBeDefined()
      expect(typeof result.RootStoreModel.create).toBe("function")

      // And: models record is exposed with entity types
      expect(result.models).toBeDefined()
      expect(result.models.User).toBeDefined()
      expect(result.models.Post).toBeDefined()
      expect(typeof result.models.User.create).toBe("function")
    })
  })

  // ==========================================================
  // 2. TYPE GUARDS
  // ==========================================================

  describe("2. Type guards", () => {
    test("isScope correctly identifies ArkType Scope", () => {
      expect(isScope(SimpleScope)).toBe(true)
      expect(isScope(SimpleEnhancedJsonSchema)).toBe(false)
      expect(isScope(null)).toBe(false)
      expect(isScope({})).toBe(false)
      expect(isScope({ export: "not a function" })).toBe(false)
    })

    test("isEnhancedJsonSchema correctly identifies Enhanced JSON Schema", () => {
      expect(isEnhancedJsonSchema(SimpleEnhancedJsonSchema)).toBe(true)
      expect(isEnhancedJsonSchema(SimpleScope)).toBe(false)
      expect(isEnhancedJsonSchema(null)).toBe(false)
      expect(isEnhancedJsonSchema({})).toBe(false)
      expect(isEnhancedJsonSchema({ $defs: "not an object" })).toBe(false)
    })
  })

  // ==========================================================
  // 3. ENHANCEMENT HOOKS
  // ==========================================================

  describe("3. Enhancement hooks", () => {
    test("models enhancement adds computed views", () => {
      // Given: A domain with model enhancements
      const result = domain({
        name: "enhanced-models",
        from: SimpleScope,
        enhancements: {
          models: (models) => ({
            ...models,
            User: models.User.views((self: any) => ({
              get displayName(): string {
                return `${self.name} <${self.email}>`
              },
            })),
          }),
        },
      })

      // When: we create a store and add a user
      const store = result.createStore()
      const user = store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Alice",
        email: "alice@example.com",
      })

      // Then: the computed view works
      expect(user.displayName).toBe("Alice <alice@example.com>")
    })

    test("collections enhancement adds query methods", () => {
      // Given: A domain with collection enhancements
      const result = domain({
        name: "enhanced-collections",
        from: SimpleScope,
        enhancements: {
          collections: (collections) => ({
            ...collections,
            UserCollection: collections.UserCollection.views((self: any) => ({
              findByEmail(email: string): any | undefined {
                return self.all().find((u: any) => u.email === email)
              },
            })),
          }),
        },
      })

      // When: we create a store and add users
      const store = result.createStore()
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Alice",
        email: "alice@example.com",
      })
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440002",
        name: "Bob",
        email: "bob@example.com",
      })

      // Then: the query method works
      const alice = store.userCollection.findByEmail("alice@example.com")
      expect(alice).toBeDefined()
      expect(alice.name).toBe("Alice")
    })

    test("rootStore enhancement adds domain actions", () => {
      // Given: A domain with root store enhancements
      const result = domain({
        name: "enhanced-root",
        from: SimpleScope,
        enhancements: {
          rootStore: (RootModel) =>
            RootModel.views((self: any) => ({
              get userCount(): number {
                return self.userCollection.all().length
              },
            })),
        },
      })

      // When: we create a store and add users
      const store = result.createStore()
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Alice",
        email: "alice@example.com",
      })

      // Then: the root store view works
      expect(store.userCount).toBe(1)
    })

    test("CollectionPersistable is auto-composed on all collections", () => {
      // Given: A domain with default persistence (true)
      const result = domain({
        name: "with-persistence",
        from: SimpleScope,
      })

      // When: we create a store
      const store = result.createStore()

      // Then: collections have loadAll/saveAll methods from CollectionPersistable
      expect(typeof store.userCollection.loadAll).toBe("function")
      expect(typeof store.userCollection.saveAll).toBe("function")
      expect(typeof store.postCollection.loadAll).toBe("function")
      expect(typeof store.postCollection.saveAll).toBe("function")
    })

    test("persistence: false disables auto CollectionPersistable", () => {
      // Given: A domain with persistence disabled
      const result = domain({
        name: "no-persistence",
        from: SimpleScope,
        persistence: false,
      })

      // When: we create a store
      const store = result.createStore()

      // Then: collections do NOT have persistable methods
      // (standard collection only has add/get/has/all/remove)
      expect(store.userCollection.loadAll).toBeUndefined()
      expect(store.userCollection.saveAll).toBeUndefined()
    })
  })

  // ==========================================================
  // 4. STORE CREATION (createStore pattern)
  // ==========================================================

  describe("4. Store creation (createStore pattern)", () => {
    test("createStore(env) produces working MST store", () => {
      // Given: A domain
      const result = domain({
        name: "store-test",
        from: SimpleScope,
      })

      // When: we create a store
      const store = result.createStore()

      // Then: it's a valid MST node with collections
      expect(isStateTreeNode(store)).toBe(true)
      expect(store.userCollection).toBeDefined()
      expect(store.postCollection).toBeDefined()
    })

    test("store has all enhanced views and actions", () => {
      // Given: Domain with all three enhancement types
      const result = domain({
        name: "full-enhancement",
        from: SimpleScope,
        enhancements: {
          models: (models) => ({
            ...models,
            User: models.User.views((self: any) => ({
              get upper(): string {
                return self.name.toUpperCase()
              },
            })),
          }),
          collections: (collections) => ({
            ...collections,
            UserCollection: collections.UserCollection.views((self: any) => ({
              count(): number {
                return self.all().length
              },
            })),
          }),
          rootStore: (Root) =>
            Root.views((self: any) => ({
              get isEmpty(): boolean {
                return self.userCollection.all().length === 0
              },
            })),
        },
      })

      // When: we create store and use it
      const store = result.createStore()

      // Then: all enhancements are present
      expect(store.isEmpty).toBe(true)
      expect(store.userCollection.count()).toBe(0)

      const user = store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "alice",
        email: "alice@test.com",
      })

      expect(user.upper).toBe("ALICE")
      expect(store.userCollection.count()).toBe(1)
      expect(store.isEmpty).toBe(false)
    })

    test("persistence works via environment injection", () => {
      // Given: A domain with persistence enabled
      const result = domain({
        name: "env-test",
        from: SimpleScope,
      })

      // Mock persistence service
      const mockPersistence = {
        loadCollection: async () => [],
        saveCollection: async () => {},
        loadEntity: async () => null,
        saveEntity: async () => {},
      }

      // When: we create store with persistence in environment
      const store = result.createStore({
        services: {
          persistence: mockPersistence,
          backendRegistry: {
            register: () => {},
            get: () => undefined,
            has: () => false,
            resolve: () => { throw new Error("No backend") },
            setDefault: () => {},
          } as any,
        },
        context: { schemaName: "env-test" },
      })

      // Then: store is created (persistence service available via env)
      expect(store).toBeDefined()
      expect(store.userCollection).toBeDefined()
    })
  })

  // ==========================================================
  // 5. META-STORE INTEGRATION (register pattern)
  // ==========================================================

  describe("5. Meta-store integration (register pattern)", () => {
    // Mock meta-store for testing register()
    function createMockMetaStore() {
      const schemas: Map<string, any> = new Map()
      const runtimeStores: Map<string, any> = new Map()

      return {
        schemas,
        runtimeStores,
        findSchemaByName(name: string) {
          return Array.from(schemas.values()).find((s: any) => s.name === name)
        },
        ingestEnhancedJsonSchema(enhancedSchema: any, metadata: any) {
          const schema = {
            id: metadata.id || `schema-${Date.now()}`,
            name: metadata.name,
            format: "enhanced-json-schema",
            createdAt: metadata.createdAt || Date.now(),
            toEnhancedJson: enhancedSchema,
          }
          schemas.set(schema.id, schema)
          return schema
        },
        // Track runtime store caching for assertions
        cacheRuntimeStore(schemaId: string, store: any, workspace?: string) {
          const key = workspace ? `${schemaId}:${workspace}` : schemaId
          runtimeStores.set(key, store)
        },
        getRuntimeStore(schemaId: string, workspace?: string) {
          const key = workspace ? `${schemaId}:${workspace}` : schemaId
          return runtimeStores.get(key)
        },
      }
    }

    test("register(metaStore) ingests schema and returns Schema entity", () => {
      // Given: A domain with enhancements
      const result = domain({
        name: "register-ingest-test",
        from: SimpleScope,
        enhancements: {
          models: (models) => models,
        },
      })

      const mockMetaStore = createMockMetaStore()

      // When: we register with meta-store
      const schema = result.register(mockMetaStore)

      // Then: Schema entity is returned with correct properties
      expect(schema).toBeDefined()
      expect(schema.name).toBe("register-ingest-test")
      expect(schema.id).toBeDefined()
      expect(mockMetaStore.findSchemaByName("register-ingest-test")).toBe(schema)
    })

    test("register() caches runtime store with enhancements applied", () => {
      // Given: A domain with model enhancements
      clearRuntimeStores()
      const result = domain({
        name: "register-cache-test",
        from: SimpleScope,
        enhancements: {
          models: (models) => ({
            ...models,
            User: models.User.views((self: any) => ({
              get upperName(): string {
                return self.name.toUpperCase()
              },
            })),
          }),
        },
      })

      const mockMetaStore = createMockMetaStore()

      // When: we register
      const schema = result.register(mockMetaStore)

      // Then: runtime store is cached and has enhancements (use global cache)
      const cachedStore = getRuntimeStore(schema.id)
      expect(cachedStore).toBeDefined()

      // Add a user to verify enhancements work
      const user = cachedStore.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "alice",
        email: "alice@test.com",
      })
      expect(user.upperName).toBe("ALICE")
    })

    test("register() with workspace creates isolated runtime store", () => {
      // Given: A domain
      clearRuntimeStores()
      const result = domain({
        name: "register-workspace-test",
        from: SimpleScope,
      })

      const mockMetaStore = createMockMetaStore()

      // When: we register with different workspaces
      const schema1 = result.register(mockMetaStore, { workspace: "/workspace/a" })
      const schema2 = result.register(mockMetaStore, { workspace: "/workspace/b" })

      // Then: Each workspace has its own runtime store (use global cache)
      const storeA = getRuntimeStore(schema1.id, "/workspace/a")
      const storeB = getRuntimeStore(schema2.id, "/workspace/b")

      expect(storeA).toBeDefined()
      expect(storeB).toBeDefined()
      expect(storeA).not.toBe(storeB)
    })

    test("register() adds enhancements to registry", () => {
      // Given: A domain with enhancements
      const enhancements = {
        models: (models: any) => models,
      }

      const result = domain({
        name: "registry-test",
        from: SimpleScope,
        enhancements,
      })

      // When: we access the enhancement registry (after domain creation)
      // Note: In real implementation, register() explicitly adds to registry
      const registered = getEnhancements("registry-test")

      // Then: enhancements are stored in registry
      expect(registered).toBeDefined()
      expect(registered?.models).toBe(enhancements.models)
    })

    test("enhancement registry can be cleared", () => {
      // Given: A domain that registered enhancements
      domain({
        name: "clear-test",
        from: SimpleScope,
        enhancements: {
          models: (models) => models,
        },
      })

      // Verify it's registered
      expect(getEnhancements("clear-test")).toBeDefined()

      // When: we clear the registry
      clearEnhancementRegistry()

      // Then: enhancements are gone
      expect(getEnhancements("clear-test")).toBeUndefined()
    })
  })

  // ==========================================================
  // 6. METADATA HANDLING
  // ==========================================================

  describe("6. Metadata handling", () => {
    test("EnhancedJsonSchema input preserves existing metadata", () => {
      // Given: Enhanced JSON Schema with x-persistence metadata
      const schemaWithMetadata = {
        ...SimpleEnhancedJsonSchema,
        "x-persistence": {
          User: { nested: false },
        },
      }

      // When: we create domain from it
      const result = domain({
        name: "metadata-preserve",
        from: schemaWithMetadata,
      })

      // Then: metadata is preserved in enhancedSchema
      expect(result.enhancedSchema["x-persistence"]).toBeDefined()
      expect(result.enhancedSchema["x-persistence"]?.User?.nested).toBe(false)
    })

    test("ArkType input merges metadata from schema.json via loader", async () => {
      // This test verifies the metadata-merge integration point
      // Uses the mergeMetadataFromFile function with a mock loader

      // Import the merge function (to be implemented)
      const { mergeMetadataFromFile } = await import("../metadata-merge")

      // Given: A base enhanced schema (from ArkType conversion)
      const baseSchema = {
        $defs: {
          User: {
            type: "object" as const,
            "x-arktype": "User",
            properties: {
              id: { type: "string" as const, "x-mst-type": "identifier" },
              name: { type: "string" as const },
            },
            required: ["id", "name"],
          },
        },
      }

      // And: Mock schema.json content with x-persistence
      const mockSchemaJson = {
        id: "test-id",
        name: "merge-test",
        format: "enhanced-json-schema",
        createdAt: Date.now(),
        $defs: baseSchema.$defs,
        "x-persistence": {
          User: { nested: false, partition: "status" },
        },
      }

      // When: we merge metadata using a mock loader
      const merged = await mergeMetadataFromFile(
        "merge-test",
        baseSchema,
        undefined, // workspace
        // Mock loader that returns our test data
        async () => ({
          metadata: { id: mockSchemaJson.id, name: mockSchemaJson.name, createdAt: mockSchemaJson.createdAt, format: mockSchemaJson.format },
          enhanced: mockSchemaJson,
        })
      )

      // Then: x-persistence is merged into the schema
      expect(merged["x-persistence"]).toBeDefined()
      expect(merged["x-persistence"]?.User?.nested).toBe(false)
      expect(merged["x-persistence"]?.User?.partition).toBe("status")
    })

    test("ArkType input returns original schema when schema.json not found", async () => {
      const { mergeMetadataFromFile } = await import("../metadata-merge")

      // Given: A base schema
      const baseSchema = {
        $defs: {
          User: {
            type: "object" as const,
            properties: { id: { type: "string" as const } },
          },
        },
      }

      // When: we merge with a loader that throws ENOENT
      const merged = await mergeMetadataFromFile(
        "nonexistent-schema",
        baseSchema,
        undefined,
        // Mock loader that simulates file not found
        async () => {
          const error: any = new Error("Schema not found")
          error.code = "ENOENT"
          throw error
        }
      )

      // Then: original schema is returned unchanged
      expect(merged).toEqual(baseSchema)
      expect(merged["x-persistence"]).toBeUndefined()
    })
  })

  // ==========================================================
  // 7. EDGE CASES
  // ==========================================================

  describe("7. Edge cases", () => {
    test("domain with no enhancements works correctly", () => {
      // Given/When: Domain with no enhancements
      const result = domain({
        name: "no-enhancements",
        from: SimpleScope,
      })

      const store = result.createStore()

      // Then: Basic functionality works
      const user = store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Test",
        email: "test@test.com",
      })

      expect(user.name).toBe("Test")
      expect(store.userCollection.get(user.id)).toBe(user)
    })

    test("domain validates name is provided", () => {
      // Given: Attempt to create domain without name
      // Then: should throw
      expect(() => {
        domain({
          name: "",
          from: SimpleScope,
        })
      }).toThrow()
    })

    test("domain validates from is Scope or EnhancedJsonSchema", () => {
      // Given: Invalid from value
      // Then: should throw
      expect(() => {
        domain({
          name: "invalid",
          from: { invalid: "data" } as any,
        })
      }).toThrow()
    })
  })

  // ==========================================================
  // 8. META-STORE loadSchema() ENHANCEMENT INTEGRATION
  // ==========================================================

  describe("8. Meta-store loadSchema() enhancement integration", () => {
    // Mock persistence service (no actual filesystem access)
    const mockPersistence = {
      loadCollection: async () => [],
      saveCollection: async () => {},
      loadEntity: async () => null,
      saveEntity: async () => {},
      loadSchema: async () => null, // Schema not on disk, already in meta-store
    }

    test("loadSchema() applies registered enhancements from domain()", async () => {
      // This test verifies that meta-store's loadSchema() uses the enhancement registry
      // Import the real meta-store to test the integration
      const { resetMetaStore, getMetaStore, clearRuntimeStores, getRuntimeStore } = await import("../../meta/bootstrap")
      const { getEnhancements } = await import("../enhancement-registry")

      // Reset to clean state
      resetMetaStore()
      clearRuntimeStores()
      clearEnhancementRegistry()

      // Given: A domain with enhancements is defined
      const testDomain = domain({
        name: "loadschema-enhance-test",
        from: SimpleScope,
        enhancements: {
          models: (models) => ({
            ...models,
            User: models.User.views((self: any) => ({
              get testView(): string {
                return `enhanced-${self.name}`
              },
            })),
          }),
        },
      })

      // Verify enhancements are registered
      expect(getEnhancements("loadschema-enhance-test")).toBeDefined()

      // When: We create meta-store with mock persistence and ingest schema
      const metaStore = getMetaStore({
        services: { persistence: mockPersistence },
      })
      metaStore.ingestEnhancedJsonSchema(testDomain.enhancedSchema, {
        name: "loadschema-enhance-test",
      })

      // Load the schema (this should apply registered enhancements)
      await metaStore.loadSchema("loadschema-enhance-test")

      // Then: Runtime store should have enhancements applied
      const schema = metaStore.findSchemaByName("loadschema-enhance-test")
      const runtimeStore = getRuntimeStore(schema.id)

      expect(runtimeStore).toBeDefined()

      // Add a user and verify enhancement works
      const user = runtimeStore.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "alice",
        email: "alice@test.com",
      })

      // This will fail until loadSchema() is updated to use enhancement registry
      expect(user.testView).toBe("enhanced-alice")
    })

    test("loadSchema() falls back to CollectionPersistable when no enhancements registered", async () => {
      const { resetMetaStore, getMetaStore, clearRuntimeStores, getRuntimeStore } = await import("../../meta/bootstrap")

      // Reset to clean state
      resetMetaStore()
      clearRuntimeStores()
      clearEnhancementRegistry()

      // Given: A schema WITHOUT domain() enhancements
      const metaStore = getMetaStore({
        services: { persistence: mockPersistence },
      })
      metaStore.ingestEnhancedJsonSchema(SimpleEnhancedJsonSchema, {
        name: "no-domain-enhance-test",
      })

      // When: loadSchema is called
      await metaStore.loadSchema("no-domain-enhance-test")

      // Then: Runtime store exists with default CollectionPersistable
      const schema = metaStore.findSchemaByName("no-domain-enhance-test")
      const runtimeStore = getRuntimeStore(schema.id)

      expect(runtimeStore).toBeDefined()
      expect(runtimeStore.userCollection).toBeDefined()

      // CollectionPersistable should be composed (loadAll exists)
      expect(typeof runtimeStore.userCollection.loadAll).toBe("function")
    })
  })

  // ==========================================================
  // 9. REGISTER() BUG FIXES
  // ==========================================================

  describe("9. register() bug fixes", () => {
    // Import runtime store cache functions for testing
    const getRuntimeStoreFromCache = async () => {
      const { getRuntimeStore } = await import("../../meta/runtime-store-cache")
      return getRuntimeStore
    }

    // Create mock meta-store AS an MST instance (so getEnv() works)
    function createMockMetaStoreWithEnv(env: { services: { persistence?: any } }) {
      // External state (MST models can't have Map as observable)
      const schemas: Map<string, any> = new Map()
      const runtimeStores: Map<string, any> = new Map()

      // Create MST model with actions - this becomes the metaStore
      const MockMetaStoreModel = types
        .model("MockMetaStore", {})
        .volatile(() => ({
          // Expose maps via volatile for test assertions
          schemas,
          runtimeStores,
        }))
        .actions(() => ({
          findSchemaByName(name: string) {
            return Array.from(schemas.values()).find((s: any) => s.name === name)
          },
          ingestEnhancedJsonSchema(enhancedSchema: any, metadata: any) {
            const schema = {
              id: metadata.id || `schema-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              name: metadata.name,
              format: "enhanced-json-schema",
              createdAt: metadata.createdAt || Date.now(),
              toEnhancedJson: enhancedSchema,
            }
            schemas.set(schema.name, schema)
            return schema
          },
          cacheRuntimeStore(schemaId: string, store: any, workspace?: string) {
            const key = workspace ? `${workspace}::${schemaId}` : schemaId
            runtimeStores.set(key, store)
          },
          getRuntimeStore(schemaId: string, workspace?: string) {
            const key = workspace ? `${workspace}::${schemaId}` : schemaId
            return runtimeStores.get(key)
          },
        }))

      // Create instance with environment - getEnv() will now work!
      return MockMetaStoreModel.create({}, env)
    }

    test("register() is idempotent - returns existing schema if already registered", () => {
      // Given: A domain
      clearEnhancementRegistry()
      clearRuntimeStores()
      const testDomain = domain({
        name: "idempotent-test",
        from: SimpleScope,
      })

      const mockPersistence = {
        loadCollection: async () => [],
        saveCollection: async () => {},
      }
      const mockMetaStore = createMockMetaStoreWithEnv({
        services: { persistence: mockPersistence },
      })

      // When: Domain registered twice
      const schema1 = testDomain.register(mockMetaStore)
      const schema2 = testDomain.register(mockMetaStore)

      // Then: Same schema returned, only one schema in store
      expect(schema2.id).toBe(schema1.id)
      expect(mockMetaStore.schemas.size).toBe(1)
    })

    test("register() passes persistence from metaStore environment to runtime store", () => {
      // Given: MetaStore with persistence in environment
      clearEnhancementRegistry()
      clearRuntimeStores()
      const mockPersistence = {
        loadCollection: async () => [],
        saveCollection: async () => {},
        testMarker: "persistence-test-marker", // Marker to verify same instance
      }

      const testDomain = domain({
        name: "persistence-flow-test",
        from: SimpleScope,
      })

      const mockMetaStore = createMockMetaStoreWithEnv({
        services: { persistence: mockPersistence },
      })

      // When: Domain registered
      const schema = testDomain.register(mockMetaStore)
      // Use global cache instead of mock's getRuntimeStore
      const runtimeStore = getRuntimeStore(schema.id)

      // Then: Runtime store's environment has the same persistence instance
      expect(runtimeStore).toBeDefined()
      const storeEnv = getEnv<any>(runtimeStore)
      expect(storeEnv.services).toBeDefined()
      expect(storeEnv.services.persistence).toBeDefined()
      expect(storeEnv.services.persistence.testMarker).toBe("persistence-test-marker")
    })

    test("register() checks runtime store cache before creating new store", () => {
      // Given: Domain registered once
      clearEnhancementRegistry()
      clearRuntimeStores()
      const mockPersistence = {
        loadCollection: async () => [],
        saveCollection: async () => {},
      }

      const testDomain = domain({
        name: "cache-check-test",
        from: SimpleScope,
      })

      const mockMetaStore = createMockMetaStoreWithEnv({
        services: { persistence: mockPersistence },
      })

      const schema = testDomain.register(mockMetaStore)
      // Use global cache
      const store1 = getRuntimeStore(schema.id)

      // Add data to first store to verify it's the same instance later
      store1.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "test-user",
        email: "test@test.com",
      })

      // When: Registered again
      testDomain.register(mockMetaStore)
      // Use global cache
      const store2 = getRuntimeStore(schema.id)

      // Then: Same store instance (data persists, not recreated)
      expect(store2).toBe(store1)
      expect(store2.userCollection.all().length).toBe(1)
      expect(store2.userCollection.all()[0].name).toBe("test-user")
    })
  })
})
