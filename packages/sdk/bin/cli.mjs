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
import { execSync, execFileSync } from 'child_process'
import { parseArgs } from 'util'
import { pathToFileURL } from 'url'

// ============================================================================
// CLI Parsing
// ============================================================================

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    schema: { type: 'string', short: 's' },
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
    prune: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    project: { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
})

const command = positionals[0]

if (!command || command === 'help') {
  console.log(`
Shogo SDK CLI

Usage:
  shogo generate                          Generate Prisma client, run db push, build
  shogo deploy [--prune] [--dry-run]      Reconcile shogo.config.json#agents with cloud
  shogo help                              Show this help message
`)
  process.exit(0)
}

if (command === 'deploy') {
  const cwd = process.cwd()
  const configPath = resolve(cwd, values.config ?? 'shogo.config.json')
  if (!existsSync(configPath)) {
    console.error(`[shogo] shogo.config.json not found at ${configPath}`)
    process.exit(1)
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (err) {
    console.error('[shogo] Failed to parse shogo.config.json:', err.message)
    process.exit(1)
  }

  // The deploy module is published as part of @shogo-ai/sdk's `dist`.
  // We resolve it relative to this script (bin/) so the published
  // package can find its compiled sibling without depending on the
  // user's bundler. Falls back to require() so older Node/Bun
  // versions without dynamic-import-in-CJS work.
  let deploy
  try {
    // Convert to a file:// URL so absolute paths containing spaces (e.g.
    // macOS "/Users/<u>/Library/Application Support/...") survive the
    // dynamic import. Bare absolute paths trip ERR_INVALID_FILE_URL_PATH.
    const deployPath = resolve(dirname(new URL(import.meta.url).pathname), '../dist/cli/deploy.js')
    deploy = await import(pathToFileURL(deployPath).href)
  } catch (err) {
    console.error('[shogo] Failed to load deploy module:', err.message)
    console.error('   (this usually means @shogo-ai/sdk was not built; run `bun run build` in the package)')
    process.exit(1)
  }

  const { agents, issues } = deploy.validateManifest(cfg.agents ?? {})
  if (issues.length > 0) {
    console.error('[shogo] Manifest validation failed:')
    for (const i of issues) console.error(`   - ${i.path}: ${i.message}`)
    process.exit(1)
  }

  const apiUrl = process.env.SHOGO_API_URL ?? 'https://api.shogo.ai'
  const projectId = values.project ?? process.env.PROJECT_ID
  const shogoApiKey = process.env.SHOGO_API_KEY
  if (!projectId) {
    console.error('[shogo] Missing PROJECT_ID (or --project)')
    process.exit(1)
  }
  if (!shogoApiKey) {
    console.error('[shogo] Missing SHOGO_API_KEY')
    process.exit(1)
  }

  const result = await deploy.runDeploy({
    apiUrl,
    projectId,
    shogoApiKey,
    manifest: agents,
    prune: values.prune === true,
    dryRun: values['dry-run'] === true,
  })
  if (result.status >= 400) {
    console.error(`[shogo] deploy failed (${result.status}):`)
    console.error(JSON.stringify(result.body, null, 2))
    process.exit(1)
  }
  console.log('[shogo] deploy ok:')
  console.log(JSON.stringify(result.body, null, 2))
  process.exit(0)
}

if (command !== 'generate') {
  console.error(`Unknown command: ${command}`)
  console.error('Available commands: generate, deploy, help')
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
    // Use execFileSync (no shell, array argv) so paths containing spaces
    // — e.g. macOS workspaces under "/Users/<u>/Library/Application Support/..." —
    // are passed verbatim as a single argv[1]. Plain execSync hands the
    // command to /bin/sh which tokenizes on whitespace and breaks the
    // module specifier at the first space.
    execFileSync('bun', [generateScript], { cwd, stdio: 'inherit' })
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
