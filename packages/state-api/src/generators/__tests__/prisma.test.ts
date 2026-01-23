/**
 * Tests for Prisma → Enhanced JSON Schema converter
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { prismaToEnhancedSchema, prismaToArkTypeCode } from "../prisma"
import { domain } from "../../domain"
import { join } from "path"
import { existsSync } from "fs"

// Path to the main Prisma schema
const PRISMA_SCHEMA_PATH = join(import.meta.dir, "../../../../../prisma/schema.prisma")

describe("prismaToEnhancedSchema", () => {
  // Skip if @prisma/internals is not installed
  let prismaAvailable = false

  beforeAll(async () => {
    try {
      await import("@prisma/internals")
      prismaAvailable = true
    } catch {
      console.log("Skipping Prisma tests - @prisma/internals not installed")
    }
  })

  it("should convert a simple Prisma schema string", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id        String   @id @default(cuid())
        email     String   @unique
        name      String?
        posts     Post[]
        createdAt DateTime @default(now())
      }

      model Post {
        id        String   @id @default(cuid())
        title     String
        content   String?
        published Boolean  @default(false)
        author    User     @relation(fields: [authorId], references: [id])
        authorId  String

        @@map("posts")
      }

      enum Role {
        USER
        ADMIN
      }
    `

    const result = await prismaToEnhancedSchema({
      schemaString,
      name: "test-blog",
    })

    // Check structure
    expect(result.schema.$defs).toBeDefined()
    expect(result.models).toContain("User")
    expect(result.models).toContain("Post")
    expect(result.enums).toContain("Role")

    // Check User model
    const userDef = result.schema.$defs!.User
    expect(userDef.type).toBe("object")
    expect(userDef.properties.id["x-mst-type"]).toBe("identifier")
    expect(userDef.properties.email.type).toBe("string")
    expect(userDef.properties.name.type).toBe("string")
    // posts is a computed array (has relation)
    expect(userDef.properties.posts["x-computed"]).toBe(true)
    expect(userDef.properties.posts["x-reference-target"]).toBe("Post")

    // Check Post model
    const postDef = result.schema.$defs!.Post
    expect(postDef.properties.author["x-mst-type"]).toBe("reference")
    expect(postDef.properties.author["x-reference-target"]).toBe("User")
    expect(postDef.properties.published.type).toBe("boolean")
    expect(postDef.properties.published.default).toBe(false)
    // Check persistence metadata from @@map
    expect(postDef["x-persistence"]?.tableName).toBe("posts")
  })

  it("should handle enums correctly", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model Task {
        id       String     @id @default(uuid())
        title    String
        status   TaskStatus @default(PENDING)
        priority Priority?
      }

      enum TaskStatus {
        PENDING
        IN_PROGRESS
        DONE
      }

      enum Priority {
        LOW
        MEDIUM
        HIGH
      }
    `

    const result = await prismaToEnhancedSchema({
      schemaString,
      name: "test-tasks",
    })

    const taskDef = result.schema.$defs!.Task
    expect(taskDef.properties.status.enum).toEqual(["PENDING", "IN_PROGRESS", "DONE"])
    expect(taskDef.properties.status.default).toBe("PENDING")
    expect(taskDef.properties.priority.enum).toEqual(["LOW", "MEDIUM", "HIGH"])
  })

  it("should filter models with includeModels", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id   String @id
        name String
      }

      model Post {
        id    String @id
        title String
      }

      model Comment {
        id   String @id
        text String
      }
    `

    const result = await prismaToEnhancedSchema({
      schemaString,
      includeModels: ["User", "Post"],
    })

    expect(result.models).toEqual(["User", "Post"])
    expect(result.schema.$defs!.Comment).toBeUndefined()
  })

  it("should filter models with excludeModels", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id   String @id
        name String
      }

      model Post {
        id    String @id
        title String
      }

      model InternalLog {
        id      String @id
        message String
      }
    `

    const result = await prismaToEnhancedSchema({
      schemaString,
      excludeModels: ["InternalLog"],
    })

    expect(result.models).toContain("User")
    expect(result.models).toContain("Post")
    expect(result.models).not.toContain("InternalLog")
  })

  it("should work with domain() API", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model Todo {
        id        String   @id @default(uuid())
        title     String
        completed Boolean  @default(false)
        createdAt DateTime @default(now())
      }
    `

    const result = await prismaToEnhancedSchema({
      schemaString,
      name: "todos",
    })

    // Verify schema structure
    expect(result.schema.$defs).toBeDefined()
    expect(result.schema.$defs!.Todo).toBeDefined()
    expect(result.schema.$defs!.Todo.properties.id["x-mst-type"]).toBe("identifier")

    // Create domain from Prisma-generated schema
    const todoDomain = domain({
      name: "todos",
      from: result.schema,
    })

    // Create store
    const store = todoDomain.createStore() as any

    // Verify collections exist (collection name is camelCase + Collection)
    expect(store.todoCollection).toBeDefined()
    expect(typeof store.todoCollection.add).toBe("function")
    expect(typeof store.todoCollection.get).toBe("function")
    expect(typeof store.todoCollection.all).toBe("function")

    // Add an item
    const todo = store.todoCollection.add({
      id: "test-1",
      title: "Test todo",
      completed: false,
      createdAt: Date.now(),
    })

    expect(todo.title).toBe("Test todo")
    expect(store.todoCollection.get("test-1")).toBe(todo)
  })

  // Test with actual project schema if available
  it("should convert the main Prisma schema", async () => {
    if (!prismaAvailable) return
    if (!existsSync(PRISMA_SCHEMA_PATH)) {
      console.log("Skipping - Prisma schema not found at:", PRISMA_SCHEMA_PATH)
      return
    }

    const result = await prismaToEnhancedSchema({
      schemaPath: PRISMA_SCHEMA_PATH,
      name: "shogo",
    })

    // Should have main models
    expect(result.models).toContain("User")
    expect(result.models).toContain("Workspace")
    expect(result.models).toContain("Project")
    expect(result.models).toContain("Member")

    // Check User has expected fields
    const userDef = result.schema.$defs!.User
    expect(userDef.properties.id).toBeDefined()
    expect(userDef.properties.email).toBeDefined()

    // Check warnings
    if (result.warnings.length > 0) {
      console.log("Conversion warnings:", result.warnings)
    }
  })
})

describe("prismaToArkTypeCode", () => {
  let prismaAvailable = false

  beforeAll(async () => {
    try {
      await import("@prisma/internals")
      prismaAvailable = true
    } catch {
      // Skip
    }
  })

  it("should generate valid TypeScript code", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id    String  @id @default(uuid())
        email String  @unique
        name  String?
        role  Role    @default(USER)
      }

      enum Role {
        USER
        ADMIN
      }
    `

    const code = await prismaToArkTypeCode({
      schemaString,
      name: "my-app",
      scopeName: "MyApp",
    })

    // Check structure
    expect(code).toContain('import { scope } from "arktype"')
    expect(code).toContain('import { domain } from "@shogo/state-api"')
    expect(code).toContain("export const MyAppScope = scope({")
    expect(code).toContain("export const myAppDomain = domain({")
    expect(code).toContain("export type Role = 'USER' | 'ADMIN'")
    expect(code).toContain("User: {")
    expect(code).toContain('id: "string.uuid"')
    expect(code).toContain('email: "string"')
    expect(code).toContain('"name?": "string"') // Optional field
  })
})
