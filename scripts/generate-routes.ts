#!/usr/bin/env bun
/**
 * Generate API routes from Prisma schema
 * 
 * Usage: bun run scripts/generate-routes.ts
 */

import { prismaToRoutesCode } from "../packages/state-api/src/generators/prisma-routes"
import { writeFileSync } from "fs"

async function main() {
  console.log("Generating API routes from Prisma schema...")

  const result = await prismaToRoutesCode({
    schemaPath: "./prisma/schema.prisma",
    models: [
      "Workspace",
      "Project",
      "Folder",
      "Member",
      "Invitation",
      "StarredProject",
      "Notification",
      "BillingAccount",
    ],
  })

  const outputPath = "./apps/api/src/generated/routes.ts"
  writeFileSync(outputPath, result.code)
  
  console.log(`✓ Generated: ${outputPath}`)
  console.log(`  Models: ${result.models.join(", ")}`)
  if (result.warnings.length > 0) {
    console.log(`  Warnings: ${result.warnings.join(", ")}`)
  }
}

main().catch(console.error)
