/**
 * Tests for Prisma Routes Generator
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { prismaToRoutesCode } from "../prisma-routes"

describe("prismaToRoutesCode", () => {
  let prismaAvailable = false

  beforeAll(async () => {
    try {
      await import("@prisma/internals")
      prismaAvailable = true
    } catch {
      console.log("Skipping Prisma tests - @prisma/internals not installed")
    }
  })

  it("should generate routes for simple models", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id    String @id @default(uuid())
        email String @unique
        name  String?
      }

      model Post {
        id        String @id @default(uuid())
        title     String
        content   String?
        published Boolean @default(false)
      }
    `

    const result = await prismaToRoutesCode({
      schemaString,
    })

    // Check models were found
    expect(result.models).toContain("User")
    expect(result.models).toContain("Post")

    // Check code structure
    expect(result.code).toContain('import { Hono } from "hono"')
    expect(result.code).toContain("createUserRoutes")
    expect(result.code).toContain("createPostRoutes")
    expect(result.code).toContain("createGeneratedRoutes")

    // Check CRUD endpoints
    expect(result.code).toContain('router.get("/",')
    expect(result.code).toContain('router.get("/:id",')
    expect(result.code).toContain('router.post("/",')
    expect(result.code).toContain('router.patch("/:id",')
    expect(result.code).toContain('router.delete("/:id",')

    // Check hooks integration
    expect(result.code).toContain("hooks.beforeCreate")
    expect(result.code).toContain("hooks.afterCreate")
    expect(result.code).toContain("hooks.beforeUpdate")
    expect(result.code).toContain("hooks.beforeDelete")
  })

  it("should filter models with includeModels", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id String @id
      }

      model Post {
        id String @id
      }

      model Comment {
        id String @id
      }
    `

    const result = await prismaToRoutesCode({
      schemaString,
      models: ["User", "Post"],
    })

    expect(result.models).toEqual(["User", "Post"])
    expect(result.code).toContain("createUserRoutes")
    expect(result.code).toContain("createPostRoutes")
    expect(result.code).not.toContain("createCommentRoutes")
  })

  it("should exclude models with excludeModels", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id String @id
      }

      model Post {
        id String @id
      }

      model AuditLog {
        id String @id
      }
    `

    const result = await prismaToRoutesCode({
      schemaString,
      excludeModels: ["AuditLog"],
    })

    expect(result.models).toContain("User")
    expect(result.models).toContain("Post")
    expect(result.models).not.toContain("AuditLog")
  })

  it("should include hook config interface", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model User {
        id String @id
      }
    `

    const result = await prismaToRoutesCode({
      schemaString,
    })

    // Check hook types are included
    expect(result.code).toContain("RouteHooksConfig")
    expect(result.code).toContain("setHooks")
    expect(result.code).toContain("User?: ModelHooks")
  })

  it("should generate route paths correctly", async () => {
    if (!prismaAvailable) return

    const schemaString = `
      model StarredProject {
        id String @id
      }

      model BillingAccount {
        id String @id
      }
    `

    const result = await prismaToRoutesCode({
      schemaString,
    })

    // Check route paths are kebab-case and plural
    expect(result.code).toContain('"/starred-projects"')
    expect(result.code).toContain('"/billing-accounts"')
  })
})
