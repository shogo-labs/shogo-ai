/**
 * Generators: Code generation utilities for Shogo SDK
 *
 * Provides functions to generate routes, scaffold apps, and more.
 *
 * Key exports:
 * - prismaToEnhancedSchema: Convert Prisma schema → Enhanced JSON Schema → domain()
 * - prismaToArkTypeCode: Generate TypeScript code from Prisma schema
 * - prismaToRoutesCode: Generate Hono CRUD routes from Prisma schema with hooks
 * - createRoutes: Generate Hono CRUD routes from Enhanced JSON Schema
 * - scaffoldApp: Scaffold complete app from schema
 */

export * from "./routes"
export * from "./app"
export * from "./prisma"
export * from "./prisma-routes"
