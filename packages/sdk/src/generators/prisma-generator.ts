// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prisma Schema Generator
 *
 * Parses Prisma schema and generates:
 * - Hono routes (per-model)
 * - TypeScript types (per-model)
 * - OptimisticStore instances (per-model)
 * - Docusaurus documentation site
 * - Index files for re-exports
 */

import { generateTypes, generateTypesPerModel, generateTypesIndex } from './types-generator'
import { generateRoutes, generateRoutesIndex } from './routes-generator'
import { generateStores, generateStoresIndex } from './stores-generator'
import { generateMSTModels } from './mst-model-generator'
import { generateMSTCollections } from './mst-collection-generator'
import { generateMSTDomain } from './mst-domain-generator'
import { generateServer, generateDbModule, generateSqliteDbModule } from './server-generator'
import { generateApiClient } from './api-client'
import { generateAuthStore, getUserModel, hasUserModel } from './auth-store-generator'
import { generateDocs } from './docs-generator'
import { generateDocsSiteScaffold, generateDocsTsConfig } from './docs-site-generator'
import { generateAdminRoutes } from './admin-routes-generator'

// ============================================================================
// Types
// ============================================================================

export interface OutputConfig {
  /** Output directory */
  dir: string
  /** What to generate */
  generate: ('routes' | 'hooks' | 'types' | 'stores' | 'mst' | 'server' | 'db' | 'api-client' | 'auth' | 'docs' | 'admin-routes')[]
  /** Generate per-model files (default: true) */
  perModel?: boolean
  /** File extension for generated files: 'ts' or 'tsx' (default: 'tsx') */
  fileExtension?: 'ts' | 'tsx'
  /** Override server generator config (port, import paths, etc.) */
  serverConfig?: import('./server-generator').ServerGeneratorConfig
  /** Database provider for db module generation: 'postgresql' (default) or 'sqlite' */
  dbProvider?: 'postgresql' | 'sqlite'
}

export interface GenerateOptions {
  /** Path to Prisma schema file */
  schemaPath: string
  /** Output directory for generated files (legacy single-dir mode) */
  outputDir?: string
  /** Models to generate (default: all) */
  models?: string[]
  /** Models to exclude */
  excludeModels?: string[]
  /** Multiple output configurations (new per-model mode) */
  outputs?: OutputConfig[]
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
  skipIfExists?: boolean  // If true, don't overwrite if file already exists
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
 * 
 * Note: Prisma 7 uses prisma.config.ts for datasource URL.
 * We pass the config path to getDMMF for proper parsing.
 */
export async function parsePrismaSchema(schemaPath: string): Promise<PrismaDMMF> {
  const { getDMMF } = await import('@prisma/internals')
  const { readFileSync, existsSync } = await import('fs')
  const { dirname, join, resolve } = await import('path')
  
  const schemaString = readFileSync(schemaPath, 'utf-8')
  const schemaDir = dirname(schemaPath)
  const projectRoot = resolve(schemaDir, '..')
  
  // Check for prisma.config.ts in the schema's parent directory (project root)
  const possibleConfigPaths = [
    join(projectRoot, 'prisma.config.ts'),
    join(schemaDir, 'prisma.config.ts'),
  ]
  
  const configPath = possibleConfigPaths.find(p => existsSync(p))
  
  // getDMMF in Prisma 7 requires the config path for datasource URL
  return await getDMMF({ 
    datamodel: schemaString,
    ...(configPath && { prismaConfigPath: configPath }),
  }) as unknown as PrismaDMMF
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
 *
 * Supports two modes:
 * 1. Legacy single-dir mode: outputDir + all types in one file
 * 2. New per-model mode: outputs[] with per-model files
 */
export async function generateFromPrisma(options: GenerateOptions): Promise<GenerateResult> {
  const { schemaPath, outputDir, models: includeModels, excludeModels = [], outputs } = options
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

  const enums = dmmf.datamodel.enums

  // New per-model mode with multiple outputs
  if (outputs && outputs.length > 0) {
    for (const output of outputs) {
      const dir = output.dir
      const perModel = output.perModel !== false // default true
      const ext = output.fileExtension || 'tsx'
      const indexFile = `${dir}/index.${ext}`

      // Generate routes
      if (output.generate.includes('routes')) {
        if (perModel) {
          const { routes, hooks } = generateRoutes(models, { fileExtension: ext })
          
          // Route files
          for (const route of routes) {
            files.push({
              path: `${dir}/${route.fileName}`,
              content: route.code,
            })
          }
          
          // Hooks files (only if hooks requested)
          // IMPORTANT: Skip hooks files that already exist - they're meant to be edited by users
          if (output.generate.includes('hooks')) {
            for (const hook of hooks) {
              files.push({
                path: `${dir}/${hook.fileName}`,
                content: hook.code,
                skipIfExists: true, // Don't overwrite user customizations
              })
            }
          }
          
          // Routes index
          files.push({
            path: indexFile,
            content: generateRoutesIndex(models),
          })
        }
      }

      // Generate types
      if (output.generate.includes('types')) {
        if (perModel) {
          const typeFiles = generateTypesPerModel(models, enums, ext)
          for (const typeFile of typeFiles) {
            files.push({
              path: `${dir}/${typeFile.fileName}`,
              content: typeFile.code,
            })
          }
          
          // Create types re-export file (for api-client imports)
          files.push({
            path: `${dir}/types.${ext}`,
            content: generateTypesIndex(models),
          })
          
          // Also append to index for convenience
          const existingIndex = files.find(f => f.path === indexFile)
          if (existingIndex) {
            existingIndex.content += '\n' + generateTypesIndex(models)
          } else {
            files.push({
              path: indexFile,
              content: generateTypesIndex(models),
            })
          }
        } else {
          // Single file mode
          files.push({
            path: `${dir}/types.${ext}`,
            content: generateTypes(models, enums),
          })
        }
      }

      // Generate stores (plain MobX)
      if (output.generate.includes('stores')) {
        if (perModel) {
          const storeFiles = generateStores(models, { fileExtension: ext })
          for (const storeFile of storeFiles) {
            files.push({
              path: `${dir}/${storeFile.fileName}`,
              content: storeFile.code,
            })
          }
          
          // Stores index (append to existing index or create)
          const existingStoresIndex = files.find(f => f.path === indexFile)
          if (existingStoresIndex) {
            existingStoresIndex.content += '\n' + generateStoresIndex(models)
          } else {
            files.push({
              path: indexFile,
              content: generateStoresIndex(models),
            })
          }
        }
      }

      // Generate MST (MobX-State-Tree)
      if (output.generate.includes('mst')) {
        if (perModel) {
          // Generate MST models (pass enums for proper enum value generation)
          const mstModelFiles = generateMSTModels(models, models, enums, ext)
          for (const modelFile of mstModelFiles) {
            files.push({
              path: `${dir}/${modelFile.fileName}`,
              content: modelFile.code,
            })
          }

          // Generate MST collections
          const mstCollectionFiles = generateMSTCollections(models, ext)
          for (const collectionFile of mstCollectionFiles) {
            files.push({
              path: `${dir}/${collectionFile.fileName}`,
              content: collectionFile.code,
            })
          }

          // Generate domain (root store)
          const domainFile = generateMSTDomain(models, ext)
          files.push({
            path: `${dir}/${domainFile.fileName}`,
            content: domainFile.code,
          })

          // Update or create index to export domain
          const existingMstIndex = files.find(f => f.path === indexFile)
          const mstExports = generateMSTIndex(models)
          if (existingMstIndex) {
            existingMstIndex.content += '\n' + mstExports
          } else {
            files.push({
              path: indexFile,
              content: mstExports,
            })
          }
        }
      }

      // Generate API client (fetch client for browser)
      if (output.generate.includes('api-client')) {
        files.push({
          path: `${dir}/api-client.${ext}`,
          content: generateApiClient(models),
        })
      }

      // Generate auth store (requires User model with email field)
      if (output.generate.includes('auth')) {
        if (hasUserModel(models)) {
          const userModel = getUserModel(models)!
          files.push({
            path: `${dir}/auth.${ext}`,
            content: generateAuthStore({ userModel }),
          })
        } else {
          warnings.push('Auth store generation skipped: No User model with email field found')
        }
      }

      // Generate server entry point (Hono)
      if (output.generate.includes('server')) {
        files.push({
          path: `${dir}/server.${ext}`,
          content: generateServer({
            routesPath: './src/generated',
            dbPath: './src/lib/db',
            ...output.serverConfig,
          }),
          skipIfExists: true, // Don't overwrite user customizations
        })
      }

      // Generate database module (Prisma client)
      if (output.generate.includes('db')) {
        files.push({
          path: `${dir}/db.${ext}`,
          content: output.dbProvider === 'sqlite' ? generateSqliteDbModule() : generateDbModule(),
          skipIfExists: true, // Don't overwrite user customizations
        })
      }

      // Generate Docusaurus documentation site
      if (output.generate.includes('docs')) {
        // Scaffold the Docusaurus site (skipIfExists — won't overwrite user edits)
        const scaffoldFiles = generateDocsSiteScaffold({
          projectName: 'My App',
        })
        for (const sf of scaffoldFiles) {
          files.push({
            path: `${dir}/${sf.path}`,
            content: sf.content,
            skipIfExists: sf.skipIfExists,
          })
        }

        // tsconfig for the docs site
        const tsConfig = generateDocsTsConfig()
        files.push({
          path: `${dir}/${tsConfig.path}`,
          content: tsConfig.content,
          skipIfExists: true,
        })

        // Generate documentation content (always regenerated)
        const docFiles = generateDocs(models, enums, {
          apiBasePath: '/api',
        })
        for (const df of docFiles) {
          files.push({
            path: `${dir}/${df.path}`,
            content: df.content,
            skipIfExists: df.skipIfExists,
          })
        }
      }

      // Generate admin routes (single file with unrestricted CRUD for all models)
      if (output.generate.includes('admin-routes')) {
        const adminFile = generateAdminRoutes(models, { fileExtension: ext as 'ts' | 'tsx' })
        files.push({
          path: `${dir}/${adminFile.fileName}`,
          content: adminFile.code,
        })
      }
    }

    return {
      files,
      models: models.map(m => m.name),
      warnings,
    }
  }

  // Legacy single-dir mode (backward compatible)
  if (!outputDir) {
    throw new Error('Either outputDir or outputs[] must be provided')
  }

  // Generate types (single file)
  const typesCode = generateTypes(models, enums)
  files.push({
    path: `${outputDir}/types.tsx`,
    content: typesCode,
  })

  // Generate hooks template (user-editable)
  const hooksCode = generateHooksTemplate(models)
  files.push({
    path: `${outputDir}/hooks.tsx`,
    content: hooksCode,
  })

  // Generate index file
  const indexCode = generateIndexFile(models)
  files.push({
    path: `${outputDir}/index.tsx`,
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
    '// Server Functions',
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

/**
 * Generate MST index exports
 */
function generateMSTIndex(models: PrismaModel[]): string {
  const lines: string[] = [
    '/**',
    ' * MST Domain Exports',
    ' *',
    ' * Generated by @shogo-ai/sdk - DO NOT EDIT DIRECTLY',
    ' */',
    '',
    '// Domain store (root)',
    'export {',
    '  DomainStore,',
    '  createDomainStore,',
    '  getDomainStore,',
    '  resetDomainStore,',
    '  type IDomainStore,',
    '  type IDomainStoreSnapshotIn,',
    '  type IDomainStoreSnapshotOut,',
    '  type ISDKEnvironment,',
    '} from "./domain"',
    '',
  ]

  return lines.join('\n')
}
