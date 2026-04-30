// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prisma Schema Transformer
 * 
 * Transforms Prisma schemas between PostgreSQL and SQLite providers,
 * handling dialect-specific differences.
 * 
 * This enables a workflow where:
 * - Production uses PostgreSQL
 * - Tests can run with SQLite (fast, no infrastructure)
 * - Tests can also run with PostgreSQL (for integration testing)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'

export type DatabaseProvider = 'postgresql' | 'sqlite'

export interface TransformOptions {
  /** Path to the Prisma schema file */
  schemaPath: string
  /** Target database provider */
  targetProvider: DatabaseProvider
  /** Run prisma generate after transformation */
  generate?: boolean
  /** Run prisma db push after transformation (useful for SQLite) */
  push?: boolean
  /** DATABASE_URL to use (defaults to file:./test.db for SQLite) */
  databaseUrl?: string
  /** Print verbose output */
  verbose?: boolean
}

export interface TransformResult {
  /** Whether the schema was modified */
  modified: boolean
  /** The original provider */
  originalProvider: DatabaseProvider
  /** The new provider */
  newProvider: DatabaseProvider
  /** Path to the schema file */
  schemaPath: string
  /** Any warnings generated during transformation */
  warnings: string[]
}

/**
 * One-way transformations: PostgreSQL → SQLite
 * 
 * Note: These transformations are generally one-way because:
 * - cuid() works on both providers (no need to convert to uuid())
 * - String type works on both providers (no need to convert back to Json)
 * 
 * The important thing is that the schema MUST use the correct provider.
 * The schema itself uses compatible types that work with both.
 */
const POSTGRES_TO_SQLITE_TRANSFORMS: { pattern: RegExp; replacement: string }[] = [
  // uuid() is PostgreSQL-specific, use cuid() for compatibility
  { pattern: /@default\(uuid\(\)\)/g, replacement: '@default(cuid())' },
  
  // dbgenerated() with PostgreSQL-specific functions
  { pattern: /@default\(dbgenerated\("gen_random_uuid\(\)"\)\)/g, replacement: '@default(cuid())' },
  
  // auto() is PostgreSQL-specific for autoincrement
  { pattern: /@default\(auto\(\)\)/g, replacement: '@default(autoincrement())' },
  
  // Remove @db.* native type annotations (SQLite doesn't support these)
  { pattern: /@db\.\w+(\([^)]*\))?/g, replacement: '' },
]

/**
 * One-way transformations: SQLite → PostgreSQL
 * 
 * We only convert SQLite-specific things that won't work on PostgreSQL.
 * Most things (like cuid()) work on both providers.
 */
const SQLITE_TO_POSTGRES_TRANSFORMS: { pattern: RegExp; replacement: string }[] = [
  // autoincrement() is SQLite-specific, use auto() for PostgreSQL
  { pattern: /@default\(autoincrement\(\)\)/g, replacement: '@default(auto())' },
]

/**
 * Detect the current provider in a schema
 */
export function detectSchemaProvider(schemaContent: string): DatabaseProvider | null {
  if (schemaContent.includes('provider = "postgresql"') || 
      schemaContent.includes("provider = 'postgresql'")) {
    return 'postgresql'
  }
  if (schemaContent.includes('provider = "sqlite"') || 
      schemaContent.includes("provider = 'sqlite'")) {
    return 'sqlite'
  }
  return null
}

/**
 * Transform a Prisma schema from one provider to another
 */
export function transformSchema(
  schemaContent: string,
  targetProvider: DatabaseProvider
): { content: string; warnings: string[] } {
  const currentProvider = detectSchemaProvider(schemaContent)
  const warnings: string[] = []
  
  if (currentProvider === targetProvider) {
    return { content: schemaContent, warnings: [] }
  }
  
  let result = schemaContent
  
  // Apply provider transformation
  if (targetProvider === 'sqlite') {
    result = result.replace(/provider\s*=\s*"postgresql"/g, 'provider = "sqlite"')
  } else {
    result = result.replace(/provider\s*=\s*"sqlite"/g, 'provider = "postgresql"')
  }
  
  // Apply dialect-specific transformations
  const transforms = targetProvider === 'sqlite' 
    ? POSTGRES_TO_SQLITE_TRANSFORMS 
    : SQLITE_TO_POSTGRES_TRANSFORMS
  
  for (const { pattern, replacement } of transforms) {
    const matches = result.match(pattern)
    if (matches && matches.length > 0) {
      // Add warnings for significant transformations
      if (pattern.source.includes('db\\.')) {
        warnings.push(`Removed PostgreSQL-specific @db.* annotations for SQLite`)
      }
      result = result.replace(pattern, replacement)
    }
  }
  
  // Clean up any double spaces created by removing annotations
  result = result.replace(/  +/g, ' ')
  
  return { content: result, warnings }
}

/**
 * Transform schema and optionally run Prisma commands
 */
export async function transformSchemaFile(options: TransformOptions): Promise<TransformResult> {
  const {
    schemaPath,
    targetProvider,
    generate = true,
    push = false,
    databaseUrl,
    verbose = false,
  } = options
  
  const absolutePath = resolve(process.cwd(), schemaPath)
  
  if (!existsSync(absolutePath)) {
    throw new Error(`Schema file not found: ${absolutePath}`)
  }
  
  // Read current schema
  const originalContent = readFileSync(absolutePath, 'utf-8')
  const originalProvider = detectSchemaProvider(originalContent)
  
  if (!originalProvider) {
    throw new Error('Could not detect database provider in schema')
  }
  
  // Transform
  const { content: newContent, warnings } = transformSchema(originalContent, targetProvider)
  const modified = newContent !== originalContent
  
  if (modified) {
    // Write transformed schema
    writeFileSync(absolutePath, newContent, 'utf-8')
    
    if (verbose) {
      console.log(`Transformed schema from ${originalProvider} to ${targetProvider}`)
    }
  } else if (verbose) {
    console.log(`Schema already using ${targetProvider} provider`)
  }
  
  // Set up environment for Prisma commands
  const env = { ...process.env }
  if (targetProvider === 'sqlite') {
    env.DATABASE_URL = databaseUrl || 'file:./test.db'
  } else if (databaseUrl) {
    env.DATABASE_URL = databaseUrl
  }
  
  const schemaDir = dirname(absolutePath)
  
  // Run prisma generate
  if (generate) {
    if (verbose) {
      console.log('Running prisma generate...')
    }
    try {
      execSync('bun x prisma generate', {
        cwd: schemaDir,
        env,
        stdio: verbose ? 'inherit' : 'pipe',
      })
    } catch (error) {
      throw new Error(`prisma generate failed: ${error}`)
    }
  }
  
  // Run prisma db push (useful for SQLite to create the database)
  if (push) {
    if (verbose) {
      console.log('Running prisma db push...')
    }
    try {
      execSync('bun x prisma db push', {
        cwd: schemaDir,
        env,
        stdio: verbose ? 'inherit' : 'pipe',
      })
    } catch (error) {
      throw new Error(`prisma db push failed: ${error}`)
    }
  }
  
  return {
    modified,
    originalProvider,
    newProvider: targetProvider,
    schemaPath: absolutePath,
    warnings,
  }
}

/**
 * Restore schema to PostgreSQL (the canonical provider)
 */
export async function restoreSchema(schemaPath: string, verbose = false): Promise<void> {
  await transformSchemaFile({
    schemaPath,
    targetProvider: 'postgresql',
    generate: true,
    push: false,
    verbose,
  })
}
