/**
 * Prisma Schema Generator
 *
 * Parses Prisma schema and generates:
 * - TanStack Start server functions (CRUD)
 * - MST domain stores with collections
 * - TypeScript types
 */

import { generateServerFunctions } from './server-functions'
import { generateDomainStore } from './domain-store'
import { generateTypes } from './types-generator'

// ============================================================================
// Types
// ============================================================================

export interface GenerateOptions {
  /** Path to Prisma schema file */
  schemaPath: string
  /** Output directory for generated files */
  outputDir: string
  /** Models to generate (default: all) */
  models?: string[]
  /** Models to exclude */
  excludeModels?: string[]
}

export interface GenerateResult {
  /** Generated files */
  files: GeneratedFile[]
  /** Models that were processed */
  models: string[]
  /** Any warnings */
  warnings: string[]
}

export interface GeneratedFile {
  path: string
  content: string
}

// ============================================================================
// Prisma DMMF Types
// ============================================================================

export interface PrismaField {
  name: string
  kind: 'scalar' | 'object' | 'enum' | 'unsupported'
  type: string
  isRequired: boolean
  isList: boolean
  isId: boolean
  isUnique: boolean
  hasDefaultValue: boolean
  relationName?: string
  relationFromFields?: string[]
}

export interface PrismaModel {
  name: string
  dbName?: string | null
  fields: PrismaField[]
}

export interface PrismaDMMF {
  datamodel: {
    models: PrismaModel[]
    enums: { name: string; values: { name: string }[] }[]
  }
}

// ============================================================================
// Schema Parsing
// ============================================================================

/**
 * Parse Prisma schema file to DMMF
 */
export async function parsePrismaSchema(schemaPath: string): Promise<PrismaDMMF> {
  const { getDMMF } = await import('@prisma/internals')
  const { readFileSync } = await import('fs')
  
  const schemaString = readFileSync(schemaPath, 'utf-8')
  return await getDMMF({ datamodel: schemaString }) as unknown as PrismaDMMF
}

/**
 * Get scalar fields (non-relation) for a model
 */
export function getScalarFields(model: PrismaModel): PrismaField[] {
  return model.fields.filter(f => f.kind === 'scalar' || f.kind === 'enum')
}

/**
 * Get relation fields for a model
 */
export function getRelationFields(model: PrismaModel): PrismaField[] {
  return model.fields.filter(f => f.kind === 'object')
}

/**
 * Get the ID field for a model
 */
export function getIdField(model: PrismaModel): PrismaField | undefined {
  return model.fields.find(f => f.isId)
}

/**
 * Convert model name to camelCase
 */
export function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/**
 * Convert model name to kebab-case
 */
export function toKebabCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

// ============================================================================
// Main Generator
// ============================================================================

/**
 * Generate all code from Prisma schema
 */
export async function generateFromPrisma(options: GenerateOptions): Promise<GenerateResult> {
  const { schemaPath, outputDir, models: includeModels, excludeModels = [] } = options
  const warnings: string[] = []
  const files: GeneratedFile[] = []

  // Parse schema
  const dmmf = await parsePrismaSchema(schemaPath)
  
  // Filter models
  let models = dmmf.datamodel.models
  if (includeModels && includeModels.length > 0) {
    models = models.filter(m => includeModels.includes(m.name))
  }
  models = models.filter(m => !excludeModels.includes(m.name))

  if (models.length === 0) {
    throw new Error('No models found to generate')
  }

  // Generate types
  const typesCode = generateTypes(models, dmmf.datamodel.enums)
  files.push({
    path: `${outputDir}/types.ts`,
    content: typesCode,
  })

  // Generate server functions
  const serverFunctionsCode = generateServerFunctions(models)
  files.push({
    path: `${outputDir}/server-functions.ts`,
    content: serverFunctionsCode,
  })

  // Generate domain store
  const domainStoreCode = generateDomainStore(models)
  files.push({
    path: `${outputDir}/domain.ts`,
    content: domainStoreCode,
  })

  // Generate hooks template (user-editable)
  const hooksCode = generateHooksTemplate(models)
  files.push({
    path: `${outputDir}/hooks.ts`,
    content: hooksCode,
  })

  // Generate index file
  const indexCode = generateIndexFile(models)
  files.push({
    path: `${outputDir}/index.ts`,
    content: indexCode,
  })

  return {
    files,
    models: models.map(m => m.name),
    warnings,
  }
}

/**
 * Generate hooks template for customization
 */
function generateHooksTemplate(models: PrismaModel[]): string {
  const lines: string[] = [
    '/**',
    ' * Server Function Hooks',
    ' *',
    ' * Customize CRUD behavior with before/after hooks.',
    ' * This file is safe to edit - it will not be overwritten.',
    ' */',
    '',
    'import type { ServerFunctionHooks } from \'./types\'',
    '',
    'export const hooks: ServerFunctionHooks = {',
  ]

  for (const model of models) {
    const name = model.name
    lines.push(`  ${name}: {`)
    lines.push(`    // beforeList: async (ctx) => {`)
    lines.push(`    //   // Filter by user ownership`)
    lines.push(`    //   return { where: { userId: ctx.userId } }`)
    lines.push(`    // },`)
    lines.push(`    // beforeCreate: async (input, ctx) => {`)
    lines.push(`    //   // Set userId on create`)
    lines.push(`    //   return { ...input, userId: ctx.userId }`)
    lines.push(`    // },`)
    lines.push(`  },`)
  }

  lines.push('}')
  lines.push('')
  lines.push('export default hooks')
  lines.push('')

  return lines.join('\n')
}

/**
 * Generate index file that exports everything
 */
function generateIndexFile(models: PrismaModel[]): string {
  const lines: string[] = [
    '/**',
    ' * Generated Shogo SDK Code',
    ' *',
    ' * DO NOT EDIT - regenerate with `shogo generate`',
    ' */',
    '',
    '// Types',
    'export * from \'./types\'',
    '',
    '// Server Functions (TanStack Start)',
    'export * from \'./server-functions\'',
    '',
    '// Domain Store (MST/MobX)',
    'export * from \'./domain\'',
    '',
    '// Hooks (customizable)',
    'export { hooks } from \'./hooks\'',
    '',
  ]

  return lines.join('\n')
}
