#!/usr/bin/env bun
/**
 * Generate studio-core schema from Prisma schema
 * 
 * Usage: bun run scripts/generate-domain.ts
 * 
 * This generates ONLY the schema (ArkType scope).
 * Enhancements are defined in: packages/state-api/src/studio-core/enhancements.ts
 */

import { prismaToArkTypeCode } from "../packages/state-api/src/generators/prisma"
import { writeFileSync } from "fs"

async function main() {
  console.log("Generating studio-core schema from Prisma schema...")

  const code = await prismaToArkTypeCode({
    schemaPath: "./prisma/schema.prisma",
    name: "studio-core",
    scopeName: "StudioCore",
    includeModels: [
      "Workspace",
      "Project",
      "Folder",
      "Member",
      "Invitation",
      "StarredProject",
      "Notification",
      "BillingAccount",
    ],
    mode: "schema-only",
  })

  const outputPath = "./packages/state-api/src/generated/studio-core.schema.ts"
  writeFileSync(outputPath, code)
  console.log(`✓ Generated: ${outputPath}`)
  console.log(`  Enhancements: packages/state-api/src/studio-core/domain.ts`)
}

main().catch(console.error)
