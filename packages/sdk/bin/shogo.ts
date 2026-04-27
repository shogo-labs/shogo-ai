#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
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
import { pkg } from '@shogo/shared-runtime'
import { generateFromPrisma, type GenerateOptions, type OutputConfig } from '../src/generators/prisma-generator'
import { ensureFeatureDeps } from '../src/generators/deps-doctor'
import { 
  transformSchemaFile, 
  detectSchemaProvider,
  type DatabaseProvider as SchemaProvider 
} from '../src/db/schema-transformer'

// ============================================================================
// Types
// ============================================================================

/**
 * Feature flags that toggle generator outputs & dependency wiring
 * across the pod. Each feature, when enabled, opts the pod into a
 * set of generated files and (via `deps-doctor`) any runtime deps
 * those files need.
 */
interface ShogoFeatures {
  /**
   * Voice feature. `true` enables the zero-config voice path:
   *   - emits `src/lib/shogo.ts` (shogo-client)
   *   - emits `src/components/shogo/{VoiceButton,VoiceSphere,PhoneButton}.tsx`
   *   - ensures `@elevenlabs/react` is in package.json
   *
   * Object form reserved for Phase 3 sub-toggles
   * (e.g. `{ phoneNumber: true }` for Twilio provisioning).
   */
  voice?:
    | boolean
    | {
        /** Whether to provision a Twilio phone number on preflight. */
        phoneNumber?: boolean
      }
}

interface ShogoConfig {
  /** Path to Prisma schema file */
  schema: string
  /** Models to include (default: all) */
  models?: string[]
  /** Models to exclude */
  excludeModels?: string[]
  /** Output configurations */
  outputs: OutputConfig[]
  /**
   * Feature flags. When a feature is enabled, the CLI:
   *   1. auto-includes the relevant `generate` kinds in `outputs[0]`
   *      (so users don't have to wire voice-components by hand), and
   *   2. runs `deps-doctor` against `package.json` to ensure the
   *      runtime deps for that feature are present.
   */
  features?: ShogoFeatures
}

/** Voice feature is on when set to `true` or `{ ... }`. */
function isVoiceEnabled(features?: ShogoFeatures): boolean {
  return features?.voice === true || (typeof features?.voice === 'object' && features.voice !== null)
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
  enable <feature>      Enable a feature in shogo.config.json and re-run codegen
                          (voice | voice.phoneNumber)
  dev                   Runtime-token preflight then passthrough to \`bun run dev\`
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
// `shogo enable <feature>` — flip a feature on in shogo.config.json and
// re-run codegen / deps-doctor.
// ============================================================================

/**
 * Enable a feature in `shogo.config.json`.
 *
 * Supported feature keys:
 *   - `voice`                       → `features.voice = true`
 *   - `voice.phoneNumber`           → `features.voice = { phoneNumber: true }`
 *
 * The command:
 *   1. Reads (or creates) `shogo.config.json`
 *   2. Merges the feature into `features.*` (preserving existing sub-flags)
 *   3. Writes the config back
 *   4. Execs `shogo generate` so generators + deps-doctor run immediately
 *
 * Keeping it a thin wrapper around `generate` means `enable` and `generate`
 * stay consistent — there's only one code path for producing the pod
 * layout, no matter how the user toggles features.
 */
async function handleEnableCommand() {
  const feature = positionals[1]
  const cwd = process.cwd()

  if (!feature || values.help) {
    console.log(`\nshogo enable <feature>\n\nEnable a Shogo feature in shogo.config.json and re-run codegen.\n\nFeatures:\n  voice                 Enable voice (emits VoiceButton/VoiceSphere/PhoneButton + shogo client)\n  voice.phoneNumber     Enable voice + Twilio phone-number provisioning\n\nExamples:\n  shogo enable voice\n  shogo enable voice.phoneNumber\n`)
    process.exit(feature ? 0 : 1)
  }

  const configPath = resolve(cwd, (values.config as string | undefined) ?? 'shogo.config.json')
  let config: ShogoConfig
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as ShogoConfig
    } catch (err) {
      console.error(`❌ Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  } else {
    // Minimal scaffold: server-only (no models) pointing at the pod's src dir.
    config = {
      schema: './prisma/schema.prisma',
      outputs: [
        {
          dir: './src/generated',
          generate: [],
          perModel: true,
        },
      ],
    }
  }

  config.features = config.features ?? {}

  const [head, tail] = feature.split('.') as [string, string | undefined]
  if (head === 'voice') {
    if (tail === 'phoneNumber') {
      const existing = config.features.voice
      const base = typeof existing === 'object' && existing !== null ? existing : {}
      config.features.voice = { ...base, phoneNumber: true }
    } else if (!tail) {
      // Preserve sub-flags if voice was already an object
      if (typeof config.features.voice !== 'object' || config.features.voice === null) {
        config.features.voice = true
      }
    } else {
      console.error(`❌ Unknown voice sub-feature: voice.${tail}`)
      console.error('   Supported: voice, voice.phoneNumber')
      process.exit(1)
    }
  } else {
    console.error(`❌ Unknown feature: ${feature}`)
    console.error('   Supported: voice, voice.phoneNumber')
    process.exit(1)
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  console.log(`✅ Enabled "${feature}" in ${configPath}`)
  console.log('')
  console.log('▶️  Running `shogo generate` to wire generators and deps...')
  console.log('')

  // Exec generate in-process by invoking this same script recursively.
  // Keeps a single source of truth for the generate pipeline.
  const selfPath = resolve(import.meta.dir, 'shogo.ts')
  try {
    execSync(`bun ${JSON.stringify(selfPath)} generate${values.config ? ` --config ${JSON.stringify(values.config)}` : ''}`, {
      stdio: 'inherit',
      cwd,
    })
  } catch {
    process.exit(1)
  }
}

// ============================================================================
// `shogo dev` — preflight against the Shogo API via runtime-token, then
// fall through to the user's dev script.
// ============================================================================

/**
 * Dev preflight.
 *
 * Reads `RUNTIME_AUTH_SECRET`, `PROJECT_ID`, `SHOGO_API_URL` from the env
 * (all three are injected into pods at assign-time). If any are missing,
 * we skip the preflight — local dev without a warm pool is still valid.
 *
 * When the env is present AND `features.voice` is enabled, we:
 *   1. `GET /api/voice/config/:projectId?projectId=<id>` with `x-runtime-token`
 *   2. If voice is not yet provisioned (no agent), print a diagnostic
 *      pointing at the Studio
 *   3. If `features.voice.phoneNumber` is on but the config reports no
 *      `phoneNumber`, POST to the Twilio provision route (idempotent)
 *
 * After the preflight, `shogo dev` execs `bun run dev` so the command is a
 * transparent replacement for `bun run dev` in generated pod apps.
 */
async function handleDevCommand() {
  const cwd = process.cwd()
  const config = loadConfig(cwd)

  const projectId = process.env.PROJECT_ID
  const runtimeToken = process.env.RUNTIME_AUTH_SECRET
  const apiUrl = process.env.SHOGO_API_URL ?? 'http://localhost:8002'

  const voiceEnabled = isVoiceEnabled(config?.features)
  const phoneEnabled =
    typeof config?.features?.voice === 'object' &&
    config.features.voice !== null &&
    config.features.voice.phoneNumber === true

  if (!projectId || !runtimeToken) {
    console.log('⊘ shogo dev preflight skipped (no PROJECT_ID / RUNTIME_AUTH_SECRET in env).')
  } else if (voiceEnabled) {
    const configUrl = `${apiUrl}/api/voice/config/${encodeURIComponent(projectId)}?projectId=${encodeURIComponent(projectId)}`
    console.log(`🔎 shogo dev preflight: GET ${configUrl}`)
    try {
      const res = await fetch(configUrl, {
        headers: { 'x-runtime-token': runtimeToken },
      })
      if (!res.ok) {
        console.warn(`   ⚠️ Preflight returned ${res.status} ${res.statusText}`)
        const body = await res.text().catch(() => '')
        if (body) console.warn(`      ${body.slice(0, 400)}`)
      } else {
        const cfg = (await res.json().catch(() => null)) as
          | { agentId?: string; phoneNumber?: string | null }
          | null
        console.log(`   ✓ voice.agentId=${cfg?.agentId ?? '(none)'}`)
        console.log(`   ✓ voice.phoneNumber=${cfg?.phoneNumber ?? '(none)'}`)

        if (phoneEnabled && !cfg?.phoneNumber) {
          const provisionUrl = `${apiUrl}/api/voice/twilio/provision-number/${encodeURIComponent(projectId)}?projectId=${encodeURIComponent(projectId)}`
          console.log(`📞 Provisioning Twilio phone number: POST ${provisionUrl}`)
          const prov = await fetch(provisionUrl, {
            method: 'POST',
            headers: {
              'x-runtime-token': runtimeToken,
              'content-type': 'application/json',
            },
            body: '{}',
          })
          if (!prov.ok) {
            console.warn(`   ⚠️ Provisioning failed: ${prov.status} ${prov.statusText}`)
          } else {
            console.log('   ✓ Phone number provisioned')
          }
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Preflight fetch failed: ${err instanceof Error ? err.message : err}`)
      console.warn('     (is the Shogo API reachable at SHOGO_API_URL?)')
    }
  } else {
    console.log('⊘ shogo dev preflight: voice feature disabled, nothing to check.')
  }

  // Transparent passthrough to the app's `dev` script.
  const devScript = positionals[1] ?? 'dev'
  console.log(`\n▶️  bun run ${devScript}`)
  try {
    execSync(`bun run ${devScript}`, { stdio: 'inherit', cwd })
  } catch {
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

  // Handle enable command (flip a feature flag in shogo.config.json)
  if (command === 'enable') {
    await handleEnableCommand()
    process.exit(0)
  }

  // Handle dev command (runtime-token preflight + passthrough to `bun run dev`)
  if (command === 'dev') {
    await handleDevCommand()
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

    // Auto-inject voice-feature generators when `features.voice` is on
    // and the user hasn't explicitly listed them. Picks the first
    // output as the "client" output (where src/ lives). This is what
    // makes `features.voice: true` a one-flag switch.
    if (isVoiceEnabled(config.features) && outputs.length > 0) {
      const first = outputs[0]!
      if (!first.generate.includes('shogo-client')) {
        first.generate = [...first.generate, 'shogo-client']
      }
      if (!first.generate.includes('voice-components')) {
        first.generate = [...first.generate, 'voice-components']
      }
      // Default: emit components at <first.dir>/components/shogo. Users
      // who want a different layout should list `voice-components` as
      // its own `outputs[]` entry with a custom `dir`.
      first.voiceComponents = first.voiceComponents ?? {}
    }
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

  // Detect if running inside a Shogo runtime environment.
  // When PORT is set and we're inside a pod, pause the Vite build watcher
  // to prevent crashes from rapid file writes during code generation.
  // The resume call at the end triggers a fresh build + backend server restart.
  const runtimePort = process.env.RUNTIME_PORT || process.env.PORT
  const isInsideRuntime = !!runtimePort && existsSync(resolve(cwd, 'server.tsx'))
  
  if (isInsideRuntime) {
    console.log(`📡 Detected runtime (port ${runtimePort})`)
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
  // Regenerate the Prisma client and push schema changes — but only when the
  // schema actually defines models. A zero-model schema only needs server.tsx.
  const hasPrisma = existsSync(schemaPath)
  const schemaHasModels = hasPrisma && /^\s*model\s+\w+/m.test(readFileSync(schemaPath, 'utf-8'))

  if (hasPrisma && schemaHasModels) {
    console.log('🔧 Updating Prisma client and database...')
    
    try {
      console.log('   Running prisma generate...')
      pkg.prismaGenerate(cwd, { stdio: values.verbose ? 'inherit' : 'pipe' })
      console.log('   ✓ Prisma client generated')
    } catch (err) {
      console.warn(`   ⚠️ prisma generate failed: ${err instanceof Error ? err.message : err}`)
    }
    
    // Push schema to database (only if DATABASE_URL is set)
    if (process.env.DATABASE_URL) {
      try {
        console.log('   Running prisma db push...')
        pkg.prismaDbPush(cwd, { acceptDataLoss: true, stdio: values.verbose ? 'inherit' : 'pipe' })
        console.log('   ✓ Database schema synced')
      } catch (err) {
        console.warn(`   ⚠️ prisma db push failed: ${err instanceof Error ? err.message : err}`)
      }
    } else {
      console.log('   ⊘ Skipping db push (no DATABASE_URL)')
    }
    
    console.log('')
  } else if (hasPrisma && !schemaHasModels) {
    console.log('⊘ Schema has no models — skipping prisma generate/db push')
    console.log('')
  }
  
  // ── Step 2.5: deps-doctor — reconcile feature deps with package.json ──
  if (config?.features) {
    const depsReport = ensureFeatureDeps({
      cwd,
      features: config.features,
    })
    if (depsReport.modified) {
      console.log('💊 deps-doctor: added feature dependencies to package.json')
      for (const [name, range] of Object.entries(depsReport.added)) {
        console.log(`   + ${name}@${range}`)
      }
      console.log('   → run `bun install` to materialize the new deps')
      console.log('')
    }
    for (const w of depsReport.warnings) {
      console.warn(`⚠️  deps-doctor: ${w}`)
    }
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
    if (result.models.length > 0) {
      console.log(`✅ Generated ${result.files.length} files for ${result.models.length} models`)
      console.log(`   Models: ${result.models.join(', ')}`)
    } else {
      console.log(`✅ Generated ${result.files.length} files (no models — server-only)`)
    }

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
            pkg.installSync(absDocsDir, { stdio: values.verbose ? 'inherit' : 'pipe' })
            console.log('   ✓ Dependencies installed')
          }

          // Build the static site
          console.log('   Building static site...')
          pkg.execToolSync('docusaurus', ['build'], absDocsDir, {
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
