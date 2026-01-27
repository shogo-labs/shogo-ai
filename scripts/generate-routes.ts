#!/usr/bin/env bun
/**
 * @deprecated Use `bun run generate:routes` or `shogo generate` instead.
 *
 * This script has been replaced by the SDK's unified generator.
 * See shogo.config.json for configuration.
 *
 * Old usage: bun run scripts/generate-routes.ts
 * New usage: bun run packages/sdk/bin/shogo.ts generate
 */

console.warn('⚠️  DEPRECATED: Use `bun run generate:routes` instead')
console.warn('   This script will be removed in a future version.\n')

import { prismaToRoutesCode } from "../packages/state-api/src/generators/prisma-routes"
import { writeFileSync } from "fs"

async function main() {
  console.log("Generating API routes from Prisma schema...")

  const result = await prismaToRoutesCode({
    schemaPath: "./prisma/schema.prisma",
    models: [
      // Studio-Core
      "Workspace",
      "Project",
      "Folder",
      "Member",
      "Invitation",
      "StarredProject",
      "Notification",
      "BillingAccount",
      // Billing
      "Subscription",
      "CreditLedger",
      "UsageEvent",
      // Studio-Chat
      "ChatSession",
      "ChatMessage",
      "ToolCallLog",
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
