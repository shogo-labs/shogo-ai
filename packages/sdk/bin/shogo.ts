#!/usr/bin/env bun
/**
 * Shogo SDK CLI
 *
 * Commands:
 *   shogo generate                  # Generate routes, types, stores from Prisma
 *   shogo db switch sqlite          # Switch schema to SQLite for testing
 *   shogo db switch postgres        # Switch schema back to PostgreSQL
 *   shogo db status                 # Show current schema provider
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
import { 
  transformSchemaFile, 
  detectSchemaProvider,
  type DatabaseProvider as SchemaProvider 
} from '../src/db/schema-transformer'

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
    verbose: {
      type: 'boolean',
      short: 'v',
    },
    // DB-specific options
    push: {
      type: 'boolean',
    },
    'no-generate': {
      type: 'boolean',
    },
    url: {
      type: 'string',
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
  shogo <command> [options]

Commands:
  generate              Generate routes, types, and stores from Prisma schema
  db switch <provider>  Switch Prisma schema provider (sqlite | postgres)
  db status             Show current schema provider

Generate Options:
  -c, --config <path>    Path to shogo.config.json (default: ./shogo.config.json)
  -s, --schema <path>    Path to Prisma schema (overrides config)
  -o, --output <path>    Output directory (legacy single-dir mode)
  -m, --models <list>    Comma-separated list of models to include
  -e, --exclude <list>   Comma-separated list of models to exclude

DB Options:
  -s, --schema <path>    Path to Prisma schema (default: ./prisma/schema.prisma)
  --push                 Run prisma db push after switching (creates SQLite DB)
  --no-generate          Skip prisma generate after switching
  --url <url>            DATABASE_URL to use

General Options:
  -h, --help             Show this help message
  -v, --verbose          Show verbose output

Examples:
  # Code generation
  shogo generate                              # Use config file
  shogo generate --config ./custom.json       # Custom config

  # Database provider switching (for testing)
  shogo db switch sqlite                      # Switch to SQLite for tests
  shogo db switch sqlite --push               # Switch + create DB file
  DATABASE_URL=file:./test.db bun test        # Run tests with SQLite
  shogo db switch postgres                    # Switch back to PostgreSQL

  # Check current provider
  shogo db status                             # Show current provider

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
`)
}

function printDbHelp() {
  console.log(`
Shogo DB Commands

Switch your Prisma schema between PostgreSQL and SQLite providers.
This enables fast local testing with SQLite while using PostgreSQL in production.

Usage:
  shogo db switch <provider>   Switch to sqlite or postgres
  shogo db status              Show current provider

Options:
  -s, --schema <path>    Path to Prisma schema (default: ./prisma/schema.prisma)
  --push                 Run prisma db push after switching (useful for SQLite)
  --no-generate          Skip prisma generate after switching
  --url <url>            DATABASE_URL to use
  -v, --verbose          Show verbose output

Examples:
  # Quick workflow for SQLite testing
  shogo db switch sqlite --push              # Switch + create test.db
  DATABASE_URL=file:./test.db bun test       # Run tests
  shogo db switch postgres                   # Restore for production

  # Integration testing with PostgreSQL
  shogo db switch postgres
  DATABASE_URL=postgres://... bun test       # Run against real PostgreSQL

Note: The schema provider must match the adapter type. When you switch
providers, the Prisma client is regenerated to use the new provider.
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

// ============================================================================
// DB Command Handler
// ============================================================================

async function handleDbCommand() {
  const subcommand = positionals[1]
  const cwd = process.cwd()
  
  if (!subcommand || values.help) {
    printDbHelp()
    process.exit(subcommand ? 0 : 1)
  }
  
  // Determine schema path
  const schemaPath = values.schema 
    ? resolve(cwd, values.schema as string)
    : resolve(cwd, './prisma/schema.prisma')
  
  if (!existsSync(schemaPath)) {
    console.error(`❌ Schema not found: ${schemaPath}`)
    process.exit(1)
  }
  
  const verbose = values.verbose as boolean || false
  
  switch (subcommand) {
    case 'switch': {
      const provider = positionals[2] as SchemaProvider
      
      if (!provider || !['sqlite', 'postgres', 'postgresql'].includes(provider)) {
        console.error('❌ Please specify a provider: sqlite or postgres')
        console.error('   Usage: shogo db switch <sqlite|postgres>')
        process.exit(1)
      }
      
      const targetProvider: SchemaProvider = provider === 'postgres' ? 'postgresql' : provider as SchemaProvider
      
      console.log(`🔄 Switching schema to ${targetProvider}...`)
      
      try {
        const result = await transformSchemaFile({
          schemaPath,
          targetProvider,
          generate: !(values['no-generate'] as boolean),
          push: values.push as boolean,
          databaseUrl: values.url as string,
          verbose,
        })
        
        if (result.modified) {
          console.log(`✅ Schema switched from ${result.originalProvider} to ${result.newProvider}`)
        } else {
          console.log(`✅ Schema already using ${result.newProvider}`)
        }
        
        if (result.warnings.length > 0) {
          console.log('')
          console.log('⚠️  Warnings:')
          for (const warning of result.warnings) {
            console.log(`   - ${warning}`)
          }
        }
        
        console.log('')
        if (targetProvider === 'sqlite') {
          console.log('Next steps:')
          console.log('  DATABASE_URL=file:./test.db bun test')
          console.log('')
          console.log('To restore PostgreSQL:')
          console.log('  shogo db switch postgres')
        } else {
          console.log('Schema restored to PostgreSQL for production use.')
        }
        
      } catch (error) {
        console.error(`❌ Failed: ${error instanceof Error ? error.message : error}`)
        process.exit(1)
      }
      break
    }
    
    case 'status': {
      const content = readFileSync(schemaPath, 'utf-8')
      const provider = detectSchemaProvider(content)
      
      console.log(`📊 Schema Status`)
      console.log(`   Path: ${schemaPath}`)
      console.log(`   Provider: ${provider || 'unknown'}`)
      break
    }
    
    default:
      console.error(`Unknown db subcommand: ${subcommand}`)
      printDbHelp()
      process.exit(1)
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const command = positionals[0]

  if (values.help && !command) {
    printHelp()
    process.exit(0)
  }

  if (!command) {
    printHelp()
    process.exit(1)
  }

  // Handle db command
  if (command === 'db') {
    await handleDbCommand()
    process.exit(0)
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
      
      // Skip if file exists and skipIfExists is true (for hooks files)
      if (file.skipIfExists && existsSync(filePath)) {
        console.log(`   ⊘ ${file.path} (skipped - already exists)`)
        continue
      }
      
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
