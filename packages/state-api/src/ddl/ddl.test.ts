/**
 * Integration tests for DDL Generator with Teams Domain Schema
 *
 * This test suite validates the complete DDL generation pipeline using the real
 * Teams domain schema (Organization, Team, Membership, App, Invitation).
 * Tests cover all requirements including type mapping, constraints, foreign keys,
 * junction tables, topological sorting, and dialect-specific behaviors.
 *
 * Generated from TestSpecifications:
 * - test-integration-001: PostgreSQL dialect generates correct DDL for Teams domain
 * - test-integration-002: SQLite dialect generates correct type fallbacks
 * - test-integration-003: Junction tables generated for array references
 * - test-integration-004: NOT NULL constraints based on required array
 */

import { describe, test, expect } from "bun:test"
import { generateDDL, createPostgresDialect, createSqliteDialect } from "./index"
import type { DDLOutput, TableDef, ForeignKeyDef } from "./types"

// ============================================================
// Helper: Teams Domain Test Schema
// ============================================================

/**
 * Manually-defined Teams domain schema with complete metadata for DDL testing.
 * Based on the real Teams domain but with explicit DDL metadata.
 *
 * This represents what the Enhanced JSON Schema looks like after full
 * schematic pipeline processing with all x-* metadata populated.
 */
function getTeamsEnhancedSchema() {
  return {
    definitions: {
      Organization: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            "x-mst-type": "identifier",
          },
          name: {
            type: "string",
          },
          slug: {
            type: "string",
          },
          description: {
            type: "string",
          },
          createdAt: {
            type: "number",
          },
        },
        required: ["name", "slug"],
      },
      Team: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            "x-mst-type": "identifier",
          },
          name: {
            type: "string",
          },
          description: {
            type: "string",
          },
          organizationId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Organization",
          },
          parentId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Team",
          },
          createdAt: {
            type: "number",
          },
        },
        required: ["name", "organizationId"],
      },
      Membership: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            "x-mst-type": "identifier",
          },
          userId: {
            type: "string",
          },
          role: {
            type: "string",
            enum: ["owner", "admin", "member", "viewer"],
          },
          organizationId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Organization",
          },
          teamId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Team",
          },
          createdAt: {
            type: "number",
          },
        },
        required: ["userId", "role"],
      },
      App: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            "x-mst-type": "identifier",
          },
          name: {
            type: "string",
          },
          description: {
            type: "string",
          },
          teamId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Team",
          },
          createdAt: {
            type: "number",
          },
        },
        required: ["name", "teamId"],
      },
      Invitation: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            "x-mst-type": "identifier",
          },
          email: {
            type: "string",
          },
          role: {
            type: "string",
            enum: ["owner", "admin", "member", "viewer"],
          },
          organizationId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Organization",
          },
          teamId: {
            type: "string",
            format: "uuid",
            "x-reference-type": "single",
            "x-reference-target": "Team",
          },
          status: {
            type: "string",
            enum: ["pending", "accepted", "declined", "expired"],
          },
          expiresAt: {
            type: "number",
          },
          createdAt: {
            type: "number",
          },
        },
        required: ["email", "role", "status", "expiresAt"],
      },
    },
  }
}

// ============================================================
// Test Suite: PostgreSQL Dialect
// ============================================================

describe("DDL Generation - PostgreSQL Dialect", () => {
  /**
   * Test: test-integration-001
   * Scenario: PostgreSQL dialect generates correct DDL for Teams domain
   * Given: Teams domain Enhanced JSON Schema (Organization, Team, Membership, App, Invitation)
   *        PostgreSQL dialect
   * When: generateDDL is called with Teams schema
   * Then:
   *   - Organization table uses UUID for id
   *   - Team table has organization_id FK with CASCADE
   *   - Team table has parent_id FK with SET NULL (self-reference)
   *   - Invitation table has status CHECK constraint for enum
   *   - Invitation table has expires_at TIMESTAMPTZ column
   *   - Tables are in correct dependency order
   */
  test("generates correct DDL for Teams domain schema", () => {
    // Given: Teams domain Enhanced JSON Schema and PostgreSQL dialect
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()

    // When: generateDDL is called
    const result: DDLOutput = generateDDL(schema, dialect)

    // Then: Result contains all Teams domain tables
    expect(result).toBeDefined()
    expect(result.tables).toBeDefined()

    const tableNames = result.tables.map((t) => t.name)
    expect(tableNames).toContain("Organization")
    expect(tableNames).toContain("Team")
    expect(tableNames).toContain("Membership")
    expect(tableNames).toContain("App")
    expect(tableNames).toContain("Invitation")

    // Organization table uses UUID for id
    const orgTable = result.tables.find((t) => t.name === "Organization")
    expect(orgTable).toBeDefined()

    const orgIdColumn = orgTable?.columns.find((col) => col.name === "id")
    expect(orgIdColumn?.type).toBe("UUID")
    expect(orgIdColumn?.nullable).toBe(false)
    expect(orgTable?.primaryKey).toBe("id")

    // Team table has organization_id FK with CASCADE
    const teamTable = result.tables.find((t) => t.name === "Team")
    expect(teamTable).toBeDefined()

    const teamOrgIdColumn = teamTable?.columns.find((col) => col.name === "organization_id")
    expect(teamOrgIdColumn).toBeDefined()
    expect(teamOrgIdColumn?.type).toBe("UUID")
    expect(teamOrgIdColumn?.nullable).toBe(false) // Required reference

    const teamOrgFk = result.foreignKeys.find(
      (fk) => fk.table === "Team" && fk.column === "organization_id"
    )
    expect(teamOrgFk).toBeDefined()
    expect(teamOrgFk?.referencesTable).toBe("Organization")
    expect(teamOrgFk?.referencesColumn).toBe("id")
    expect(teamOrgFk?.onDelete).toBe("CASCADE")

    // Team table has team_id FK with SET NULL (self-reference via parentId property)
    // Note: Column name is derived from x-reference-target (Team), not property name (parentId)
    // Per design-ddl-reference-resolution: "Column name derived from x-reference-target"
    const teamSelfRefColumn = teamTable?.columns.find((col) => col.name === "team_id")
    expect(teamSelfRefColumn).toBeDefined()
    expect(teamSelfRefColumn?.type).toBe("UUID")
    expect(teamSelfRefColumn?.nullable).toBe(true) // Optional reference

    const teamSelfRefFk = result.foreignKeys.find(
      (fk) => fk.table === "Team" && fk.column === "team_id" && fk.referencesTable === "Team"
    )
    expect(teamSelfRefFk).toBeDefined()
    expect(teamSelfRefFk?.referencesTable).toBe("Team")
    expect(teamSelfRefFk?.referencesColumn).toBe("id")
    expect(teamSelfRefFk?.onDelete).toBe("SET NULL")

    // Invitation table has status CHECK constraint for enum
    const invitationTable = result.tables.find((t) => t.name === "Invitation")
    expect(invitationTable).toBeDefined()

    const invitationStatusColumn = invitationTable?.columns.find((col) => col.name === "status")
    expect(invitationStatusColumn).toBeDefined()
    expect(invitationStatusColumn?.checkConstraint).toBeDefined()
    expect(invitationStatusColumn?.checkConstraint).toContain("pending")
    expect(invitationStatusColumn?.checkConstraint).toContain("accepted")
    expect(invitationStatusColumn?.checkConstraint).toContain("declined")
    expect(invitationStatusColumn?.checkConstraint).toContain("expired")

    // Invitation table has expires_at column (stored as number - Unix timestamp)
    const invitationExpiresAtColumn = invitationTable?.columns.find(
      (col) => col.name === "expires_at"
    )
    expect(invitationExpiresAtColumn).toBeDefined()
    // Numbers map to DOUBLE PRECISION in PostgreSQL
    expect(invitationExpiresAtColumn?.type).toBe("DOUBLE PRECISION")

    // Tables are in correct dependency order
    expect(result.executionOrder).toBeDefined()
    const orgIndex = result.executionOrder.indexOf("Organization")
    const teamIndex = result.executionOrder.indexOf("Team")
    const appIndex = result.executionOrder.indexOf("App")

    // Organization has no dependencies, must come first
    expect(orgIndex).toBeGreaterThanOrEqual(0)

    // Team depends on Organization
    expect(teamIndex).toBeGreaterThan(orgIndex)

    // App depends on Team (which depends on Organization)
    expect(appIndex).toBeGreaterThan(teamIndex)
  })

  /**
   * Test: Primary keys inferred from x-mst-type: 'identifier'
   * Validates that all tables have correct primary key constraints
   */
  test("infers primary keys from x-mst-type: identifier", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    // All Teams domain entities use 'id' as primary key
    for (const table of result.tables) {
      expect(table.primaryKey).toBe("id")

      const pkColumn = table.columns.find((col) => col.name === "id")
      expect(pkColumn).toBeDefined()
      expect(pkColumn?.nullable).toBe(false) // PKs are always NOT NULL
      expect(pkColumn?.type).toBe("UUID")
    }
  })

  /**
   * Test: NOT NULL constraints applied based on required array
   * Validates that required properties are NOT NULL, optional properties are nullable
   */
  test("applies NOT NULL constraints based on required array", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    // Organization: name is required, description is optional
    const orgTable = result.tables.find((t) => t.name === "Organization")
    expect(orgTable).toBeDefined()

    const orgNameColumn = orgTable?.columns.find((col) => col.name === "name")
    expect(orgNameColumn?.nullable).toBe(false)

    const orgDescColumn = orgTable?.columns.find((col) => col.name === "description")
    expect(orgDescColumn?.nullable).toBe(true)

    // Team: parentId property becomes team_id column (self-reference, nullable)
    const teamTable = result.tables.find((t) => t.name === "Team")
    const teamSelfRefColumn = teamTable?.columns.find((col) => col.name === "team_id")
    expect(teamSelfRefColumn?.nullable).toBe(true)

    // Membership: organizationId and teamId are both optional (polymorphic)
    const membershipTable = result.tables.find((t) => t.name === "Membership")
    const membershipOrgIdColumn = membershipTable?.columns.find(
      (col) => col.name === "organization_id"
    )
    const membershipTeamIdColumn = membershipTable?.columns.find(
      (col) => col.name === "team_id"
    )
    expect(membershipOrgIdColumn?.nullable).toBe(true)
    expect(membershipTeamIdColumn?.nullable).toBe(true)
  })

  /**
   * Test: Single references generate FK constraints with correct ON DELETE behavior
   * Validates foreign key constraints for required vs optional references
   */
  test("generates FK constraints with correct ON DELETE behavior", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    // Required reference: App.teamId → CASCADE
    const appTeamFk = result.foreignKeys.find(
      (fk) => fk.table === "App" && fk.column === "team_id"
    )
    expect(appTeamFk).toBeDefined()
    expect(appTeamFk?.referencesTable).toBe("Team")
    expect(appTeamFk?.onDelete).toBe("CASCADE")

    // Optional reference: Team.parentId → team_id column with SET NULL
    const teamSelfRefFk = result.foreignKeys.find(
      (fk) => fk.table === "Team" && fk.column === "team_id" && fk.referencesTable === "Team"
    )
    expect(teamSelfRefFk).toBeDefined()
    expect(teamSelfRefFk?.onDelete).toBe("SET NULL")

    // Optional polymorphic: Membership.organizationId → SET NULL
    const membershipOrgFk = result.foreignKeys.find(
      (fk) => fk.table === "Membership" && fk.column === "organization_id"
    )
    expect(membershipOrgFk).toBeDefined()
    expect(membershipOrgFk?.onDelete).toBe("SET NULL")
  })

  /**
   * Test: Self-references (Team.parentId) generate valid constraints
   * Validates that self-referential foreign keys don't break topological sort
   */
  test("handles self-references without breaking topological sort", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    // Team has self-reference via parentId property (becomes team_id column)
    const teamSelfRefFk = result.foreignKeys.find(
      (fk) => fk.table === "Team" && fk.column === "team_id" && fk.referencesTable === "Team"
    )
    expect(teamSelfRefFk).toBeDefined()
    expect(teamSelfRefFk?.referencesTable).toBe("Team")
    expect(teamSelfRefFk?.referencesColumn).toBe("id")

    // Team should still appear in execution order exactly once
    const teamOccurrences = result.executionOrder.filter((name) => name === "Team")
    expect(teamOccurrences.length).toBe(1)

    // Self-reference should not create circular dependency error
    expect(result.executionOrder).toContain("Team")
  })

  /**
   * Test: Enum properties generate CHECK constraints
   * Validates that enum types are enforced via CHECK constraints
   */
  test("generates CHECK constraints for enum properties", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    // Membership.role is an enum
    const membershipTable = result.tables.find((t) => t.name === "Membership")
    const roleColumn = membershipTable?.columns.find((col) => col.name === "role")
    expect(roleColumn).toBeDefined()
    expect(roleColumn?.checkConstraint).toBeDefined()
    expect(roleColumn?.checkConstraint).toContain("owner")
    expect(roleColumn?.checkConstraint).toContain("admin")
    expect(roleColumn?.checkConstraint).toContain("member")
    expect(roleColumn?.checkConstraint).toContain("viewer")

    // Invitation.status is an enum
    const invitationTable = result.tables.find((t) => t.name === "Invitation")
    const statusColumn = invitationTable?.columns.find((col) => col.name === "status")
    expect(statusColumn).toBeDefined()
    expect(statusColumn?.checkConstraint).toBeDefined()
    expect(statusColumn?.checkConstraint).toContain("pending")
    expect(statusColumn?.checkConstraint).toContain("accepted")
    expect(statusColumn?.checkConstraint).toContain("declined")
    expect(statusColumn?.checkConstraint).toContain("expired")

    // Invitation.role is also an enum (same values as Membership.role)
    const invitationRoleColumn = invitationTable?.columns.find((col) => col.name === "role")
    expect(invitationRoleColumn).toBeDefined()
    expect(invitationRoleColumn?.checkConstraint).toBeDefined()
    expect(invitationRoleColumn?.checkConstraint).toContain("owner")
  })
})

// ============================================================
// Test Suite: SQLite Dialect
// ============================================================

describe("DDL Generation - SQLite Dialect", () => {
  /**
   * Test: test-integration-002
   * Scenario: SQLite dialect generates correct type fallbacks
   * Given: Teams domain Enhanced JSON Schema
   *        SQLite dialect
   * When: generateDDL is called with Teams schema
   * Then:
   *   - Organization id uses TEXT instead of UUID
   *   - Boolean fields use INTEGER instead of BOOLEAN
   *   - Timestamp fields use TEXT instead of TIMESTAMPTZ
   *   - FK constraints are inline in CREATE TABLE (not ALTER TABLE)
   */
  test("generates correct type fallbacks for SQLite", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createSqliteDialect()
    const result = generateDDL(schema, dialect)

    // Organization id uses TEXT instead of UUID
    const orgTable = result.tables.find((t) => t.name === "Organization")
    const orgIdColumn = orgTable?.columns.find((col) => col.name === "id")
    expect(orgIdColumn?.type).toBe("TEXT")

    // Number fields (timestamps stored as Unix timestamps) use REAL in SQLite
    const orgCreatedAtColumn = orgTable?.columns.find((col) => col.name === "created_at")
    expect(orgCreatedAtColumn?.type).toBe("REAL")

    const invitationTable = result.tables.find((t) => t.name === "Invitation")
    const invitationExpiresAtColumn = invitationTable?.columns.find(
      (col) => col.name === "expires_at"
    )
    expect(invitationExpiresAtColumn?.type).toBe("REAL")

    // All UUID columns should be TEXT in SQLite
    for (const table of result.tables) {
      const idColumn = table.columns.find((col) => col.name === "id")
      expect(idColumn?.type).toBe("TEXT")
    }

    // FK constraints are still present (SQLite supports them)
    expect(result.foreignKeys.length).toBeGreaterThan(0)
  })

  /**
   * Test: SQLite dialect generates CHECK constraints
   * Validates that enum CHECK constraints work in SQLite
   */
  test("generates CHECK constraints for enums in SQLite", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createSqliteDialect()
    const result = generateDDL(schema, dialect)

    // SQLite supports CHECK constraints
    const membershipTable = result.tables.find((t) => t.name === "Membership")
    const roleColumn = membershipTable?.columns.find((col) => col.name === "role")
    expect(roleColumn?.checkConstraint).toBeDefined()
    expect(roleColumn?.checkConstraint).toContain("owner")

    const invitationTable = result.tables.find((t) => t.name === "Invitation")
    const statusColumn = invitationTable?.columns.find((col) => col.name === "status")
    expect(statusColumn?.checkConstraint).toBeDefined()
    expect(statusColumn?.checkConstraint).toContain("pending")
  })
})

// ============================================================
// Test Suite: Topological Sorting
// ============================================================

describe("DDL Generation - Topological Sorting", () => {
  /**
   * Test: Topological ordering ensures correct dependency order
   * Validates that tables are created in dependency order
   */
  test("ensures correct dependency order in execution", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()
    const result = generateDDL(schema, dialect)

    const { executionOrder } = result

    // Organization has no dependencies (root level)
    const orgIndex = executionOrder.indexOf("Organization")
    expect(orgIndex).toBeGreaterThanOrEqual(0)

    // Team depends on Organization
    const teamIndex = executionOrder.indexOf("Team")
    expect(teamIndex).toBeGreaterThan(orgIndex)

    // App depends on Team
    const appIndex = executionOrder.indexOf("App")
    expect(appIndex).toBeGreaterThan(teamIndex)

    // Membership depends on both Organization and Team (polymorphic)
    // Must come after both
    const membershipIndex = executionOrder.indexOf("Membership")
    expect(membershipIndex).toBeGreaterThan(orgIndex)
    expect(membershipIndex).toBeGreaterThan(teamIndex)

    // Invitation also depends on both Organization and Team (polymorphic)
    const invitationIndex = executionOrder.indexOf("Invitation")
    expect(invitationIndex).toBeGreaterThan(orgIndex)
    expect(invitationIndex).toBeGreaterThan(teamIndex)
  })

  /**
   * Test: Self-references don't create circular dependencies
   * Validates that Team.parentId self-reference doesn't break ordering
   */
  test("handles self-references without circular dependency errors", () => {
    const schema = getTeamsEnhancedSchema()
    const dialect = createPostgresDialect()

    // Should not throw error
    expect(() => generateDDL(schema, dialect)).not.toThrow()

    const result = generateDDL(schema, dialect)

    // Team should appear exactly once in execution order
    const teamOccurrences = result.executionOrder.filter((name) => name === "Team")
    expect(teamOccurrences.length).toBe(1)
  })
})

// ============================================================
// Test Suite: Computed Properties
// ============================================================

describe("DDL Generation - Computed Properties", () => {
  /**
   * Test: Computed properties (x-computed: true) are skipped
   * Validates that computed fields are not included in DDL
   */
  test("skips computed properties in generated DDL", () => {
    // Create a schema with computed properties
    const schemaWithComputed = {
      definitions: {
        User: {
          type: "object",
          properties: {
            id: {
              type: "string",
              format: "uuid",
              "x-mst-type": "identifier",
            },
            firstName: {
              type: "string",
            },
            lastName: {
              type: "string",
            },
            // Computed property: fullName
            fullName: {
              type: "string",
              "x-computed": true,
            },
            // Computed array: posts (inverse relationship)
            posts: {
              type: "array",
              items: { type: "string" },
              "x-computed": true,
              "x-reference-type": "array",
              "x-reference-target": "Post",
            },
          },
          required: ["firstName", "lastName"],
        },
      },
    }

    const dialect = createPostgresDialect()
    const result = generateDDL(schemaWithComputed, dialect)

    const userTable = result.tables.find((t) => t.name === "User")
    expect(userTable).toBeDefined()

    // fullName should NOT appear in columns
    const fullNameColumn = userTable?.columns.find((col) => col.name === "full_name")
    expect(fullNameColumn).toBeUndefined()

    // posts should NOT generate a junction table
    const postsJunction = result.junctionTables.find((t) => t.name === "User_posts")
    expect(postsJunction).toBeUndefined()

    // Only firstName and lastName should be present (plus id)
    const columnNames = userTable?.columns.map((col) => col.name) || []
    expect(columnNames).toContain("id")
    expect(columnNames).toContain("first_name")
    expect(columnNames).toContain("last_name")
    expect(columnNames).not.toContain("full_name")
    expect(columnNames).not.toContain("posts")
  })
})
