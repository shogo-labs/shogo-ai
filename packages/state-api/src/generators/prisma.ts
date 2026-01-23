/**
 * Prisma Schema Generator: Convert Prisma schema to Enhanced JSON Schema
 *
 * Enables using Prisma schema as source of truth for domain stores:
 *   Prisma Schema → Enhanced JSON Schema → domain() → MST Store with CRUD
 *
 * Features:
 * - Parses Prisma schema using @prisma/internals DMMF
 * - Maps Prisma types to JSON Schema types
 * - Handles relations as MST references
 * - Supports enums, optional fields, defaults
 * - Extracts x-persistence metadata from @@map annotations
 */

import type { EnhancedJsonSchema } from "../schematic/types"

// Prisma DMMF types (from @prisma/internals) - made readonly-compatible
interface PrismaField {
  readonly name: string
  readonly kind: "scalar" | "object" | "enum" | "unsupported" | string
  readonly type: string
  readonly isRequired: boolean
  readonly isList: boolean
  readonly isUnique: boolean
  readonly isId: boolean
  readonly isReadOnly: boolean
  readonly isGenerated: boolean
  readonly isUpdatedAt: boolean
  readonly hasDefaultValue: boolean
  readonly default?: any
  readonly relationName?: string
  readonly relationFromFields?: readonly string[]
  readonly relationToFields?: readonly string[]
  readonly relationOnDelete?: string
  readonly documentation?: string
}

interface PrismaModel {
  readonly name: string
  readonly dbName?: string | null
  readonly fields: readonly PrismaField[]
  readonly primaryKey?: { readonly name?: string; readonly fields: readonly string[] } | null
  readonly uniqueFields: readonly (readonly string[])[]
  readonly uniqueIndexes: readonly { readonly name?: string; readonly fields: readonly string[] }[]
  readonly documentation?: string
  readonly isGenerated: boolean
}

interface PrismaEnum {
  readonly name: string
  readonly values: readonly { readonly name: string; readonly dbName?: string }[]
  readonly dbName?: string | null
  readonly documentation?: string
}

interface PrismaDMMF {
  readonly datamodel: {
    readonly models: readonly PrismaModel[]
    readonly enums: readonly PrismaEnum[]
    readonly types: readonly PrismaModel[]
  }
}

/**
 * Configuration for Prisma schema conversion
 */
export interface PrismaToSchemaConfig {
  /** Path to the Prisma schema file */
  schemaPath?: string
  /** Raw Prisma schema string (alternative to schemaPath) */
  schemaString?: string
  /** Schema name/title for the output */
  name?: string
  /** Models to include (default: all) */
  includeModels?: string[]
  /** Models to exclude */
  excludeModels?: string[]
  /** Generate x-persistence metadata from @@map (default: true) */
  includePersistenceMetadata?: boolean
  /** Include documentation as descriptions (default: true) */
  includeDocumentation?: boolean
}

/**
 * Result of Prisma schema conversion
 */
export interface PrismaToSchemaResult {
  /** The Enhanced JSON Schema */
  schema: EnhancedJsonSchema
  /** List of models that were converted */
  models: string[]
  /** List of enums that were converted */
  enums: string[]
  /** Any warnings during conversion */
  warnings: string[]
}

/**
 * Map Prisma scalar types to JSON Schema types
 */
const PRISMA_TYPE_MAP: Record<string, { type: string; format?: string }> = {
  String: { type: "string" },
  Int: { type: "integer" },
  Float: { type: "number" },
  Decimal: { type: "number" },
  BigInt: { type: "integer" },
  Boolean: { type: "boolean" },
  DateTime: { type: "number" }, // Store as epoch timestamp for MST
  Json: { type: "object" },
  Bytes: { type: "string", format: "base64" },
}

/**
 * Parse Prisma schema and return DMMF
 * Uses dynamic import to handle @prisma/internals
 */
async function parsePrismaSchema(config: PrismaToSchemaConfig): Promise<PrismaDMMF> {
  try {
    // Dynamic import to avoid bundling issues
    const { getDMMF } = await import("@prisma/internals")

    if (config.schemaPath) {
      // Read the file and pass as datamodel string
      const { readFileSync } = await import("fs")
      const schemaString = readFileSync(config.schemaPath, "utf-8")
      return await getDMMF({ datamodel: schemaString }) as unknown as PrismaDMMF
    } else if (config.schemaString) {
      return await getDMMF({ datamodel: config.schemaString }) as unknown as PrismaDMMF
    } else {
      throw new Error("Either schemaPath or schemaString must be provided")
    }
  } catch (error: any) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.message?.includes("Cannot find")) {
      throw new Error(
        "Failed to load @prisma/internals. Please install it:\n" +
          "  bun add -D @prisma/internals"
      )
    }
    throw error
  }
}

/**
 * Convert a Prisma field to JSON Schema property definition
 */
function convertField(
  field: PrismaField,
  enums: Map<string, PrismaEnum>,
  models: Map<string, PrismaModel>,
  warnings: string[]
): { def: any; isRequired: boolean } {
  let def: any = {}

  // Handle identifier fields
  if (field.isId) {
    def = {
      type: "string",
      "x-mst-type": "identifier",
    }
    // Add format hint based on default - only use UUID format for actual uuid() defaults
    // CUID and other ID formats should remain as plain strings for flexibility
    if (field.default?.name === "uuid") {
      def.format = "uuid"
    }
    return { def, isRequired: true }
  }

  // Handle relations (object kind)
  if (field.kind === "object") {
    if (field.isList) {
      // Array relation - this becomes a computed array in MST
      def = {
        type: "array",
        items: { $ref: `#/$defs/${field.type}` },
        "x-reference-type": "array",
        "x-reference-target": field.type,
        "x-computed": true, // Computed from the inverse side
        "x-inverse": field.relationName,
      }
    } else {
      // Single relation - becomes a reference
      def = {
        "x-mst-type": "reference",
        "x-reference-target": field.type,
        "x-reference-type": "single",
      }
      // If optional, wrap as maybe-reference
      if (!field.isRequired) {
        def["x-mst-type"] = "maybe-reference"
      }
    }
    return { def, isRequired: field.isRequired && !field.isList }
  }

  // Handle enums
  if (field.kind === "enum") {
    const enumDef = enums.get(field.type)
    if (enumDef) {
      def = {
        type: "string",
        enum: enumDef.values.map((v) => v.name),
      }
      // Handle enum default value (Prisma returns { name: "VALUE", args: [] })
      if (field.hasDefaultValue && field.default !== undefined) {
        if (typeof field.default === "object" && field.default?.name) {
          def.default = field.default.name
        } else if (typeof field.default === "string") {
          def.default = field.default
        }
      }
    } else {
      warnings.push(`Enum '${field.type}' not found for field '${field.name}'`)
      def = { type: "string" }
    }
    return { def, isRequired: field.isRequired }
  }

  // Handle scalar types
  const typeMapping = PRISMA_TYPE_MAP[field.type]
  if (typeMapping) {
    def = { ...typeMapping }
  } else {
    warnings.push(`Unknown Prisma type '${field.type}' for field '${field.name}', defaulting to string`)
    def = { type: "string" }
  }

  // Handle arrays of scalars
  if (field.isList) {
    def = {
      type: "array",
      items: def,
    }
  }

  // Add default value if present
  if (field.hasDefaultValue && field.default !== undefined) {
    // Handle Prisma function defaults
    if (typeof field.default === "object" && field.default?.name) {
      // Functions like now(), uuid(), cuid(), autoincrement()
      // Don't add to schema - these are database-level defaults
    } else {
      def.default = field.default
    }
  }

  return { def, isRequired: field.isRequired }
}

/**
 * Convert a Prisma model to JSON Schema definition
 */
function convertModel(
  model: PrismaModel,
  enums: Map<string, PrismaEnum>,
  models: Map<string, PrismaModel>,
  config: PrismaToSchemaConfig,
  warnings: string[]
): any {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const field of model.fields) {
    // Skip read-only/generated fields (like relation scalar fields)
    if (field.isReadOnly && field.relationFromFields) {
      continue
    }

    // Skip @updatedAt fields - these are auto-managed
    // But include them in schema for completeness
    const { def, isRequired } = convertField(field, enums, models, warnings)

    // Add documentation as description
    if (config.includeDocumentation && field.documentation) {
      def.description = field.documentation
    }

    properties[field.name] = def

    if (isRequired) {
      required.push(field.name)
    }
  }

  const modelDef: any = {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    // Required by enhancedJsonSchemaToMST to identify this as an entity
    "x-original-name": model.name,
  }

  // Add model documentation
  if (config.includeDocumentation && model.documentation) {
    modelDef.description = model.documentation
  }

  // Add persistence metadata from @@map
  if (config.includePersistenceMetadata !== false && model.dbName) {
    modelDef["x-persistence"] = {
      tableName: model.dbName,
    }
  }

  return modelDef
}

/**
 * Convert Prisma schema to Enhanced JSON Schema
 *
 * @param config - Conversion configuration
 * @returns Enhanced JSON Schema compatible with domain()
 *
 * @example
 * ```typescript
 * import { prismaToEnhancedSchema } from "@shogo/state-api/generators"
 * import { domain } from "@shogo/state-api"
 *
 * // From file
 * const result = await prismaToEnhancedSchema({
 *   schemaPath: "./prisma/schema.prisma",
 *   name: "my-app",
 * })
 *
 * // Create domain
 * const myDomain = domain({
 *   name: "my-app",
 *   from: result.schema,
 * })
 *
 * // Use the store
 * const store = myDomain.createStore()
 * await store.userCollection.insertOne({ id: "1", name: "Alice" })
 * ```
 */
export async function prismaToEnhancedSchema(
  config: PrismaToSchemaConfig
): Promise<PrismaToSchemaResult> {
  const warnings: string[] = []

  // Parse Prisma schema
  const dmmf = await parsePrismaSchema(config)

  // Build lookup maps
  const enumMap = new Map<string, PrismaEnum>()
  for (const enumDef of dmmf.datamodel.enums) {
    enumMap.set(enumDef.name, enumDef)
  }

  const modelMap = new Map<string, PrismaModel>()
  for (const model of dmmf.datamodel.models) {
    modelMap.set(model.name, model)
  }

  // Filter models
  let modelsToConvert = dmmf.datamodel.models
  if (config.includeModels) {
    modelsToConvert = modelsToConvert.filter((m) => config.includeModels!.includes(m.name))
  }
  if (config.excludeModels) {
    modelsToConvert = modelsToConvert.filter((m) => !config.excludeModels!.includes(m.name))
  }

  // Convert models
  const $defs: Record<string, any> = {}
  const convertedModels: string[] = []

  for (const model of modelsToConvert) {
    $defs[model.name] = convertModel(model, enumMap, modelMap, config, warnings)
    convertedModels.push(model.name)
  }

  // Build the Enhanced JSON Schema
  const schema: EnhancedJsonSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: config.name || "PrismaGenerated",
    $defs,
  }

  return {
    schema,
    models: convertedModels,
    enums: Array.from(enumMap.keys()),
    warnings,
  }
}

/**
 * Generate ArkType scope code from Prisma schema
 *
 * This generates TypeScript code that can be written to a file,
 * useful for code-first workflows where you want type safety.
 *
 * @param config - Conversion configuration
 * @returns Generated TypeScript code as string
 *
 * @example
 * ```typescript
 * const code = await prismaToArkTypeCode({
 *   schemaPath: "./prisma/schema.prisma",
 *   name: "MyApp",
 * })
 * writeFileSync("./src/domain.ts", code)
 * ```
 */
export interface ArkTypeCodeConfig extends PrismaToSchemaConfig {
  /** Name for the scope (e.g., "StudioCore" -> StudioCoreScope) */
  scopeName?: string
  /** Additional imports to add at the top */
  additionalImports?: string[]
  /** Code to insert before the scope definition */
  preamble?: string
  /** 
   * Output mode:
   * - "full": Generate scope + domain with enhancements (default)
   * - "schema-only": Generate only the scope (for separate enhancement files)
   */
  mode?: "full" | "schema-only"
  /** Custom enhancements code block (models, collections, rootStore) - only used in "full" mode */
  enhancements?: {
    models?: string
    collections?: string
    rootStore?: string
  }
}

export async function prismaToArkTypeCode(
  config: ArkTypeCodeConfig
): Promise<string> {
  const dmmf = await parsePrismaSchema(config)
  const scopeName = config.scopeName || toPascalCase(config.name || "Generated")

  // Determine which models are included
  const includedModels = new Set<string>()
  for (const model of dmmf.datamodel.models) {
    if (config.excludeModels?.includes(model.name)) continue
    if (config.includeModels && !config.includeModels.includes(model.name)) continue
    includedModels.add(model.name)
  }

  const lines: string[] = [
    '/**',
    ` * ${scopeName} Domain`,
    ' *',
    ' * Auto-generated from Prisma schema by @shogo/state-api',
    ' * Regenerate with: bun run generate:domain',
    ' */',
    '',
    'import { scope } from "arktype"',
  ]

  // Add additional imports
  if (config.additionalImports?.length) {
    for (const imp of config.additionalImports) {
      lines.push(imp)
    }
  }
  lines.push('')

  // Add preamble code
  if (config.preamble) {
    lines.push(config.preamble)
    lines.push('')
  }

  // Collect which enums are actually used by included models
  const usedEnums = new Set<string>()
  for (const model of dmmf.datamodel.models) {
    if (!includedModels.has(model.name)) continue
    for (const field of model.fields) {
      if (field.kind === "enum") {
        usedEnums.add(field.type)
      }
    }
  }

  // Generate enum types (only those used by included models)
  for (const enumDef of dmmf.datamodel.enums) {
    if (!usedEnums.has(enumDef.name)) continue
    const values = enumDef.values.map((v) => `'${v.name}'`).join(" | ")
    lines.push(`// Enum: ${enumDef.name}`)
    lines.push(`export type ${enumDef.name} = ${values}`)
    lines.push('')
  }

  // Generate scope
  lines.push(`export const ${scopeName}Scope = scope({`)

  for (const model of dmmf.datamodel.models) {
    if (!includedModels.has(model.name)) continue

    lines.push(`  ${model.name}: {`)

    for (const field of model.fields) {
      // Skip computed array relations (back-references)
      if (field.kind === "object" && field.isList) continue

      // For relation fields, check if target model is included
      if (field.kind === "object") {
        if (includedModels.has(field.type)) {
          // Target model is included - emit the relation reference
          const optional = !field.isRequired ? '?' : ''
          const quotedName = optional ? `"${field.name}${optional}"` : field.name
          lines.push(`    ${quotedName}: "${field.type}",`)
        }
        // If target not included, we skip the relation field
        // The foreign key scalar field will be emitted below
        continue
      }

      // For scalar fields that are foreign keys to excluded models,
      // we need to emit them as strings
      const relationUsingThisField = model.fields.find(
        f => f.kind === "object" && f.relationFromFields?.includes(field.name)
      )
      if (relationUsingThisField && includedModels.has(relationUsingThisField.type)) {
        // Skip scalar FK field if its relation target is included
        // (the relation field above handles it)
        continue
      }

      const arkType = fieldToArkTypeWithContext(field, dmmf.datamodel.enums, includedModels)
      if (arkType) {
        // Field is optional if: not required, OR has default value, OR is @updatedAt
        // (Prisma auto-populates these, so frontend shouldn't require them)
        const isAutoPopulated = field.isUpdatedAt || field.hasDefaultValue
        const optional = (!field.isRequired || isAutoPopulated) && !field.isId ? '?' : ''
        const quotedName = optional ? `"${field.name}${optional}"` : field.name
        lines.push(`    ${quotedName}: ${arkType},`)
      }
    }

    lines.push(`  },`)
    lines.push('')
  }

  lines.push('})')
  lines.push('')

  // Schema-only mode: the scope is already exported at declaration
  // Just return the code as-is
  if (config.mode === "schema-only") {
    return lines.join('\n')
  }

  // Full mode: generate domain with enhancements
  const domainName = toCamelCase(config.name || "generated")
  lines.push(`export const ${domainName}Domain = domain({`)
  lines.push(`  name: "${config.name || 'generated'}",`)
  lines.push(`  from: ${scopeName}Scope,`)
  lines.push(`  enhancements: {`)
  
  // Models enhancements
  if (config.enhancements?.models) {
    lines.push(`    models: (models) => ({`)
    lines.push(`      ...models,`)
    lines.push(config.enhancements.models)
    lines.push(`    }),`)
  } else {
    lines.push(`    models: (models) => ({ ...models }),`)
  }
  
  // Collections enhancements
  if (config.enhancements?.collections) {
    lines.push(`    collections: (collections) => ({`)
    lines.push(`      ...collections,`)
    lines.push(config.enhancements.collections)
    lines.push(`    }),`)
  } else {
    lines.push(`    collections: (collections) => ({ ...collections }),`)
  }
  
  // Root store enhancements
  if (config.enhancements?.rootStore) {
    lines.push(`    rootStore: (RootModel) =>`)
    lines.push(config.enhancements.rootStore)
  }
  
  lines.push(`  },`)
  lines.push(`})`)
  lines.push('')
  lines.push(`export const create${scopeName}Store = ${domainName}Domain.createStore`)
  lines.push(`export default ${domainName}Domain`)

  return lines.join('\n')
}

/**
 * Convert a Prisma field to ArkType definition string (context-aware)
 * Handles references to models that may not be in the included set
 */
function fieldToArkTypeWithContext(
  field: PrismaField,
  enums: readonly PrismaEnum[],
  includedModels: Set<string>
): string | null {
  // Handle ID - only use UUID format for actual uuid() defaults
  // CUID and other ID formats should remain as plain strings
  if (field.isId) {
    if (field.default?.name === "uuid") {
      return '"string.uuid"'
    }
    return '"string"'
  }

  // Handle relations
  if (field.kind === "object") {
    if (field.isList) {
      // Skip - computed arrays are derived from back-references
      return null
    }
    // Check if the referenced model is included
    if (includedModels.has(field.type)) {
      // Reference to included model
      return `"${field.type}"`
    } else {
      // Referenced model not included - use string for the foreign key
      return '"string"'
    }
  }

  // Handle enums
  if (field.kind === "enum") {
    const enumDef = enums.find((e) => e.name === field.type)
    if (enumDef) {
      const values = enumDef.values.map((v) => `'${v.name}'`).join(" | ")
      return `"${values}"`
    }
    return '"string"'
  }

  // Handle scalars
  const typeMap: Record<string, string> = {
    String: '"string"',
    Int: '"number"',
    Float: '"number"',
    Decimal: '"number"',
    BigInt: '"number"',
    Boolean: '"boolean"',
    DateTime: '"number"', // Epoch timestamp
    Json: '"unknown"',
    Bytes: '"string"',
  }

  let arkType = typeMap[field.type] || '"string"'

  // Handle arrays
  if (field.isList) {
    arkType = `"${arkType.replace(/"/g, '')}[]"`
  }

  return arkType
}


/**
 * Convert string to PascalCase
 */
function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("")
}

/**
 * Convert string to camelCase
 */
function toCamelCase(str: string): string {
  const pascal = toPascalCase(str)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}
