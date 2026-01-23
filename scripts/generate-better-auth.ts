#!/usr/bin/env bun
/**
 * Generate better-auth schema from Prisma schema
 * 
 * Usage: bun run scripts/generate-better-auth.ts
 * 
 * This generates the schema (ArkType scope) for BetterAuth entities.
 * Enhancements are defined in: packages/state-api/src/better-auth/domain.ts
 */

import { prismaToArkTypeCode } from "../packages/state-api/src/generators/prisma"
import { writeFileSync } from "fs"

async function main() {
  console.log("Generating better-auth schema from Prisma schema...")

  const code = await prismaToArkTypeCode({
    schemaPath: "./prisma/schema.prisma",
    name: "better-auth",
    scopeName: "BetterAuth",
    includeModels: [
      "User",
      "Session",
      "Account",
      "Verification",
    ],
    mode: "schema-only",
  })

  const outputPath = "./packages/state-api/src/generated/better-auth.schema.ts"
  writeFileSync(outputPath, code)
  console.log(`✓ Generated: ${outputPath}`)
  console.log(`  Enhancements: packages/state-api/src/better-auth/domain.ts`)
}

main().catch(console.error)
