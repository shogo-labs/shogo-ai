/**
 * Column Naming Helper Tests
 *
 * Tests for getColumnName() - the single source of truth for computing
 * SQL column names from Enhanced JSON Schema property definitions.
 *
 * Follows DDL convention:
 * - Regular properties: snake_case of property name
 * - Single references: snake_case(target) + "_id"
 * - Array references: snake_case of property name (junction tables handle FKs)
 */

import { describe, test, expect } from "bun:test"
import { getColumnName } from "../utils"

describe("getColumnName()", () => {
  describe("regular properties", () => {
    test("returns snake_case of property name", () => {
      expect(getColumnName("firstName")).toBe("first_name")
    })

    test("handles single word property", () => {
      expect(getColumnName("name")).toBe("name")
    })

    test("handles camelCase with multiple words", () => {
      expect(getColumnName("createdAt")).toBe("created_at")
      expect(getColumnName("updatedByUserId")).toBe("updated_by_user_id")
    })

    test("handles PascalCase property names", () => {
      expect(getColumnName("Organization")).toBe("organization")
    })

    test("handles consecutive capitals (acronyms)", () => {
      expect(getColumnName("HTTPSUrl")).toBe("https_url")
      expect(getColumnName("userID")).toBe("user_id")
    })
  })

  describe("single reference properties", () => {
    test("returns target_id for single reference", () => {
      expect(getColumnName("organization", "Organization", "single")).toBe("organization_id")
    })

    test("self-reference uses target name, not property name", () => {
      // parentId property references Team model -> column should be team_id, NOT parent_id
      expect(getColumnName("parentId", "Team", "single")).toBe("team_id")
    })

    test("handles different property and target names", () => {
      // owningOrg property references Organization model -> organization_id
      expect(getColumnName("owningOrg", "Organization", "single")).toBe("organization_id")
    })

    test("handles PascalCase target names", () => {
      expect(getColumnName("client", "ClientCompany", "single")).toBe("client_company_id")
    })
  })

  describe("array reference properties", () => {
    test("returns snake_case of property name (no _id suffix)", () => {
      // Array references use junction tables, not FK columns
      expect(getColumnName("members", "User", "array")).toBe("members")
    })

    test("handles camelCase array property names", () => {
      expect(getColumnName("teamMembers", "User", "array")).toBe("team_members")
    })
  })

  describe("edge cases", () => {
    test("undefined xReferenceType treated as regular property", () => {
      expect(getColumnName("organization", "Organization", undefined)).toBe("organization")
    })

    test("undefined xReferenceTarget with single type treated as regular property", () => {
      expect(getColumnName("organization", undefined, "single")).toBe("organization")
    })

    test("empty string target treated as regular property", () => {
      expect(getColumnName("organization", "", "single")).toBe("organization")
    })
  })
})
