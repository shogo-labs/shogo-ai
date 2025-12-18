/**
 * Column Property Map Computation Tests
 *
 * Tests for computeColumnPropertyMaps() - computes column → property mappings
 * from Enhanced JSON Schema for all models. Used by domain() to pre-compute
 * mappings that enable createStore() to work with SQL backends.
 */

import { describe, test, expect } from "bun:test"
import { computeColumnPropertyMaps } from "../utils"

describe("computeColumnPropertyMaps()", () => {
  describe("basic schema", () => {
    test("computes maps for all models in schema", () => {
      const schema = {
        $defs: {
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
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      expect(Object.keys(maps)).toHaveLength(2)
      expect(maps.Organization).toBeDefined()
      expect(maps.Team).toBeDefined()
    })

    test("regular properties map to snake_case columns", () => {
      const schema = {
        $defs: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              firstName: { type: "string" },
              lastName: { type: "string" },
              createdAt: { type: "number" },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      expect(maps.User).toEqual({
        id: "id",
        first_name: "firstName",
        last_name: "lastName",
        created_at: "createdAt",
      })
    })
  })

  describe("reference properties", () => {
    test("single reference maps to target_id column", () => {
      const schema = {
        $defs: {
          Organization: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          Team: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              organizationId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Organization",
              },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      // organizationId property -> organization_id column
      expect(maps.Team.organization_id).toBe("organizationId")
    })

    test("self-reference uses target name for column", () => {
      const schema = {
        $defs: {
          Team: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              parentId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Team",
              },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      // parentId property -> team_id column (NOT parent_id!)
      expect(maps.Team.team_id).toBe("parentId")
      expect(maps.Team.parent_id).toBeUndefined()
    })

    test("array references do not add _id suffix", () => {
      const schema = {
        $defs: {
          Team: {
            type: "object",
            properties: {
              id: { type: "string" },
              members: {
                type: "array",
                "x-reference-type": "array",
                "x-reference-target": "User",
              },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      // Array refs don't have FK columns (use junction tables)
      expect(maps.Team.members).toBe("members")
      expect(maps.Team.user_id).toBeUndefined()
    })
  })

  describe("edge cases", () => {
    test("returns empty object for schema with no models", () => {
      const schema = { $defs: {} }
      const maps = computeColumnPropertyMaps(schema)
      expect(maps).toEqual({})
    })

    test("returns empty map for model with no properties", () => {
      const schema = {
        $defs: {
          EmptyModel: {
            type: "object",
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)
      expect(maps.EmptyModel).toEqual({})
    })

    test("handles schema using definitions instead of $defs", () => {
      const schema = {
        definitions: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)
      expect(maps.User).toEqual({
        id: "id",
        name: "name",
      })
    })
  })

  describe("real-world schema", () => {
    test("handles TeamsDomain-like schema correctly", () => {
      const schema = {
        $defs: {
          Organization: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              slug: { type: "string" },
            },
          },
          Team: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              organizationId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Organization",
              },
              parentId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Team",
              },
              createdAt: { type: "number" },
            },
          },
          Membership: {
            type: "object",
            properties: {
              id: { type: "string" },
              userId: { type: "string" },
              role: { type: "string" },
              organizationId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Organization",
              },
              teamId: {
                type: "string",
                "x-reference-type": "single",
                "x-reference-target": "Team",
              },
            },
          },
        },
      }

      const maps = computeColumnPropertyMaps(schema)

      // Organization - regular properties
      expect(maps.Organization).toEqual({
        id: "id",
        name: "name",
        slug: "slug",
      })

      // Team - regular + references + self-reference
      expect(maps.Team).toEqual({
        id: "id",
        name: "name",
        organization_id: "organizationId",
        team_id: "parentId", // Self-ref: parentId -> team_id
        created_at: "createdAt",
      })

      // Membership - regular + two references
      expect(maps.Membership).toEqual({
        id: "id",
        user_id: "userId",
        role: "role",
        organization_id: "organizationId",
        team_id: "teamId",
      })
    })
  })
})
