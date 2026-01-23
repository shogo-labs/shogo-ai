#!/usr/bin/env bun
/**
 * Shogo SDK CLI
 *
 * Generate server functions, domain stores, and types from Prisma schema.
 *
 * Usage:
 *   shogo generate                    # Generate from ./prisma/schema.prisma
 *   shogo generate --schema ./db.prisma
 *   shogo generate --output ./src/generated
 *   shogo generate --models Todo,User
 */

import { parseArgs } from 'util'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { generateFromPrisma, type GenerateOptions } from '../src/generators/prisma-generator'

// ============================================================================
// CLI Parsing
// ============================================================================

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    schema: {
      type: 'string',
      short: 's',
      default: './prisma/schema.prisma',
    },
    output: {
      type: 'string',
      short: 'o',
      default: './src/generated',
    },
    models: {
      type: 'string',
      short: 'm',
    },
    exclude: {
      type: 'string',
      short: 'e',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
  },
  allowPositionals: true,
})

// ============================================================================
// Help
// ============================================================================

function printHelp() {
  console.log(`
Shogo SDK CLI

Usage:
  shogo generate [options]

Commands:
  generate    Generate server functions, stores, and types from Prisma schema

Options:
  -s, --schema <path>    Path to Prisma schema (default: ./prisma/schema.prisma)
  -o, --output <path>    Output directory (default: ./src/generated)
  -m, --models <list>    Comma-separated list of models to include
  -e, --exclude <list>   Comma-separated list of models to exclude
  -h, --help             Show this help message

Examples:
  shogo generate
  shogo generate --schema ./db/schema.prisma
  shogo generate --output ./app/generated
  shogo generate --models Todo,User,Post
  shogo generate --exclude Session,Account
`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const command = positionals[0]

  if (values.help || !command) {
    printHelp()
    process.exit(command ? 0 : 1)
  }

  if (command !== 'generate') {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  // Resolve paths
  const cwd = process.cwd()
  const schemaPath = resolve(cwd, values.schema as string)
  const outputDir = resolve(cwd, values.output as string)

  // Check schema exists
  if (!existsSync(schemaPath)) {
    console.error(`❌ Schema not found: ${schemaPath}`)
    process.exit(1)
  }

  console.log('🚀 Shogo Generate')
  console.log(`   Schema: ${schemaPath}`)
  console.log(`   Output: ${outputDir}`)

  // Parse model filters
  const models = values.models 
    ? (values.models as string).split(',').map(s => s.trim())
    : undefined
  const excludeModels = values.exclude
    ? (values.exclude as string).split(',').map(s => s.trim())
    : undefined

  if (models) {
    console.log(`   Models: ${models.join(', ')}`)
  }
  if (excludeModels) {
    console.log(`   Exclude: ${excludeModels.join(', ')}`)
  }

  // Generate
  try {
    const result = await generateFromPrisma({
      schemaPath,
      outputDir,
      models,
      excludeModels,
    })

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true })

    // Write files
    for (const file of result.files) {
      const filePath = resolve(cwd, file.path)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, file.content)
      console.log(`   ✓ ${file.path}`)
    }

    // Report
    console.log('')
    console.log(`✅ Generated ${result.files.length} files for ${result.models.length} models`)
    console.log(`   Models: ${result.models.join(', ')}`)

    if (result.warnings.length > 0) {
      console.log('')
      console.log('⚠️  Warnings:')
      for (const warning of result.warnings) {
        console.log(`   - ${warning}`)
      }
    }

    console.log('')
    console.log('Next steps:')
    console.log('  1. Review generated hooks in ./src/generated/hooks.ts')
    console.log('  2. Import server functions in your routes')
    console.log('  3. Use the domain store with ShogoProvider')

  } catch (error) {
    console.error('')
    console.error('❌ Generation failed:')
    console.error(`   ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

main()
