/**
 * Tests for x-renderer schema extension
 * Task: task-schema-extension
 *
 * Verifies that the EnhancedJsonSchema interface includes the x-renderer property
 * following the established x-* extension pattern.
 */

import { describe, test, expect } from "bun:test"
import type { EnhancedJsonSchema } from "../types"

describe("x-renderer schema extension", () => {
  test("EnhancedJsonSchema interface includes x-renderer property", () => {
    // Create a schema object with x-renderer - TypeScript should allow this
    const schema: EnhancedJsonSchema = {
      type: "string",
      "x-renderer": "custom-text-display"
    }

    expect(schema["x-renderer"]).toBe("custom-text-display")
  })

  test("x-renderer follows existing x-* extension naming convention", () => {
    // x-renderer should use kebab-case like other x-* extensions
    const schema: EnhancedJsonSchema = {
      type: "object",
      properties: {
        email: {
          type: "string",
          format: "email",
          "x-renderer": "mailto-link"
        },
        status: {
          type: "string",
          enum: ["active", "inactive"],
          "x-renderer": "status-badge"
        }
      }
    }

    // Verify x-renderer is accessible on nested properties
    expect(schema.properties?.email["x-renderer"]).toBe("mailto-link")
    expect(schema.properties?.status["x-renderer"]).toBe("status-badge")
  })

  test("x-renderer type change is backward compatible (optional property)", () => {
    // Schema without x-renderer should still be valid
    const schemaWithoutRenderer: EnhancedJsonSchema = {
      type: "string",
      format: "email",
      "x-arktype": "string"
    }

    expect(schemaWithoutRenderer["x-renderer"]).toBeUndefined()

    // Schema with x-renderer should also be valid
    const schemaWithRenderer: EnhancedJsonSchema = {
      type: "string",
      format: "email",
      "x-arktype": "string",
      "x-renderer": "email-display"
    }

    expect(schemaWithRenderer["x-renderer"]).toBe("email-display")
  })

  test("x-renderer can be used alongside other x-* extensions", () => {
    const schema: EnhancedJsonSchema = {
      type: "string",
      "x-arktype": "string",
      "x-mst-type": "identifier",
      "x-renderer": "id-display",
      "x-computed": false
    }

    expect(schema["x-arktype"]).toBe("string")
    expect(schema["x-mst-type"]).toBe("identifier")
    expect(schema["x-renderer"]).toBe("id-display")
    expect(schema["x-computed"]).toBe(false)
  })
})
