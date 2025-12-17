/**
 * Unit tests for DDL utility functions
 *
 * Tests topological sorting for table dependency ordering and string utilities.
 */

import { describe, test, expect } from "bun:test"
import { topologicalSort, toSnakeCase } from "../utils"

describe("topologicalSort", () => {
  /**
   * Test: Topological sort with FK dependencies
   * Given: Organization model with no FK dependencies, Team model with FK to Organization
   * When: topologicalSort is called with both models
   * Then: Returns ['Organization', 'Team'], Organization appears before Team
   */
  test("returns models in dependency order with Organization before Team", () => {
    const models = {
      Organization: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
        },
      },
      Team: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
          organizationId: {
            type: "string",
            "x-mst-type": "reference",
            "x-reference-type": "single",
            "x-reference-target": "Organization",
          },
        },
      },
    }

    const result = topologicalSort(models)

    expect(result).toEqual(["Organization", "Team"])
    expect(result.indexOf("Organization")).toBeLessThan(result.indexOf("Team"))
  })

  /**
   * Test: Self-referential FK does not break ordering
   * Given: Team model with self-reference via parentId
   * When: topologicalSort is called
   * Then: Returns ['Team'], self-reference does not cause infinite loop or error
   */
  test("handles self-referential FK without infinite loop", () => {
    const models = {
      Team: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          name: { type: "string" },
          parentId: {
            type: "string",
            "x-mst-type": "maybe-reference",
            "x-reference-type": "single",
            "x-reference-target": "Team",
          },
        },
      },
    }

    const result = topologicalSort(models)

    expect(result).toEqual(["Team"])
    // Should not throw or hang
  })

  /**
   * Test: Detect circular dependencies
   * Given: ModelA with FK to ModelB, ModelB with FK to ModelA (circular dependency)
   * When: topologicalSort is called
   * Then: Throws error describing the circular dependency with both model names
   */
  test("detects circular dependencies and throws error", () => {
    const models = {
      ModelA: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          modelBId: {
            type: "string",
            "x-mst-type": "reference",
            "x-reference-type": "single",
            "x-reference-target": "ModelB",
          },
        },
      },
      ModelB: {
        type: "object",
        properties: {
          id: { type: "string", "x-mst-type": "identifier" },
          modelAId: {
            type: "string",
            "x-mst-type": "reference",
            "x-reference-type": "single",
            "x-reference-target": "ModelA",
          },
        },
      },
    }

    expect(() => topologicalSort(models)).toThrow(/circular/i)
    expect(() => topologicalSort(models)).toThrow(/ModelA/)
    expect(() => topologicalSort(models)).toThrow(/ModelB/)
  })
})

describe("toSnakeCase", () => {
  /**
   * Test: Convert PascalCase to snake_case for column names
   * Given: toSnakeCase function is available
   * When: toSnakeCase is called with various inputs
   * Then: Converts correctly (Organization→organization, TeamMember→team_member, organizationId→organization_id)
   */
  test("converts PascalCase to snake_case", () => {
    expect(toSnakeCase("Organization")).toBe("organization")
  })

  test("converts compound PascalCase to snake_case", () => {
    expect(toSnakeCase("TeamMember")).toBe("team_member")
  })

  test("converts camelCase to snake_case", () => {
    expect(toSnakeCase("organizationId")).toBe("organization_id")
  })

  test("handles already snake_case strings", () => {
    expect(toSnakeCase("already_snake")).toBe("already_snake")
  })

  test("handles single lowercase word", () => {
    expect(toSnakeCase("user")).toBe("user")
  })

  test("handles consecutive capitals", () => {
    expect(toSnakeCase("HTTPSConnection")).toBe("https_connection")
  })
})
