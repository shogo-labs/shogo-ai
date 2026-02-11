#!/usr/bin/env bun
/**
 * Shogo Generate Script
 *
 * Regenerates all SDK files from schema.prisma.
 * Run with: bun run generate
 *
 * This script is called automatically after schema changes.
 * You can also run it manually if needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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

    // Run db:push to apply schema changes to database
    console.log('')
    console.log('Pushing schema to database...')
    const dbPush = Bun.spawn(['bun', 'run', 'db:push'], {
      cwd: PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    
    const exitCode = await dbPush.exited
    if (exitCode !== 0) {
      const stderr = await new Response(dbPush.stderr).text()
      console.error('db:push failed:', stderr)
      process.exit(1)
    }
    console.log('   Database schema updated')

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
