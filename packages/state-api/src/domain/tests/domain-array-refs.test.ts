/**
 * Tests for arrayReferenceMaps injection in domain()
 *
 * Verifies that domain() correctly computes and injects arrayReferenceMaps
 * into env.context for use by SqlQueryExecutor.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getEnv } from "mobx-state-tree"
import { domain } from "../index"
import { clearEnhancementRegistry } from "../enhancement-registry"
import { clearRuntimeStores } from "../../meta/runtime-store-cache"

describe("domain() arrayReferenceMaps injection", () => {
  beforeEach(() => {
    clearEnhancementRegistry()
    clearRuntimeStores()
  })

  /**
   * Test: arrayReferenceMaps is injected into env.context
   * Given: Schema with Team.members -> User array reference
   * Then: env.context.arrayReferenceMaps contains the metadata
   */
  test("injects arrayReferenceMaps into env.context", () => {
    const schema = {
      $defs: {
        Team: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" as const },
            members: {
              type: "array" as const,
              items: { type: "string" as const },
              "x-reference-type": "array",
              "x-reference-target": "User"
            }
          },
          required: ["id", "name"]
        },
        User: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" as const }
          },
          required: ["id", "name"]
        }
      }
    }

    const testDomain = domain({
      name: "test-array-refs",
      from: schema
    })

    // Create store with minimal environment
    const store = testDomain.createStore({
      context: { schemaName: "test-array-refs" }
    } as any)

    // Get environment from store
    const env = getEnv<any>(store)

    // Verify arrayReferenceMaps is injected
    expect(env.context.arrayReferenceMaps).toBeDefined()
    expect(env.context.arrayReferenceMaps.Team).toBeDefined()
    expect(env.context.arrayReferenceMaps.Team.members).toEqual({
      junctionTable: "team_members",
      sourceColumn: "team_id",
      targetColumn: "user_id",
      targetModel: "User",
      isSelfReference: false
    })
  })

  /**
   * Test: Self-referential array reference metadata
   * Given: ImplementationTask.dependencies -> ImplementationTask
   * Then: Uses source_/target_ column prefixes
   */
  test("injects self-referential array reference metadata", () => {
    const schema = {
      $defs: {
        ImplementationTask: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" as const },
            dependencies: {
              type: "array" as const,
              items: { type: "string" as const },
              "x-reference-type": "array",
              "x-reference-target": "ImplementationTask"
            }
          },
          required: ["id", "title"]
        }
      }
    }

    const testDomain = domain({
      name: "test-self-ref",
      from: schema
    })

    const store = testDomain.createStore({
      context: { schemaName: "test-self-ref" }
    } as any)

    const env = getEnv<any>(store)

    expect(env.context.arrayReferenceMaps.ImplementationTask.dependencies).toEqual({
      junctionTable: "implementation_task_dependencies",
      sourceColumn: "source_implementation_task_id",
      targetColumn: "target_implementation_task_id",
      targetModel: "ImplementationTask",
      isSelfReference: true
    })
  })

  /**
   * Test: Empty arrayReferenceMaps for schema without array refs
   * Given: Schema with only simple properties
   * Then: arrayReferenceMaps is defined but empty for each model
   */
  test("handles schema without array references", () => {
    const schema = {
      $defs: {
        Simple: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" as const }
          },
          required: ["id", "name"]
        }
      }
    }

    const testDomain = domain({
      name: "test-no-array-refs",
      from: schema
    })

    const store = testDomain.createStore({
      context: { schemaName: "test-no-array-refs" }
    } as any)

    const env = getEnv<any>(store)

    // Should still be defined, just empty
    expect(env.context.arrayReferenceMaps).toBeDefined()
    expect(env.context.arrayReferenceMaps.Simple).toEqual({})
  })

  /**
   * Test: arrayReferenceMaps exists alongside other maps
   * Given: Schema with array references
   * Then: columnPropertyMaps, propertyTypeMaps, and arrayReferenceMaps all exist
   */
  test("arrayReferenceMaps coexists with other context maps", () => {
    const schema = {
      $defs: {
        Team: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" as const },
            members: {
              type: "array" as const,
              items: { type: "string" as const },
              "x-reference-type": "array",
              "x-reference-target": "User"
            }
          },
          required: ["id", "name"]
        },
        User: {
          type: "object" as const,
          properties: {
            id: { type: "string" as const, format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" as const }
          },
          required: ["id", "name"]
        }
      }
    }

    const testDomain = domain({
      name: "test-all-maps",
      from: schema
    })

    const store = testDomain.createStore({
      context: { schemaName: "test-all-maps" }
    } as any)

    const env = getEnv<any>(store)

    // All three maps should exist
    expect(env.context.columnPropertyMaps).toBeDefined()
    expect(env.context.propertyTypeMaps).toBeDefined()
    expect(env.context.arrayReferenceMaps).toBeDefined()

    // Verify columnPropertyMaps has expected data
    expect(env.context.columnPropertyMaps.Team.id).toBe("id")
    expect(env.context.columnPropertyMaps.Team.name).toBe("name")

    // Verify propertyTypeMaps has expected data
    expect(env.context.propertyTypeMaps.Team.id).toBe("string")
    expect(env.context.propertyTypeMaps.Team.name).toBe("string")
  })
})
