// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
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
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { resolve, dirname, basename } from 'path'
import { execSync } from 'child_process'
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
    // Docs-specific options
    'no-docs-build': {
      type: 'boolean',
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
// Cleanup stale generated files
// ============================================================================

/**
 * Clean up stale per-model generated files from previous schemas.
 *
 * When models change (e.g., template had Category/Transaction/Budget,
 * user's schema has MenuItem/FixedCost/BusinessPlan), old per-model files
 * remain on disk and cause import errors. This removes them.
 */
function cleanupStaleGeneratedFiles(outputDir: string, newFiles: { path: string }[]): void {
  const absOutputDir = resolve(outputDir)
  if (!existsSync(absOutputDir)) return

  // Build set of filenames we're about to write
  const expectedFiles = new Set<string>()
  for (const file of newFiles) {
    const absPath = file.path.startsWith('/') ? file.path : resolve(file.path)
    // Only track files in this output directory
    if (absPath.startsWith(absOutputDir)) {
      expectedFiles.add(basename(absPath))
    }
  }

  const existingFiles = readdirSync(absOutputDir)
  const staleFiles: string[] = []

  // Per-model generated file patterns that should be cleaned up
  const generatedPatterns = [
    /^.+\.routes\.(ts|tsx)$/,
    /^.+\.hooks\.(ts|tsx)$/,
    /^.+\.types\.(ts|tsx)$/,
    /^.+\.store\.(ts|tsx)$/,
    /^.+\.model\.(ts|tsx)$/,
    /^.+\.collection\.(ts|tsx)$/,
  ]

  for (const file of existingFiles) {
    // Skip if it's a file we're about to write
    if (expectedFiles.has(file)) continue

    // Check if it matches a generated per-model file pattern
    const isGenerated = generatedPatterns.some(p => p.test(file))
    if (isGenerated) {
      staleFiles.push(file)
      continue
    }

    // Clean up index.tsx if we're about to write index.ts
    // Bun's module resolution prefers .tsx over .ts, causing conflicts
    if (file === 'index.tsx' && expectedFiles.has('index.ts')) {
      staleFiles.push(file)
      continue
    }
  }

  if (staleFiles.length > 0) {
    console.log(`   🧹 Cleaning up ${staleFiles.length} stale generated file(s):`)
    for (const file of staleFiles) {
      try {
        unlinkSync(resolve(absOutputDir, file))
        console.log(`      ✗ ${file} (deleted)`)
      } catch (err: any) {
        console.warn(`      ⚠️ Failed to delete ${file}: ${err.message}`)
      }
    }
  }
}

// ============================================================================
// Help
// ============================================================================

function printHelp() {
  console.log(`
Shogo SDK CLI

Usage:
  shogo <command> [options]

Commands:
  generate              Generate routes, types, stores, and docs from Prisma schema
  db switch <provider>  Switch Prisma schema provider (sqlite | postgres)
  db status             Show current schema provider

Generate Options:
  -c, --config <path>    Path to shogo.config.json (default: ./shogo.config.json)
  -s, --schema <path>    Path to Prisma schema (overrides config)
  -o, --output <path>    Output directory (legacy single-dir mode)
  -m, --models <list>    Comma-separated list of models to include
  -e, --exclude <list>   Comma-separated list of models to exclude
  --no-docs-build        Skip building the Docusaurus docs site after generation

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
      },
      {
        "dir": "./dev-docs",
        "generate": ["docs"]
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

  // Detect if running inside a Shogo project-runtime environment.
  // When PORT is set and we're inside a pod, pause the Vite build watcher
  // to prevent crashes from rapid file writes during code generation.
  // The resume call at the end triggers a fresh build + backend server restart.
  const runtimePort = process.env.RUNTIME_PORT || process.env.PORT
  const isInsideRuntime = !!runtimePort && existsSync(resolve(cwd, 'server.tsx'))
  
  if (isInsideRuntime) {
    console.log(`📡 Detected project-runtime (port ${runtimePort})`)
  }
  
  // ── Step 1: Pause watcher (if inside runtime) ──────────────────────────
  if (isInsideRuntime) {
    try {
      console.log('⏸️  Pausing build watcher...')
      await fetch(`http://localhost:${runtimePort}/preview/watch/pause`, { method: 'POST' })
    } catch {
      console.log('   (watcher not running or unreachable - continuing)')
    }
  }
  
  // ── Step 2: Run prisma generate + db push ──────────────────────────────
  // Always regenerate the Prisma client and push schema changes to the database.
  // This ensures the generated routes have matching DB tables and up-to-date types.
  const hasPrisma = existsSync(schemaPath)
  if (hasPrisma) {
    console.log('🔧 Updating Prisma client and database...')
    
    try {
      console.log('   Running prisma generate...')
      execSync('bunx --bun prisma generate', {
        cwd,
        stdio: values.verbose ? 'inherit' : 'pipe',
        env: process.env,
      })
      console.log('   ✓ Prisma client generated')
    } catch (err) {
      console.warn(`   ⚠️ prisma generate failed: ${err instanceof Error ? err.message : err}`)
    }
    
    // Push schema to database (only if DATABASE_URL is set)
    if (process.env.DATABASE_URL) {
      try {
        console.log('   Running prisma db push...')
        execSync('bunx --bun prisma db push --accept-data-loss', {
          cwd,
          stdio: values.verbose ? 'inherit' : 'pipe',
          env: process.env,
        })
        console.log('   ✓ Database schema synced')
      } catch (err) {
        console.warn(`   ⚠️ prisma db push failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      console.log('   ⊘ Skipping db push (no DATABASE_URL)')
    }
    
    console.log('')
  }
  
  // ── Step 3: Generate SDK files ─────────────────────────────────────────
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

    // Clean up stale generated files from previous models
    if (outputs) {
      for (const output of outputs) {
        const absDir = output.dir.startsWith('/') ? output.dir : resolve(cwd, output.dir)
        cleanupStaleGeneratedFiles(absDir, result.files)
      }
    } else if (outputDir) {
      const absDir = outputDir.startsWith('/') ? outputDir : resolve(cwd, outputDir)
      cleanupStaleGeneratedFiles(absDir, result.files)
    }

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

    // Build Docusaurus docs site if docs were generated
    if (outputs) {
      const docsOutput = outputs.find(o => o.generate.includes('docs'))
      const skipDocsBuild = values['no-docs-build'] as boolean

      if (docsOutput && !skipDocsBuild) {
        const docsDir = docsOutput.dir
        const absDocsDir = docsDir.startsWith('/') ? docsDir : resolve(cwd, docsDir)

        console.log('')
        console.log('📖 Building documentation site...')

        try {
          // Install dependencies if node_modules doesn't exist
          const nodeModulesPath = resolve(absDocsDir, 'node_modules')
          if (!existsSync(nodeModulesPath)) {
            console.log('   Installing dependencies...')
            execSync('bun install', {
              cwd: absDocsDir,
              stdio: values.verbose ? 'inherit' : 'pipe',
            })
            console.log('   ✓ Dependencies installed')
          }

          // Build the static site
          console.log('   Building static site...')
          execSync('bunx docusaurus build', {
            cwd: absDocsDir,
            stdio: values.verbose ? 'inherit' : 'pipe',
          })

          console.log(`   ✓ Static site built at ${docsDir}/build`)
          console.log('')
          console.log(`📄 Docs available at: ${docsDir}/build/index.html`)
          console.log(`   Serve locally: bunx serve ${docsDir}/build`)
        } catch (buildError) {
          console.log('')
          console.log('⚠️  Docs build failed (docs files were still generated):')
          console.log(`   ${buildError instanceof Error ? buildError.message : buildError}`)
          console.log(`   You can build manually: cd ${docsDir} && bun install && bunx docusaurus build`)
        }
      }
    }

    console.log('')

  } catch (error) {
    console.error('')
    console.error('❌ Generation failed:')
    console.error(`   ${error instanceof Error ? error.message : error}`)
    
    // Still try to resume watcher even if generation failed
    if (isInsideRuntime) {
      try {
        await fetch(`http://localhost:${runtimePort}/preview/watch/resume`, { method: 'POST' })
      } catch { /* ignore */ }
    }
    
    process.exit(1)
  }
  
  // ── Step 4: Resume watcher (if inside runtime) ─────────────────────────
  // This triggers a fresh Vite build AND restarts the backend API server,
  // ensuring new routes are served immediately.
  if (isInsideRuntime) {
    try {
      console.log('▶️  Resuming build watcher (triggers rebuild + backend restart)...')
      const res = await fetch(`http://localhost:${runtimePort}/preview/watch/resume`, { method: 'POST' })
      const data = await res.json() as { resumed?: boolean; buildSuccess?: boolean }
      if (data.buildSuccess) {
        console.log('   ✓ Build succeeded and backend restarted')
      } else if (data.resumed) {
        console.log('   ✓ Watcher resumed (build in progress)')
      }
    } catch {
      console.log('   ⚠️ Could not resume watcher - you may need to rebuild manually')
    }
  }
  
  console.log('')
  console.log('✅ Done!')
}

main()
