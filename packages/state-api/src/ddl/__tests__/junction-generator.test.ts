/**
 * Generated from TestSpecification: test-junction-001
 * Task: task-ddl-junction-generator
 * Requirement: req-ddl-junction-tables
 *
 * Tests the junction table generator that creates many-to-many relationship tables
 * from Enhanced JSON Schema properties with x-reference-type: "array".
 */

import { describe, test, expect } from "bun:test"
import { generateJunctionTable } from "../junction-generator"
import { createPostgresDialect } from "../dialect"
import type { TableDef } from "../types"

describe("Generate junction table for array reference", () => {
  // Given: Team model with members property
  // members has x-reference-type: 'array' and x-reference-target: 'User'
  const teamModel = {
    properties: {
      id: {
        type: "string",
        format: "uuid",
        "x-mst-type": "identifier",
      },
      name: {
        type: "string",
      },
      members: {
        type: "array",
        items: {
          type: "string",
        },
        "x-reference-type": "array",
        "x-reference-target": "User",
      },
    },
    required: ["id", "name"],
  }

  const membersProperty = {
    name: "members",
    type: "array",
    items: {
      type: "string",
    },
    "x-reference-type": "array",
    "x-reference-target": "User",
  }

  const dialect = createPostgresDialect()

  test("When generateJunctionTable is called -> Returns TableDef with name 'Team_members'", () => {
    // When
    const result = generateJunctionTable("Team", membersProperty, dialect)

    // Then: Returns TableDef with name 'Team_members'
    expect(result).toBeDefined()
    expect(result!.name).toBe("Team_members")
  })

  test("When generateJunctionTable is called -> Includes column 'team_id' NOT NULL with FK to Team", () => {
    // When
    const result = generateJunctionTable("Team", membersProperty, dialect)

    // Then: Includes column 'team_id' NOT NULL with FK to Team
    const teamIdColumn = result!.columns.find((col) => col.name === "team_id")
    expect(teamIdColumn).toBeDefined()
    expect(teamIdColumn?.nullable).toBe(false)

    const teamFk = result!.foreignKeys.find(
      (fk) => fk.column === "team_id" && fk.referencesTable === "Team"
    )
    expect(teamFk).toBeDefined()
    expect(teamFk?.referencesColumn).toBe("id")
  })

  test("When generateJunctionTable is called -> Includes column 'user_id' NOT NULL with FK to User", () => {
    // When
    const result = generateJunctionTable("Team", membersProperty, dialect)

    // Then: Includes column 'user_id' NOT NULL with FK to User
    const userIdColumn = result!.columns.find((col) => col.name === "user_id")
    expect(userIdColumn).toBeDefined()
    expect(userIdColumn?.nullable).toBe(false)

    const userFk = result!.foreignKeys.find(
      (fk) => fk.column === "user_id" && fk.referencesTable === "User"
    )
    expect(userFk).toBeDefined()
    expect(userFk?.referencesColumn).toBe("id")
  })

  test("When generateJunctionTable is called -> Both FKs have ON DELETE CASCADE", () => {
    // When
    const result = generateJunctionTable("Team", membersProperty, dialect)

    // Then: Both FKs have ON DELETE CASCADE
    const teamFk = result!.foreignKeys.find((fk) => fk.column === "team_id")
    const userFk = result!.foreignKeys.find((fk) => fk.column === "user_id")

    expect(teamFk?.onDelete).toBe("CASCADE")
    expect(userFk?.onDelete).toBe("CASCADE")
  })

  test("When generateJunctionTable is called -> Composite PRIMARY KEY on (team_id, user_id)", () => {
    // When
    const result = generateJunctionTable("Team", membersProperty, dialect)

    // Then: Composite PRIMARY KEY on (team_id, user_id)
    expect(result!.primaryKey).toBe("team_id, user_id")
  })

  test("Skips properties without x-reference-type: 'array'", () => {
    // Given: Property without x-reference-type: 'array'
    const nonArrayProperty = {
      name: "tags",
      type: "array",
      items: { type: "string" },
    }

    // When
    const result = generateJunctionTable("Team", nonArrayProperty, dialect)

    // Then: Returns null (skipped)
    expect(result).toBeNull()
  })

  test("Skips properties with x-computed: true", () => {
    // Given: Computed property (inverse relationship)
    const computedProperty = {
      name: "members",
      type: "array",
      items: { type: "string" },
      "x-reference-type": "array",
      "x-reference-target": "User",
      "x-computed": true,
    }

    // When
    const result = generateJunctionTable("Team", computedProperty, dialect)

    // Then: Returns null (skipped)
    expect(result).toBeNull()
  })
})
