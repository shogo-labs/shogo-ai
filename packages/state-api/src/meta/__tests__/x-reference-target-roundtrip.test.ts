/**
 * x-reference-target Round-Trip Tests
 *
 * Tests for preserving x-reference-target extension through meta-store
 * ingest → toEnhancedJson round-trip.
 *
 * This is critical for DDL generation - without x-reference-target,
 * foreign key columns are not created.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { getMetaStore, resetMetaStore } from "../bootstrap"
import { generateSQL, createPostgresDialect } from "../../ddl"

describe("x-reference-target Round-Trip", () => {
  beforeEach(() => {
    resetMetaStore()
  })

  test("preserves x-reference-target through ingest → toEnhancedJson", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Project: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            title: { type: "string" },
            projectId: {
              type: "string",
              format: "uuid",
              "x-reference-type": "single",
              "x-reference-target": "Project"
            }
          },
          required: ["id", "title", "projectId"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-reference-target"
    })

    const output = schema.toEnhancedJson

    // Verify x-reference-target is preserved
    expect(output.$defs.Task.properties.projectId["x-reference-type"]).toBe("single")
    expect(output.$defs.Task.properties.projectId["x-reference-target"]).toBe("Project")
  })

  test("DDL generates FK column when x-reference-target is present", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Project: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            name: { type: "string" }
          },
          required: ["id", "name"]
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
            title: { type: "string" },
            projectId: {
              type: "string",
              format: "uuid",
              "x-reference-type": "single",
              "x-reference-target": "Project"
            }
          },
          required: ["id", "title", "projectId"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-ddl-fk"
    })

    const enhancedJson = schema.toEnhancedJson
    const dialect = createPostgresDialect()
    const statements = generateSQL(enhancedJson, dialect, { ifNotExists: true })

    // Find the task table creation statement
    const taskStatement = statements.find(s => s.includes('"task"'))
    expect(taskStatement).toBeDefined()

    // Verify project_id column is present
    expect(taskStatement).toContain("project_id")

    // Verify FK constraint is generated
    const fkStatement = statements.find(s => s.includes("fk_task_project_id"))
    expect(fkStatement).toBeDefined()
    expect(fkStatement).toContain("REFERENCES")
    expect(fkStatement).toContain('"project"')
  })

  test("handles models with multiple reference fields", () => {
    const metaStore = getMetaStore()
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Project: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            name: { type: "string" }
          }
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string", "x-mst-type": "identifier" },
            title: { type: "string" },
            projectId: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "Project"
            },
            assigneeId: {
              type: "string",
              "x-reference-type": "single",
              "x-reference-target": "User"
            }
          },
          required: ["id", "title", "projectId"]
        }
      }
    }

    const schema = metaStore.ingestEnhancedJsonSchema(inputSchema, {
      name: "test-multi-refs"
    })

    const output = schema.toEnhancedJson

    expect(output.$defs.Task.properties.projectId["x-reference-target"]).toBe("Project")
    expect(output.$defs.Task.properties.assigneeId["x-reference-target"]).toBe("User")
  })
})
