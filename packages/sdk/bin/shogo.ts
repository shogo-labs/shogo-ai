#!/usr/bin/env bun
/**
 * Shogo SDK CLI
 *
 * Generate routes, types, and stores from Prisma schema.
 *
 * Usage:
 *   shogo generate                           # Use shogo.config.json
 *   shogo generate --config ./custom.json    # Use custom config
 *   shogo generate --schema ./db.prisma      # Quick mode (legacy)
 */

import { parseArgs } from 'util'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { generateFromPrisma, type GenerateOptions, type OutputConfig } from '../src/generators/prisma-generator'

// ============================================================================
// Types
// ============================================================================

interface ShogoConfig {
  /** Path to Prisma schema file */
  schema: string
  /** Models to include (default: all) */
  models?: string[]
  /** Models to exclude */
  excludeModels?: string[]
  /** Output configurations */
  outputs: OutputConfig[]
}

// ============================================================================
// CLI Parsing
// ============================================================================

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    schema: {
      type: 'string',
      short: 's',
    },
    config: {
      type: 'string',
      short: 'c',
    },
    output: {
      type: 'string',
      short: 'o',
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
  generate    Generate routes, types, and stores from Prisma schema

Options:
  -c, --config <path>    Path to shogo.config.json (default: ./shogo.config.json)
  -s, --schema <path>    Path to Prisma schema (overrides config)
  -o, --output <path>    Output directory (legacy single-dir mode)
  -m, --models <list>    Comma-separated list of models to include
  -e, --exclude <list>   Comma-separated list of models to exclude
  -h, --help             Show this help message

Config File (shogo.config.json):
  {
    "schema": "./prisma/schema.prisma",
    "models": ["Workspace", "Project", "Member"],
    "outputs": [
      {
        "dir": "./apps/api/src/generated",
        "generate": ["routes", "hooks"],
        "perModel": true
      },
      {
        "dir": "./apps/web/src/generated",
        "generate": ["types", "stores"],
        "perModel": true
      }
    ]
  }

Examples:
  shogo generate                              # Use config file
  shogo generate --config ./custom.json       # Custom config
  shogo generate --schema ./db.prisma --output ./gen  # Legacy mode
`)
}

// ============================================================================
// Config Loading
// ============================================================================

function loadConfig(cwd: string): ShogoConfig | null {
  const configPath = values.config 
    ? resolve(cwd, values.config as string)
    : resolve(cwd, 'shogo.config.json')

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = readFileSync(configPath, 'utf-8')
    return JSON.parse(content) as ShogoConfig
  } catch (error) {
    console.error(`Error loading config: ${configPath}`)
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const command = positionals[0]

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  if (!command) {
    printHelp()
    process.exit(1)
  }

  if (command !== 'generate') {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }

  const cwd = process.cwd()

  // Try to load config file
  const config = loadConfig(cwd)

  // Determine schema path
  let schemaPath: string
  if (values.schema) {
    schemaPath = resolve(cwd, values.schema as string)
  } else if (config?.schema) {
    schemaPath = resolve(cwd, config.schema)
  } else {
    schemaPath = resolve(cwd, './prisma/schema.prisma')
  }

  // Check schema exists
  if (!existsSync(schemaPath)) {
    console.error(`❌ Schema not found: ${schemaPath}`)
    console.error('   Specify with --schema or in shogo.config.json')
    process.exit(1)
  }

  // Parse model filters
  const models = values.models 
    ? (values.models as string).split(',').map(s => s.trim())
    : config?.models

  const excludeModels = values.exclude
    ? (values.exclude as string).split(',').map(s => s.trim())
    : config?.excludeModels

  // Determine outputs
  let outputs: OutputConfig[] | undefined
  let outputDir: string | undefined

  if (config?.outputs && config.outputs.length > 0) {
    // Use config outputs (new per-model mode)
    outputs = config.outputs.map(o => ({
      ...o,
      dir: resolve(cwd, o.dir),
    }))
  } else if (values.output) {
    // Legacy single-dir mode
    outputDir = resolve(cwd, values.output as string)
  } else if (!config) {
    // No config and no output specified - use default
    outputDir = resolve(cwd, './src/generated')
  }

  // Print banner
  console.log('🚀 Shogo Generate')
  console.log(`   Schema: ${schemaPath}`)

  if (outputs) {
    console.log('   Outputs:')
    for (const output of outputs) {
      console.log(`     - ${output.dir}`)
      console.log(`       generate: ${output.generate.join(', ')}`)
    }
  } else if (outputDir) {
    console.log(`   Output: ${outputDir}`)
  }

  if (models) {
    console.log(`   Models: ${models.join(', ')}`)
  }
  if (excludeModels) {
    console.log(`   Exclude: ${excludeModels.join(', ')}`)
  }

  console.log('')

  // Generate
  try {
    const options: GenerateOptions = {
      schemaPath,
      models,
      excludeModels,
    }

    if (outputs) {
      options.outputs = outputs
    } else if (outputDir) {
      options.outputDir = outputDir
    }

    const result = await generateFromPrisma(options)

    // Write files
    for (const file of result.files) {
      const filePath = file.path.startsWith('/') ? file.path : resolve(cwd, file.path)
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
    if (outputs) {
      const hasRoutes = outputs.some(o => o.generate.includes('routes'))
      const hasStores = outputs.some(o => o.generate.includes('stores'))
      
      if (hasRoutes) {
        console.log('  1. Customize hooks in your API generated/*.hooks.ts files')
        console.log('  2. Mount routes with createAllRoutes(prisma) in your server')
      }
      if (hasStores) {
        console.log('  3. Import stores and use with DomainProvider in your app')
      }
    } else {
      console.log('  1. Review generated hooks in hooks.ts')
      console.log('  2. Import and use generated code in your app')
    }

  } catch (error) {
    console.error('')
    console.error('❌ Generation failed:')
    console.error(`   ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

main()
