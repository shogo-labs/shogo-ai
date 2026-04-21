#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Generate Script
 *
 * Regenerates all SDK files from schema.prisma.
 * Run with: bun run generate
 *
 * This script is called automatically after schema changes.
 * You can also run it manually if needed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

// Try to import from the monorepo first (for local development), then from npm package
let generators: typeof import('../../../src/generators/index')
try {
  // Monorepo context - import from relative path (when running in SDK examples)
  generators = await import('../../../src/generators/index')
} catch {
  // Installed context - import from published npm package
  generators = await import('@shogo-ai/sdk/generators')
}

const {
  parsePrismaSchema,
  generateServerFunctions,
  generateDomainStore,
  generateTypes,
  generateRoutes,
  generateRoutesIndex,
} = generators

type PrismaModel = Parameters<typeof generateServerFunctions>[0][0]

const PROJECT_DIR = process.cwd()
const SCHEMA_PATH = join(PROJECT_DIR, 'prisma', 'schema.prisma')
const OUTPUT_DIR = join(PROJECT_DIR, 'src', 'generated')

/**
 * Generate hooks template (only if file doesn't exist)
 */
function generateHooksTemplate(models: PrismaModel[]): string {
  const lines: string[] = [
    '/**',
    ' * Server Function Hooks',
    ' *',
    ' * Customize CRUD behavior with before/after hooks.',
    ' * This file is safe to edit - it will not be overwritten by `bunx shogo generate`.',
    ' */',
    '',
    'import type { ServerFunctionHooks } from \'./types\'',
    '',
    'export const hooks: ServerFunctionHooks = {',
  ]

  for (const model of models) {
    const name = model.name
    lines.push(`  ${name}: {`)
    lines.push(`    // beforeList: async (ctx) => { return { where: { userId: ctx.userId } } },`)
    lines.push(`    // beforeCreate: async (input, ctx) => { return { ...input, userId: ctx.userId } },`)
    lines.push(`  },`)
  }

  lines.push('}')
  lines.push('')
  lines.push('export default hooks')
  lines.push('')

  return lines.join('\n')
}

/**
 * Convert a PascalCase model name to kebab-case filename prefix.
 * e.g., "MenuItem" → "menu-item", "BusinessPlan" → "business-plan"
 */
function toFileName(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Clean up stale generated files from previous models.
 *
 * When a user changes their Prisma schema (e.g., from Category/Transaction/Budget
 * to MenuItem/FixedCost/BusinessPlan), the old per-model files remain on disk.
 * This causes import errors in the generated index/routes files.
 *
 * We clean up:
 * - *.routes.{ts,tsx} files that don't match current models
 * - *.hooks.{ts,tsx} files that don't match current models (with warning)
 * - index.tsx if we're generating index.ts (Bun resolves .tsx over .ts)
 */
function cleanupStaleGeneratedFiles(outputDir: string, models: PrismaModel[]): void {
  if (!existsSync(outputDir)) return

  const expectedFileNames = new Set(models.map(m => toFileName(m.name)))
  const files = readdirSync(outputDir)
  const staleFiles: string[] = []

  for (const file of files) {
    // Check per-model route files: {model-name}.routes.{ts,tsx}
    const routeMatch = file.match(/^(.+)\.routes\.(ts|tsx)$/)
    if (routeMatch) {
      const modelFileName = routeMatch[1]
      if (!expectedFileNames.has(modelFileName)) {
        staleFiles.push(file)
      }
      continue
    }

    // Check per-model hook files: {model-name}.hooks.{ts,tsx}
    const hookMatch = file.match(/^(.+)\.hooks\.(ts|tsx)$/)
    if (hookMatch) {
      const modelFileName = hookMatch[1]
      if (!expectedFileNames.has(modelFileName)) {
        staleFiles.push(file)
      }
      continue
    }

    // Clean up index.tsx if we're about to write index.ts
    // Bun's module resolution prefers .tsx over .ts, causing conflicts
    if (file === 'index.tsx') {
      staleFiles.push(file)
      continue
    }
  }

  if (staleFiles.length > 0) {
    console.log(`   🧹 Cleaning up ${staleFiles.length} stale generated file(s):`)
    for (const file of staleFiles) {
      const filePath = join(outputDir, file)
      try {
        unlinkSync(filePath)
        console.log(`      ✗ ${file} (deleted)`)
      } catch (err: any) {
        console.warn(`      ⚠️ Failed to delete ${file}: ${err.message}`)
      }
    }
  }
}

/**
 * Generate index file
 */
function generateIndexFile(): string {
  return `/**
 * Generated Shogo SDK Code
 *
 * DO NOT EDIT - regenerate with \`bunx shogo generate\`
 */

// Types
export * from './types'

// Server Functions (client-side fetch-based API calls)
export * from './server-functions'

// Domain Store
export * from './domain'

// Hooks
export { hooks } from './hooks'

// Server-side Hono Routes (used by server.tsx)
export { createAllRoutes } from './routes'
`
}

/**
 * Pause the Vite build watcher before writing generated files.
 * This prevents the watcher from crashing due to rapid file writes.
 * If the runtime server isn't available (e.g. running locally), this is a no-op.
 */
async function pauseWatcher(): Promise<boolean> {
  const runtimePort = process.env.RUNTIME_PORT || process.env.PORT || '8080'
  try {
    const res = await fetch(`http://localhost:${runtimePort}/preview/watch/pause`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json() as { paused: boolean }
      if (data.paused) {
        console.log('   ⏸️  Paused build watcher')
        return true
      }
    }
  } catch {
    // Runtime server not available (local dev, etc.) - that's fine
  }
  return false
}

/**
 * Resume the Vite build watcher after writing generated files.
 * This triggers a fresh build and restarts watch mode.
 */
async function resumeWatcher(): Promise<void> {
  const runtimePort = process.env.RUNTIME_PORT || process.env.PORT || '8080'
  try {
    console.log('   ▶️  Resuming build watcher...')
    const res = await fetch(`http://localhost:${runtimePort}/preview/watch/resume`, { method: 'POST' })
    if (res.ok) {
      const data = await res.json() as { resumed: boolean; buildSuccess?: boolean; durationMs?: number }
      if (data.buildSuccess) {
        console.log(`   ✅ Build complete (${data.durationMs}ms)`)
      } else {
        console.log('   ⚠️  Build had errors - check .build.log')
      }
    }
  } catch {
    // Runtime server not available - that's fine
  }
}

async function main() {
  console.log('Regenerating SDK files from schema.prisma...')

  if (!existsSync(SCHEMA_PATH)) {
    console.error(`Schema not found: ${SCHEMA_PATH}`)
    process.exit(1)
  }

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  // Pause the Vite watcher before writing files to prevent crashes
  const watcherWasPaused = await pauseWatcher()

  try {
    const dmmf = await parsePrismaSchema(SCHEMA_PATH)
    const models = dmmf.datamodel.models
    const enums = dmmf.datamodel.enums

    console.log(`   Found ${models.length} model(s): ${models.map(m => m.name).join(', ')}`)

    // Generate types.ts
    writeFileSync(join(OUTPUT_DIR, 'types.ts'), generateTypes(models, enums))
    console.log('   types.ts')

    // Generate server-functions.ts
    writeFileSync(join(OUTPUT_DIR, 'server-functions.ts'), generateServerFunctions(models))
    console.log('   server-functions.ts')

    // Generate domain.ts
    writeFileSync(join(OUTPUT_DIR, 'domain.ts'), generateDomainStore(models))
    console.log('   domain.ts')

    // Clean up stale generated files from previous models
    cleanupStaleGeneratedFiles(OUTPUT_DIR, models)

    // Generate server-side Hono route files (per-model CRUD)
    const { routes, hooks: routeHooks } = generateRoutes(models, { fileExtension: 'ts' })

    for (const route of routes) {
      writeFileSync(join(OUTPUT_DIR, route.fileName), route.code)
      console.log(`   ${route.fileName}`)
    }

    for (const routeHook of routeHooks) {
      const routeHookPath = join(OUTPUT_DIR, routeHook.fileName)
      if (!existsSync(routeHookPath)) {
        writeFileSync(routeHookPath, routeHook.code)
        console.log(`   ${routeHook.fileName} (new)`)
      } else {
        console.log(`   ${routeHook.fileName} (skipped - user file)`)
      }
    }

    // Generate routes index (createAllRoutes entry point)
    writeFileSync(join(OUTPUT_DIR, 'routes.ts'), generateRoutesIndex(models))
    console.log('   routes.ts')

    // Generate hooks.ts (only if doesn't exist)
    const hooksPath = join(OUTPUT_DIR, 'hooks.ts')
    if (!existsSync(hooksPath)) {
      writeFileSync(hooksPath, generateHooksTemplate(models))
      console.log('   hooks.ts (new)')
    } else {
      console.log('   hooks.ts (skipped - user file)')
    }

    // Generate index.ts
    writeFileSync(join(OUTPUT_DIR, 'index.ts'), generateIndexFile())
    console.log('   index.ts')

    // Patch server.tsx to mount generated API routes (if not already done)
    const serverPath = join(PROJECT_DIR, 'server.tsx')
    if (existsSync(serverPath)) {
      const serverContent = readFileSync(serverPath, 'utf-8')
      if (!serverContent.includes('createAllRoutes')) {
        console.log('')
        console.log('Patching server.tsx to mount API routes...')
        // Add import for createAllRoutes and prisma
        let patched = serverContent
        // Add imports after the last existing import
        const importInsertPoint = patched.lastIndexOf('\nimport ')
        const importEndLine = patched.indexOf('\n', importInsertPoint + 1)
        const newImports = [
          `\nimport { createAllRoutes } from './src/generated/routes'`,
          `import { prisma } from './src/lib/db'`,
        ].join('\n')
        patched = patched.slice(0, importEndLine) + newImports + '\n' + patched.slice(importEndLine)

        // Add route mounting before static file serving
        const staticLineIdx = patched.indexOf("serveStatic({ root:")
        if (staticLineIdx !== -1) {
          const lineStart = patched.lastIndexOf('\n', staticLineIdx)
          // Walk back to include the app.use('/*' line
          const insertBefore = patched.lastIndexOf('\n', lineStart - 1)
          const routeMount = `\n// Mount SDK-generated API routes\napp.route('/api', createAllRoutes(prisma))\n`
          patched = patched.slice(0, insertBefore) + routeMount + patched.slice(insertBefore)
        }

        writeFileSync(serverPath, patched)
        console.log('   server.tsx patched with API route mounting')
      }
    }

    // Run db:push to apply schema changes to database (non-destructive)
    console.log('')
    console.log('Pushing schema to database...')
    const dbPush = Bun.spawn(['bun', 'run', 'db:push'], {
      cwd: PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    
    const pushExitCode = await dbPush.exited
    if (pushExitCode !== 0) {
      const pushStderr = await new Response(dbPush.stderr).text()
      console.warn('db:push failed (incompatible schema change), falling back to prisma migrate dev...')
      console.warn('   Reason:', pushStderr.split('\n')[0])

      const migrate = Bun.spawn(['bunx', '--bun', 'prisma', 'migrate', 'dev', '--name', 'auto'], {
        cwd: PROJECT_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const migrateExitCode = await migrate.exited
      if (migrateExitCode !== 0) {
        const migrateStderr = await new Response(migrate.stderr).text()
        console.error('prisma migrate dev also failed:', migrateStderr)
        console.error('')
        console.error('The schema change may require manual intervention.')
        console.error('Your existing data has NOT been deleted.')
        process.exit(1)
      }
      console.log('   Database schema updated via migration (existing data preserved)')
    } else {
      console.log('   Database schema updated')
    }

    // Resume the watcher (triggers fresh build + restarts watch mode)
    if (watcherWasPaused) {
      console.log('')
      await resumeWatcher()
    } else {
      console.log('')
      console.log('Generation complete! The app will auto-rebuild.')
    }

  } catch (error: any) {
    // Resume watcher even on failure so it's not stuck paused
    if (watcherWasPaused) {
      await resumeWatcher()
    }
    console.error('Generation failed:', error.message)
    process.exit(1)
  }
}

main()
