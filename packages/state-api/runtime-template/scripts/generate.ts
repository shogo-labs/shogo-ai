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

import { existsSync, mkdirSync, writeFileSync } from 'fs'
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
    ' * This file is safe to edit - it will not be overwritten by `bun run generate`.',
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
 * DO NOT EDIT - regenerate with \`bun run generate\`
 */

// Types
export * from './types'

// Server Functions
export * from './server-functions'

// Domain Store
export * from './domain'

// Hooks
export { hooks } from './hooks'
`
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

    console.log('')
    console.log('Generation complete! The app will auto-rebuild.')

  } catch (error: any) {
    console.error('Generation failed:', error.message)
    process.exit(1)
  }
}

main()
