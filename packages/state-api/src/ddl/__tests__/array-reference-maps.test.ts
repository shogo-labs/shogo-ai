/**
 * Unit tests for computeArrayReferenceMaps()
 *
 * Tests extraction of array reference metadata from Enhanced JSON Schema
 * for use in SQL junction table hydration.
 */

import { describe, test, expect } from "bun:test"
import { computeArrayReferenceMaps } from "../utils"

describe("computeArrayReferenceMaps", () => {
  /**
   * Test: Basic array reference extraction
   * Given: Schema with Team.members -> User array reference
   * Then: Returns junction table metadata with correct naming
   */
  test("extracts array reference metadata from schema", () => {
    const schema = {
      $defs: {
        Team: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            members: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User"
            }
          }
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Team).toBeDefined()
    expect(maps.Team.members).toEqual({
      junctionTable: "team_members",
      sourceColumn: "team_id",
      targetColumn: "user_id",
      targetModel: "User",
      isSelfReference: false
    })
  })

  /**
   * Test: Self-referential array reference
   * Given: Category.subcategories -> Category (self-reference)
   * Then: Uses source_/target_ prefixes for column naming
   */
  test("handles self-referential array references", () => {
    const schema = {
      $defs: {
        Category: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            subcategories: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "Category"
            }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Category.subcategories).toEqual({
      junctionTable: "category_subcategories",
      sourceColumn: "source_category_id",
      targetColumn: "target_category_id",
      targetModel: "Category",
      isSelfReference: true
    })
  })

  /**
   * Test: Skip computed array properties
   * Given: Property with x-computed: true (inverse relationship)
   * Then: Property is not included in the map
   */
  test("skips computed array properties", () => {
    const schema = {
      $defs: {
        Team: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            users: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User",
              "x-computed": true
            }
          }
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Team?.users).toBeUndefined()
  })

  /**
   * Test: Skip regular arrays without x-reference-type
   * Given: Regular array property (e.g., tags: string[])
   * Then: Property is not included in the map
   */
  test("skips properties without x-reference-type array", () => {
    const schema = {
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            tags: {
              type: "array",
              items: { type: "string" }
            }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.User?.tags).toBeUndefined()
  })

  /**
   * Test: Multiple array references on same model
   * Given: Team with both members and admins array refs
   * Then: Both are captured with distinct junction tables
   */
  test("handles multiple array references on same model", () => {
    const schema = {
      $defs: {
        Team: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            members: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User"
            },
            admins: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User"
            }
          }
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Team.members.junctionTable).toBe("team_members")
    expect(maps.Team.admins.junctionTable).toBe("team_admins")
    expect(maps.Team.members.targetModel).toBe("User")
    expect(maps.Team.admins.targetModel).toBe("User")
  })

  /**
   * Test: Empty result for schema without array references
   * Given: Schema with only simple properties
   * Then: Returns object with empty model entries
   */
  test("returns empty object for models without array references", () => {
    const schema = {
      $defs: {
        Simple: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Simple).toEqual({})
  })

  /**
   * Test: Supports both $defs and definitions
   * Given: Schema using 'definitions' key (older JSON Schema style)
   * Then: Works the same as $defs
   */
  test("supports definitions key as well as $defs", () => {
    const schema = {
      definitions: {
        Team: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            members: {
              type: "array",
              items: { type: "string" },
              "x-reference-type": "array",
              "x-reference-target": "User"
            }
          }
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" }
          }
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.Team.members).toBeDefined()
    expect(maps.Team.members.junctionTable).toBe("team_members")
  })

  /**
   * Test: Real-world example - ImplementationTask.dependencies
   * Given: Schema matching the platform-features pattern
   * Then: Correctly extracts self-referential dependencies
   */
  test("handles ImplementationTask.dependencies pattern", () => {
    const schema = {
      $defs: {
        ImplementationTask: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" },
            dependencies: {
              type: "array",
              description: "Tasks that must complete before this one",
              items: { type: "string" },
              "x-mst-type": "reference",
              "x-reference-type": "array",
              "x-reference-target": "ImplementationTask"
            }
          },
          required: ["id", "title"]
        }
      }
    }

    const maps = computeArrayReferenceMaps(schema)

    expect(maps.ImplementationTask.dependencies).toEqual({
      junctionTable: "implementation_task_dependencies",
      sourceColumn: "source_implementation_task_id",
      targetColumn: "target_implementation_task_id",
      targetModel: "ImplementationTask",
      isSelfReference: true
    })
  })
})
