/**
 * SDK Full Workflow E2E Tests
 *
 * Tests the complete flow from schema design to app scaffolding.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { existsSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { createRoutes, scaffoldApp } from ".."
import type { EnhancedJsonSchema } from "../../schematic/types"

/**
 * Sample Enhanced JSON Schema for testing
 */
const TODO_SCHEMA: EnhancedJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "todo-app",
  $defs: {
    Task: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          "x-mst-type": "identifier",
        },
        title: {
          type: "string",
        },
        completed: {
          type: "boolean",
          default: false,
        },
        createdAt: {
          type: "string",
          format: "date-time",
        },
      },
      required: ["id", "title"],
    },
    Category: {
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
        color: {
          type: "string",
          default: "#3b82f6",
        },
      },
      required: ["id", "name"],
    },
  },
}

describe("SDK Full Workflow E2E", () => {
  const testProjectDir = join(process.cwd(), ".test-output", "sdk-e2e-test-app")

  afterAll(() => {
    // Cleanup test output directory
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  describe("createRoutes()", () => {
    test("generates valid Hono routes from schema", () => {
      const result = createRoutes({
        schema: TODO_SCHEMA,
        basePath: "/api",
      })

      // Should return generated code
      expect(result.code).toBeDefined()
      expect(typeof result.code).toBe("string")
      expect(result.code.length).toBeGreaterThan(0)

      // Should identify entities
      expect(result.entities).toContain("Task")
      expect(result.entities).toContain("Category")
      expect(result.entities.length).toBe(2)
    })

    test("generates routes with correct structure", () => {
      const result = createRoutes({
        schema: TODO_SCHEMA,
        basePath: "/api",
      })

      // Should have imports
      expect(result.code).toContain('import { Hono } from "hono"')

      // Should have route interface
      expect(result.code).toContain("RoutesConfig")
      expect(result.code).toContain("taskCollection")
      expect(result.code).toContain("categoryCollection")

      // Should have CRUD routes for each entity
      expect(result.code).toContain('tasks.get("/"')
      expect(result.code).toContain('tasks.get("/:id"')
      expect(result.code).toContain('tasks.post("/"')
      expect(result.code).toContain('tasks.patch("/:id"')
      expect(result.code).toContain('tasks.delete("/:id"')

      expect(result.code).toContain('categories.get("/"')
      expect(result.code).toContain('categories.post("/"')

      // Should have route mounting
      expect(result.code).toContain('router.route("/api/tasks"')
      expect(result.code).toContain('router.route("/api/categories"')
    })

    test("respects entity filter", () => {
      const result = createRoutes({
        schema: TODO_SCHEMA,
        entities: ["Task"],
        basePath: "/api",
      })

      expect(result.entities).toContain("Task")
      expect(result.entities).not.toContain("Category")
      expect(result.entities.length).toBe(1)

      expect(result.code).toContain("taskCollection")
      expect(result.code).not.toContain("categoryCollection")
    })

    test("uses custom base path", () => {
      const result = createRoutes({
        schema: TODO_SCHEMA,
        basePath: "/v1",
      })

      expect(result.code).toContain('router.route("/v1/tasks"')
      expect(result.code).toContain('router.route("/v1/categories"')
    })

    test("throws error for empty schema", () => {
      const emptySchema: EnhancedJsonSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "empty",
      }

      expect(() => createRoutes({ schema: emptySchema })).toThrow(
        "No entities found in schema to generate routes for"
      )
    })
  })

  describe("scaffoldApp()", () => {
    test("generates all required files in dry run mode", async () => {
      const result = await scaffoldApp({
        name: "test-todo-app",
        schema: TODO_SCHEMA,
        dryRun: true,
      })

      // Should return expected files
      expect(result.files).toContain("src/domain.ts")
      expect(result.files).toContain("src/routes.ts")
      expect(result.files).toContain("src/App.tsx")

      // Should have file contents
      expect(result.fileContents).toBeDefined()
      expect(result.fileContents!["src/domain.ts"]).toBeDefined()
      expect(result.fileContents!["src/routes.ts"]).toBeDefined()
      expect(result.fileContents!["src/App.tsx"]).toBeDefined()
    })

    test("generates valid domain.ts", async () => {
      const result = await scaffoldApp({
        name: "test-todo-app",
        schema: TODO_SCHEMA,
        dryRun: true,
      })

      const domainCode = result.fileContents!["src/domain.ts"]

      // Should have ArkType scope
      expect(domainCode).toContain('import { scope } from "arktype"')
      expect(domainCode).toContain('import { domain } from "@shogo/state-api"')

      // Should export scope and domain
      expect(domainCode).toContain("TestTodoAppDomain = scope")
      expect(domainCode).toContain("testTodoAppDomain = domain")

      // Should have entity definitions
      expect(domainCode).toContain("Task:")
      expect(domainCode).toContain("Category:")
      expect(domainCode).toContain('"string.uuid"')
    })

    test("generates valid App.tsx", async () => {
      const result = await scaffoldApp({
        name: "test-todo-app",
        schema: TODO_SCHEMA,
        dryRun: true,
      })

      const appCode = result.fileContents!["src/App.tsx"]

      // Should have React imports
      expect(appCode).toContain("import { useState, useEffect, createContext, useContext")
      expect(appCode).toContain("from 'mobx-react-lite'")

      // Should import domain
      expect(appCode).toContain("testTodoAppDomain")

      // Should have store context
      expect(appCode).toContain("StoreContext")
      expect(appCode).toContain("useStore")

      // Should have CRUD functionality for primary entity
      expect(appCode).toContain("taskCollection")
      expect(appCode).toContain("insertOne")
      expect(appCode).toContain("deleteOne")
    })

    test("skips routes when api feature disabled", async () => {
      const result = await scaffoldApp({
        name: "test-no-api-app",
        schema: TODO_SCHEMA,
        features: { api: false },
        dryRun: true,
      })

      expect(result.files).not.toContain("src/routes.ts")
      expect(result.fileContents!["src/routes.ts"]).toBeUndefined()
    })

    test("creates actual files when not in dry run", async () => {
      const result = await scaffoldApp({
        name: "sdk-e2e-test-app",
        schema: TODO_SCHEMA,
        output: testProjectDir,
        skipInstall: true, // Skip install for faster tests
        dryRun: false,
      })

      // Should create project directory
      expect(existsSync(testProjectDir)).toBe(true)

      // Should create source files
      expect(existsSync(join(testProjectDir, "src", "domain.ts"))).toBe(true)
      expect(existsSync(join(testProjectDir, "src", "routes.ts"))).toBe(true)
      expect(existsSync(join(testProjectDir, "src", "App.tsx"))).toBe(true)

      // Files should have correct content
      const domainContent = readFileSync(join(testProjectDir, "src", "domain.ts"), "utf-8")
      expect(domainContent).toContain("SdkE2eTestAppDomain")
      expect(domainContent).toContain("sdkE2eTestAppDomain")
    })

    test("uses schema title as schema name", async () => {
      const result = await scaffoldApp({
        name: "my-custom-name",
        schema: TODO_SCHEMA, // schema has title: "todo-app"
        dryRun: true,
      })

      const domainCode = result.fileContents!["src/domain.ts"]
      // Schema name in domain() should use schema.title
      expect(domainCode).toContain('name: "todo-app"')
    })
  })

  describe("Full E2E Flow: Schema → Routes → App", () => {
    test("complete workflow produces valid TypeScript", async () => {
      // Step 1: Generate routes
      const routesResult = createRoutes({
        schema: TODO_SCHEMA,
        basePath: "/api",
      })

      // Step 2: Scaffold app
      const appResult = await scaffoldApp({
        name: "full-e2e-app",
        schema: TODO_SCHEMA,
        dryRun: true,
      })

      // Verify routes match what scaffoldApp would generate
      expect(appResult.fileContents!["src/routes.ts"]).toEqual(routesResult.code)

      // Verify all pieces work together
      const domainCode = appResult.fileContents!["src/domain.ts"]
      const appCode = appResult.fileContents!["src/App.tsx"]
      const routesCode = appResult.fileContents!["src/routes.ts"]

      // Domain exports what App imports
      expect(domainCode).toContain("fullE2eAppDomain = domain")
      expect(appCode).toContain("fullE2eAppDomain")

      // Routes use same collection names as domain
      expect(domainCode).toContain("Task:")
      expect(routesCode).toContain("taskCollection")
      expect(appCode).toContain("taskCollection")
    })

    test("handles complex schema with references", async () => {
      const complexSchema: EnhancedJsonSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "project-manager",
        $defs: {
          Project: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              name: { type: "string" },
              status: {
                type: "string",
                enum: ["planning", "active", "completed", "archived"],
                default: "planning",
              },
            },
            required: ["id", "name"],
          },
          Task: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              title: { type: "string" },
              projectId: {
                type: "string",
                "x-mst-type": "reference",
                "x-reference-target": "Project",
              },
              priority: {
                type: "string",
                enum: ["low", "medium", "high"],
                default: "medium",
              },
            },
            required: ["id", "title"],
          },
          Comment: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid", "x-mst-type": "identifier" },
              text: { type: "string" },
              taskId: {
                type: "string",
                "x-mst-type": "reference",
                "x-reference-target": "Task",
              },
            },
            required: ["id", "text"],
          },
        },
      }

      const result = await scaffoldApp({
        name: "complex-project-app",
        schema: complexSchema,
        dryRun: true,
      })

      // Should generate routes for all entities
      const routesCode = result.fileContents!["src/routes.ts"]
      expect(routesCode).toContain("projectCollection")
      expect(routesCode).toContain("taskCollection")
      expect(routesCode).toContain("commentCollection")

      // Should handle enums in domain
      const domainCode = result.fileContents!["src/domain.ts"]
      expect(domainCode).toContain("'planning' | 'active' | 'completed' | 'archived'")
      expect(domainCode).toContain("'low' | 'medium' | 'high'")

      // Should handle references
      expect(domainCode).toContain('"projectId?": "Project"')
      expect(domainCode).toContain('"taskId?": "Task"')
    })
  })
})
