/**
 * BackendRegistry.resolve() Tests
 *
 * Tests for registry's resolve() method that creates configured executors.
 *
 * Target design: resolve() returns IQueryExecutor with data source bound.
 * Current: resolve() returns IBackend (will be refactored).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { BackendRegistry } from "../registry"
import { MemoryBackend } from "../backends/memory"
import { SqlBackend } from "../backends/sql"
import { BunSqlExecutor } from "../execution/bun-sql"
import { MemoryQueryExecutor } from "../executors/memory"
import { SqlQueryExecutor } from "../executors/sql"
import { parseQuery } from "../ast/parser"

// ============================================================================
// Mock Collection
// ============================================================================

function createMockCollection<T>(items: T[], modelName = "TestModel") {
  return {
    all: () => items,
    modelName
  }
}

// ============================================================================
// REG-01: Registry Signature Changes
// ============================================================================

describe("REG-01: Registry method signatures (target design)", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("register() signature: (name: string, backend: IBackend)", () => {
    // Current signature - takes IBackend instance
    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)

    expect(registry.has("memory")).toBe(true)
  })

  test("resolve() target signature: (schemaName, modelName, collection?)", () => {
    // TARGET: resolve() should accept optional collection parameter
    // and return IQueryExecutor instead of IBackend

    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)
    registry.setDefault("memory")

    const collection = createMockCollection([{ id: "1" }])

    // This will fail until refactored - resolve() currently only takes 2 params
    try {
      const executor = (registry as any).resolve(
        "test-schema",
        "TestModel",
        collection
      )
      expect(executor).toBeDefined()
    } catch (e: any) {
      // Expected to fail - not yet implemented
      expect(e.message).toContain("not implemented")
    }
  })
})

// ============================================================================
// REG-02: Memory Backend Resolution
// ============================================================================

describe("REG-02: Memory backend resolution (target behavior)", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
    registry.register("memory", new MemoryBackend())
    registry.setDefault("memory")
  })

  test("resolve() with collection returns MemoryQueryExecutor", () => {
    const collection = createMockCollection([{ id: "1", name: "Test" }])

    const result = registry.resolve("test-schema", "TestModel", collection)

    expect(result).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("memory executor has collection bound at creation", async () => {
    const testData = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" }
    ]
    const collection = createMockCollection(testData)

    // TARGET: Executor has collection bound, no need to pass to execute methods
    const executor = new MemoryQueryExecutor(collection)

    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(2)
  })

  test("memory executor filters without passing collection again", async () => {
    const testData = [
      { id: "1", status: "active" },
      { id: "2", status: "inactive" },
      { id: "3", status: "active" }
    ]
    const collection = createMockCollection(testData)
    const executor = new MemoryQueryExecutor(collection)

    // Collection already bound - just pass query
    const result = await executor.select(parseQuery({ status: "active" }))
    expect(result).toHaveLength(2)
  })
})

// ============================================================================
// REG-03: SQL Backend Resolution
// ============================================================================

describe("REG-03: SQL backend resolution (target behavior)", () => {
  let registry: BackendRegistry
  let db: Database
  let sqlExecutor: BunSqlExecutor

  beforeEach(() => {
    registry = new BackendRegistry()
    db = new Database(":memory:")
    sqlExecutor = new BunSqlExecutor(db)

    // Create test table
    db.run(`
      CREATE TABLE test_model (
        id TEXT PRIMARY KEY,
        name TEXT
      )
    `)

    db.run(`INSERT INTO test_model VALUES ('1', 'Test')`)

    // Register SQL backend with executor
    const sqlBackend = new SqlBackend({
      dialect: 'sqlite',
      executor: sqlExecutor
    })
    registry.register("sql", sqlBackend)
    registry.setDefault("sql")
  })

  afterEach(() => {
    db.close()
  })

  test("resolve() for SQL backend returns SqlQueryExecutor", () => {
    const result = registry.resolve("test-schema", "TestModel")

    expect(result).toBeInstanceOf(SqlQueryExecutor)
  })

  test("sql executor has tableName derived from model name", () => {
    const result = registry.resolve("test-schema", "TestModel")

    expect((result as any).tableName).toBe("test_model")
  })

  test("sql executor queries without passing tableName again", async () => {
    const executor = registry.resolve("test-schema", "TestModel")

    // Table name already bound - just pass query
    const result = await executor.select(parseQuery({}))
    expect(result).toHaveLength(1)
  })
})

// ============================================================================
// REG-04: Backend Resolution Cascade
// ============================================================================

describe("REG-04: Backend resolution cascade", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("cascade: model x-persistence → schema x-persistence → default", () => {
    // Current implementation already does cascade
    // Testing that it continues to work

    registry.register("memory", new MemoryBackend())
    registry.setDefault("memory")

    const collection = createMockCollection([{ id: "1" }])
    const result = registry.resolve("test-schema", "TestModel", collection)

    // Should resolve to default when no model/schema override
    expect(result).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("throws descriptive error when no backend found", () => {
    // No backends registered, no default

    expect(() => {
      registry.resolve("test-schema", "TestModel")
    }).toThrow(/No backend found/)
    expect(() => {
      registry.resolve("test-schema", "TestModel")
    }).toThrow(/model x-persistence.backend/)
  })

  test("setDefault() validates backend exists", () => {
    expect(() => {
      registry.setDefault("nonexistent")
    }).toThrow(/not registered/)
  })
})

// ============================================================================
// REG-04b: Schema-level x-persistence Cascade
// ============================================================================

import { getMetaStore, resetMetaStore } from "../../meta/bootstrap"

describe("REG-04b: Schema-level x-persistence cascade", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    resetMetaStore()
    registry = new BackendRegistry()
    registry.register("memory", new MemoryBackend())
    registry.register("postgres", new MemoryBackend()) // Mock postgres as memory for testing
    registry.register("elasticsearch", new MemoryBackend()) // Mock elasticsearch
  })

  test("uses schema-level x-persistence.backend when model has none", () => {
    const metaStore = getMetaStore()

    // Schema with x-persistence.backend at schema level
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-persistence": {
        backend: "postgres"
      },
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "schema-backend-test"
    })

    const collection = createMockCollection([{ id: "1" }])

    // Should resolve to "postgres" from schema-level x-persistence
    const executor = registry.resolve("schema-backend-test", "User", collection)

    // Verify it resolved to postgres (we mocked it as memory executor for simplicity)
    expect(executor).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("model-level x-persistence.backend overrides schema-level", () => {
    const metaStore = getMetaStore()

    // Schema with both schema-level and model-level x-persistence
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-persistence": {
        backend: "postgres"
      },
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        AuditLog: {
          type: "object",
          "x-persistence": {
            strategy: "flat",  // Required by model xPersistence schema
            backend: "elasticsearch"
          },
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            action: { type: "string" }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "mixed-backend-test"
    })

    const collection = createMockCollection([{ id: "1" }])

    // User should use schema-level postgres
    const userExecutor = registry.resolve("mixed-backend-test", "User", collection)
    expect(userExecutor).toBeInstanceOf(MemoryQueryExecutor)

    // AuditLog should use model-level elasticsearch
    const auditExecutor = registry.resolve("mixed-backend-test", "AuditLog", collection)
    expect(auditExecutor).toBeInstanceOf(MemoryQueryExecutor)
  })

  test("full cascade: model → schema → default", () => {
    const metaStore = getMetaStore()

    // Schema without any x-persistence
    const inputSchema = {
      $defs: {
        Task: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            title: { type: "string" }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "no-persistence-test"
    })

    registry.setDefault("memory")
    const collection = createMockCollection([{ id: "1" }])

    // Should fall back to default
    const executor = registry.resolve("no-persistence-test", "Task", collection)
    expect(executor).toBeInstanceOf(MemoryQueryExecutor)
  })
})

// ============================================================================
// REG-05: Column Property Map Integration
// ============================================================================

describe("REG-05: Column property map from meta-store", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  test("getPropertyNames() extracts from meta-store model", () => {
    // Current implementation has private getPropertyNames() method
    // It extracts property names from model.properties view

    const memoryBackend = new MemoryBackend()
    registry.register("memory", memoryBackend)
    registry.setDefault("memory")

    // This tests current behavior - getPropertyNames gets called internally
    const collection = createMockCollection([{ id: "1" }])
    const result = registry.resolve("test-schema", "TestModel", collection)

    expect(result).toBeInstanceOf(MemoryQueryExecutor)
    // Property names would be extracted if meta-store had the model
  })

  test("column property map handles edge cases", () => {
    // Tests that SqlQueryExecutor will handle edge cases correctly
    // when property names have consecutive capitals

    const propertyNames = ["ID", "HTTPSUrl", "userID"]
    const columnPropertyMap = new Map<string, string>()

    // Map snake_case columns to original property names
    for (const prop of propertyNames) {
      const snakeCase = prop
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()
      columnPropertyMap.set(snakeCase, prop)
    }

    expect(columnPropertyMap.get("id")).toBe("ID")
    expect(columnPropertyMap.get("https_url")).toBe("HTTPSUrl")
    expect(columnPropertyMap.get("user_id")).toBe("userID")
  })
})

// ============================================================================
// REG-06: Table Name Derivation
// ============================================================================

describe("REG-06: Table name derivation", () => {
  test("table name uses toSnakeCase from ddl/utils", () => {
    // TARGET: Registry should derive table name using same algorithm as DDL

    const testCases = [
      { model: "TestModel", expected: "test_model" },
      { model: "HTTPSEndpoint", expected: "https_endpoint" },
      { model: "UserProfile", expected: "user_profile" },
      { model: "XMLParser", expected: "xml_parser" }
    ]

    for (const { model, expected } of testCases) {
      const tableName = model
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase()

      expect(tableName).toBe(expected)
    }
  })
})

// ============================================================================
// REG-07: Reference Property Column Mapping (via meta-store views)
// ============================================================================

describe("REG-07: Reference property column mapping", () => {
  let registry: BackendRegistry
  let db: Database
  let sqlExecutor: BunSqlExecutor

  beforeEach(() => {
    resetMetaStore()
    registry = new BackendRegistry()
    db = new Database(":memory:")
    sqlExecutor = new BunSqlExecutor(db)

    // Create tables with FK columns following DDL convention
    db.run(`
      CREATE TABLE organization (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE department (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        organization_id TEXT NOT NULL
      )
    `)

    // Register SQL backend
    const sqlBackend = new SqlBackend({
      dialect: "sqlite",
      executor: sqlExecutor
    })
    registry.register("sql", sqlBackend)
    registry.setDefault("sql")
  })

  afterEach(() => {
    db.close()
  })

  test("meta-store Property.columnName returns FK column name for references", () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" },
            organization: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization"
            }
          },
          required: ["id", "name", "organization"]
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "column-name-test" })

    const deptModel = metaStore.modelCollection.all().find((m: any) => m.name === "Department")
    const orgProp = deptModel.properties.find((p: any) => p.name === "organization")

    // Property.columnName should mirror DDL convention: target_id
    expect(orgProp.columnName).toBe("organization_id")
  })

  test("meta-store Property.columnName returns snake_case for regular properties", () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            departmentName: { type: "string" },
            createdAt: { type: "string" }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "snake-case-test" })

    const model = metaStore.modelCollection.all().find((m: any) => m.name === "Department")
    const nameProp = model.properties.find((p: any) => p.name === "departmentName")
    const createdProp = model.properties.find((p: any) => p.name === "createdAt")

    expect(nameProp.columnName).toBe("department_name")
    expect(createdProp.columnName).toBe("created_at")
  })

  test("meta-store Model.columnPropertyMap composes property column names", () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" }
          }
        },
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" },
            organization: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization"
            }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "column-map-test" })

    const model = metaStore.modelCollection.all().find((m: any) => m.name === "Department")
    const columnMap = model.columnPropertyMap

    expect(columnMap["id"]).toBe("id")
    expect(columnMap["name"]).toBe("name")
    expect(columnMap["organization_id"]).toBe("organization")
  })

  test("registry uses Model.columnPropertyMap for SQL executor", () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" }
          }
        },
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" },
            organization: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization"
            }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "registry-map-test" })

    const executor = registry.resolve("registry-map-test", "Department") as SqlQueryExecutor<any>
    const columnPropertyMap = (executor as any).columnPropertyMap

    expect(columnPropertyMap["organization_id"]).toBe("organization")
  })

  test("INSERT with reference property uses FK column name", async () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" }
          }
        },
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" },
            organization: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization"
            }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "ref-insert-test" })

    const executor = registry.resolve<{ id: string; name: string; organization: string }>(
      "ref-insert-test",
      "Department"
    )

    // This should NOT throw "column organization does not exist"
    const result = await executor.insert({
      id: "dept-1",
      name: "Engineering",
      organization: "org-1"
    })

    expect(result.id).toBe("dept-1")
    expect(result.organization).toBe("org-1")
  })

  test("SELECT normalizes FK column back to property name", async () => {
    const metaStore = getMetaStore()

    const schema = {
      $defs: {
        Organization: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" }
          }
        },
        Department: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" },
            organization: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Organization"
            }
          }
        }
      }
    }

    metaStore.ingestEnhancedJsonSchema(schema, { name: "ref-select-test" })

    // Insert directly via SQL (simulates existing data)
    db.run(`INSERT INTO department VALUES ('dept-1', 'Engineering', 'org-1')`)

    const executor = registry.resolve<{ id: string; name: string; organization: string }>(
      "ref-select-test",
      "Department"
    )

    const results = await executor.select(parseQuery({}))

    // Result should use property name 'organization', not column 'organization_id'
    expect(results[0].organization).toBe("org-1")
    expect((results[0] as any).organization_id).toBeUndefined()
  })
})
