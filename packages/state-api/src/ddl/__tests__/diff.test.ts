/**
 * Schema Diff Detection Tests
 *
 * Generated from TestSpecifications for task-mig-003-diff
 * Tests compareSchemas() function for detecting changes between schema versions.
 */

import { describe, test, expect } from "bun:test"
import { compareSchemas } from "../diff"
import type { SchemaDiff } from "../migration-types"

// Helper to create a minimal Enhanced JSON Schema
function createSchema(defs: Record<string, any>, required?: Record<string, string[]>) {
  const definitions: Record<string, any> = {}
  for (const [name, props] of Object.entries(defs)) {
    definitions[name] = {
      type: "object",
      properties: props,
      ...(required?.[name] && { required: required[name] }),
    }
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $defs: definitions,
  }
}

describe("diff.ts - compareSchemas()", () => {
  describe("Detect added model in schema", () => {
    test("addedModels contains new model", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" } },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      expect(diff.addedModels).toContain("Post")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("Detect removed model in schema", () => {
    test("removedModels contains deleted model", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" } },
      })

      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      expect(diff.removedModels).toContain("Post")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("Detect added column within existing model", () => {
    test("modifiedModels contains model with addedColumns", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const newSchema = createSchema({
        User: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
        },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      expect(diff.modifiedModels.length).toBeGreaterThan(0)
      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()
      expect(userDiff!.addedColumns.map((c) => c.name)).toContain("email")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("Detect removed column within existing model", () => {
    test("modifiedModels contains model with removedColumns", () => {
      const oldSchema = createSchema({
        User: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
        },
      })

      const newSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      expect(diff.modifiedModels.length).toBeGreaterThan(0)
      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()
      expect(userDiff!.removedColumns).toContain("email")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("Detect column type change", () => {
    test("modifiedColumns contains type change", () => {
      const oldSchema = createSchema({
        User: {
          id: { type: "string" },
          age: { type: "integer" },
        },
      })

      const newSchema = createSchema({
        User: {
          id: { type: "string" },
          age: { type: "string" },
        },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()

      const ageChange = userDiff!.modifiedColumns.find(
        (c) => c.columnName === "age"
      )
      expect(ageChange).toBeDefined()
      expect(ageChange!.changeType).toBe("type")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("Detect nullable change (required removed)", () => {
    test("modifiedColumns contains nullability change", () => {
      const oldSchema = createSchema(
        {
          User: {
            id: { type: "string" },
            email: { type: "string" },
          },
        },
        { User: ["id", "email"] } // email is required
      )

      const newSchema = createSchema(
        {
          User: {
            id: { type: "string" },
            email: { type: "string" },
          },
        },
        { User: ["id"] } // email is now optional
      )

      const diff = compareSchemas(oldSchema, newSchema)

      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()

      const emailChange = userDiff!.modifiedColumns.find(
        (c) => c.columnName === "email"
      )
      expect(emailChange).toBeDefined()
      expect(emailChange!.changeType).toBe("nullability")
    })
  })

  describe("Detect default value change", () => {
    test("modifiedColumns contains default change", () => {
      const oldSchema = createSchema({
        User: {
          id: { type: "string" },
          status: { type: "string" },
        },
      })

      const newSchema = createSchema({
        User: {
          id: { type: "string" },
          status: { type: "string", default: "active" },
        },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()

      const statusChange = userDiff!.modifiedColumns.find(
        (c) => c.columnName === "status"
      )
      expect(statusChange).toBeDefined()
      expect(statusChange!.changeType).toBe("default")
    })
  })

  describe("Empty diff for identical schemas", () => {
    test("hasChanges is false for identical schemas", () => {
      const schema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const diff = compareSchemas(schema, schema)

      expect(diff.addedModels).toHaveLength(0)
      expect(diff.removedModels).toHaveLength(0)
      expect(diff.modifiedModels).toHaveLength(0)
      expect(diff.hasChanges).toBe(false)
    })
  })

  describe("Multiple changes detected in single diff", () => {
    test("detects model addition, column addition, and column removal together", () => {
      const oldSchema = createSchema({
        User: { id: { type: "string" }, name: { type: "string" } },
      })

      const newSchema = createSchema({
        User: { id: { type: "string" }, email: { type: "string" } },
        Post: { id: { type: "string" }, title: { type: "string" } },
      })

      const diff = compareSchemas(oldSchema, newSchema)

      expect(diff.addedModels).toContain("Post")

      const userDiff = diff.modifiedModels.find((m) => m.modelName === "User")
      expect(userDiff).toBeDefined()
      expect(userDiff!.addedColumns.map((c) => c.name)).toContain("email")
      expect(userDiff!.removedColumns).toContain("name")
      expect(diff.hasChanges).toBe(true)
    })
  })

  describe("compareSchemas exported from ddl barrel", () => {
    test("function is accessible from ddl index", async () => {
      const { compareSchemas: importedFn } = await import("../index")
      expect(typeof importedFn).toBe("function")
    })
  })
})
