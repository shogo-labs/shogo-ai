#!/usr/bin/env node
/**
 * Shogo SDK CLI - Published wrapper
 * 
 * This file is the bin entry point for the published @shogo-ai/sdk package.
 * It delegates to the source CLI (bin/shogo.ts) when running from the monorepo,
 * or runs a lightweight generate-only command when installed as a dependency.
 * 
 * In runtime pods, `bunx shogo generate` resolves to this file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'
import { parseArgs } from 'util'

// ============================================================================
// CLI Parsing
// ============================================================================

const { positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    schema: { type: 'string', short: 's' },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
})

const command = positionals[0]

if (!command || command === 'help') {
  console.log(`
Shogo SDK CLI

Usage:
  shogo generate    Generate Prisma client, run db push, and build
  shogo help        Show this help message
`)
  process.exit(0)
}

if (command !== 'generate') {
  console.error(`Unknown command: ${command}`)
  console.error('Available commands: generate, help')
  process.exit(1)
}

// ============================================================================
// Generate Command
// ============================================================================

const cwd = process.cwd()

// Check for prisma schema
const schemaPath = resolve(cwd, 'prisma/schema.prisma')
if (!existsSync(schemaPath)) {
  console.log('[shogo] No prisma/schema.prisma found - skipping generation')
  process.exit(0)
}

console.log('[shogo] Running code generation...')

// Step 1: prisma generate.
// We invoke prisma via `bun x …` rather than `bunx …` because some
// minimal install targets (Linux VM images, bare server containers,
// pre-1.2 manual installs) ship `bun` without the companion `bunx`
// symlink. `bun x` is bun's built-in equivalent and only requires
// `bun` itself to be on PATH.
try {
  console.log('[shogo] Step 1/2: prisma generate')
  execSync('bun x --bun prisma generate', { cwd, stdio: 'inherit' })
} catch (err) {
  console.error('[shogo] prisma generate failed')
  process.exit(1)
}

// Step 2: Run project-level generate script if it exists
// scripts/generate.ts generates SDK files (types, server-functions, domain store,
// routes, hooks, index) from the Prisma schema AND handles db:push itself.
// When present, this is the full generation pipeline.
const generateScript = resolve(cwd, 'scripts/generate.ts')
if (existsSync(generateScript)) {
  try {
    execSync(`bun ${generateScript}`, { cwd, stdio: 'inherit' })
  } catch (err) {
    console.error('[shogo] SDK generation failed (scripts/generate.ts)')
    process.exit(1)
  }
} else {
  // No project-level script - fall back to prisma db push only
  if (process.env.DATABASE_URL) {
    try {
      console.log('[shogo] Step 2/2: prisma db push')
      execSync('bun x --bun prisma db push --accept-data-loss', { cwd, stdio: 'inherit' })
    } catch (err) {
      console.error('[shogo] prisma db push failed (database may not be ready)')
      // Don't exit - generation still succeeded
    }
  } else {
    console.log('[shogo] Step 2/2: skipped prisma db push (no DATABASE_URL)')
  }
}

console.log('[shogo] Generation complete')
