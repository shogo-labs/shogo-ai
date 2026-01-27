/**
 * Prisma Routes Generator: Generate Hono CRUD routes from Prisma schema
 *
 * Features:
 * - Hook system for custom business logic (beforeCreate, afterCreate, etc.)
 * - Prisma Client integration (direct database access)
 * - Filter/include support for relations
 * - Pagination built-in
 * - TypeScript code generation
 *
 * Usage:
 * ```typescript
 * const code = await prismaToRoutesCode({
 *   schemaPath: "./prisma/schema.prisma",
 *   models: ["Workspace", "Project"],
 * })
 * writeFileSync("./src/generated/routes.ts", code)
 * ```
 */

import type { EnhancedJsonSchema } from "../schematic/types"

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Context passed to route hooks
 */
export interface RouteHookContext<TBody = any> {
  /** Request body (for create/update) */
  body: TBody
  /** URL parameters */
  params: Record<string, string>
  /** Query parameters */
  query: Record<string, string>
  /** Authenticated user ID (if available) */
  userId?: string
  /** Prisma client instance */
  prisma: any
}

/**
 * Result from a hook that can modify or reject the operation
 */
export interface HookResult<T = any> {
  /** If false, operation is rejected with error */
  ok: boolean
  /** Error to return if ok is false */
  error?: { code: string; message: string }
  /** Modified data to use instead of original */
  data?: T
}

/**
 * Hooks for customizing route behavior
 */
export interface ModelHooks<TModel = any, TCreateInput = any, TUpdateInput = any> {
  /** Called before creating a record. Can modify input or reject. */
  beforeCreate?: (input: TCreateInput, ctx: RouteHookContext<TCreateInput>) => Promise<HookResult<TCreateInput> | void>
  /** Called after creating a record. Can perform side effects. */
  afterCreate?: (record: TModel, ctx: RouteHookContext<TCreateInput>) => Promise<void>
  /** Called before updating a record. Can modify input or reject. */
  beforeUpdate?: (id: string, input: TUpdateInput, ctx: RouteHookContext<TUpdateInput>) => Promise<HookResult<TUpdateInput> | void>
  /** Called after updating a record. Can perform side effects. */
  afterUpdate?: (record: TModel, ctx: RouteHookContext<TUpdateInput>) => Promise<void>
  /** Called before deleting a record. Can reject deletion. */
  beforeDelete?: (id: string, ctx: RouteHookContext) => Promise<HookResult | void>
  /** Called after deleting a record. Can perform cleanup. */
  afterDelete?: (id: string, ctx: RouteHookContext) => Promise<void>
  /** Called before listing records. Can modify query filters. */
  beforeList?: (ctx: RouteHookContext) => Promise<HookResult<{ where?: any; include?: any }> | void>
  /** Called before getting a single record. Can reject access. */
  beforeGet?: (id: string, ctx: RouteHookContext) => Promise<HookResult | void>
}

/**
 * Custom route definition for non-CRUD operations
 */
export interface CustomRoute {
  /** HTTP method */
  method: "get" | "post" | "put" | "patch" | "delete"
  /** Route path (relative to model base path) */
  path: string
  /** Route handler */
  handler: (ctx: RouteHookContext) => Promise<{ status: number; body: any }>
}

/**
 * Configuration for a model's routes
 */
export interface ModelRouteConfig<TModel = any> {
  /** Hooks for CRUD operations */
  hooks?: ModelHooks<TModel>
  /** Custom routes beyond CRUD */
  customRoutes?: CustomRoute[]
  /** Prisma include for list/get operations */
  include?: Record<string, boolean | object>
  /** Default where clause for list operations */
  defaultWhere?: Record<string, any>
  /** Fields to exclude from responses */
  excludeFields?: string[]
  /** Disable specific CRUD operations */
  disable?: ("list" | "get" | "create" | "update" | "delete")[]
}

// ============================================================================
// Route Generator Configuration
// ============================================================================

/**
 * Configuration for route generation
 */
export interface PrismaRoutesConfig {
  /** Path to Prisma schema file */
  schemaPath?: string
  /** Raw Prisma schema string */
  schemaString?: string
  /** Models to generate routes for (default: all) */
  models?: string[]
  /** Models to exclude from generation */
  excludeModels?: string[]
  /** Base path prefix for all routes (default: '/api') */
  basePath?: string
  /** Per-model configuration */
  modelConfigs?: Record<string, ModelRouteConfig>
}

/**
 * Result of route code generation
 */
export interface PrismaRoutesResult {
  /** Generated TypeScript code */
  code: string
  /** Models that routes were generated for */
  models: string[]
  /** Any warnings during generation */
  warnings: string[]
}

// ============================================================================
// Prisma DMMF Types
// ============================================================================

interface PrismaField {
  readonly name: string
  readonly kind: "scalar" | "object" | "enum" | "unsupported" | string
  readonly type: string
  readonly isRequired: boolean
  readonly isList: boolean
  readonly isId: boolean
  readonly isUnique: boolean
  readonly hasDefaultValue: boolean
  readonly relationName?: string
  readonly relationFromFields?: readonly string[]
}

interface PrismaModel {
  readonly name: string
  readonly dbName?: string | null
  readonly fields: readonly PrismaField[]
}

interface PrismaDMMF {
  readonly datamodel: {
    readonly models: readonly PrismaModel[]
    readonly enums: readonly { readonly name: string; readonly values: readonly { readonly name: string }[] }[]
  }
}

// ============================================================================
// Code Generation
// ============================================================================

/**
 * Parse Prisma schema
 * 
 * Note: Prisma 7 uses prisma.config.ts for datasource URL.
 * We pass the config path to getDMMF for proper parsing.
 */
async function parsePrismaSchema(config: PrismaRoutesConfig): Promise<PrismaDMMF> {
  const { getDMMF } = await import("@prisma/internals")
  
  if (config.schemaPath) {
    const { readFileSync, existsSync } = await import("fs")
    const { dirname, join, resolve } = await import("path")
    
    const schemaString = readFileSync(config.schemaPath, "utf-8")
    const schemaDir = dirname(config.schemaPath)
    const projectRoot = resolve(schemaDir, '..')
    
    // Check for prisma.config.ts in the schema's parent directory (project root)
    const possibleConfigPaths = [
      join(projectRoot, 'prisma.config.ts'),
      join(schemaDir, 'prisma.config.ts'),
    ]
    const configPath = possibleConfigPaths.find(p => existsSync(p))
    
    return await getDMMF({ 
      datamodel: schemaString,
      ...(configPath && { prismaConfigPath: configPath }),
    }) as unknown as PrismaDMMF
  } else if (config.schemaString) {
    return await getDMMF({ datamodel: config.schemaString }) as unknown as PrismaDMMF
  } else {
    throw new Error("Either schemaPath or schemaString must be provided")
  }
}

/**
 * Convert model name to route path (kebab-case, plural)
 */
function toRoutePath(name: string): string {
  const kebab = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
  // Simple pluralization
  if (kebab.endsWith("y")) return kebab.slice(0, -1) + "ies"
  if (kebab.endsWith("s") || kebab.endsWith("x") || kebab.endsWith("ch") || kebab.endsWith("sh")) {
    return kebab + "es"
  }
  return kebab + "s"
}

/**
 * Convert model name to camelCase
 */
function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/**
 * Get the ID field for a model
 */
function getIdField(model: PrismaModel): PrismaField | undefined {
  return model.fields.find(f => f.isId)
}

/**
 * Get scalar fields (non-relation) for a model
 */
function getScalarFields(model: PrismaModel): PrismaField[] {
  return model.fields.filter(f => f.kind === "scalar" || f.kind === "enum")
}

/**
 * Get relation fields for a model
 */
function getRelationFields(model: PrismaModel): PrismaField[] {
  return model.fields.filter(f => f.kind === "object")
}

/**
 * Generate TypeScript code for Hono routes
 */
function generateRoutesCode(
  models: readonly PrismaModel[],
  config: PrismaRoutesConfig,
  warnings: string[]
): string {
  const basePath = config.basePath || "/api"
  const modelConfigs = config.modelConfigs || {}

  const lines: string[] = [
    '/**',
    ' * Auto-generated Prisma Routes',
    ' *',
    ' * Generated by @shogo/state-api prismaToRoutesCode()',
    ' * DO NOT EDIT DIRECTLY - regenerate from Prisma schema',
    ' */',
    '',
    'import { Hono } from "hono"',
    'import { PrismaClient } from "./prisma/client"',
    'import type { ModelHooks, RouteHookContext, HookResult, CustomRoute } from "@shogo/state-api/generators"',
    '',
    '// Prisma client instance (must be injected via setPrisma)',
    'let prismaInstance: PrismaClient | null = null',
    '',
    'function getPrisma(): PrismaClient {',
    '  if (!prismaInstance) {',
    '    throw new Error("PrismaClient not initialized. Call setPrisma(client) before using routes.")',
    '  }',
    '  return prismaInstance',
    '}',
    '',
    '/**',
    ' * Set the Prisma client instance (for dependency injection)',
    ' */',
    'export function setPrisma(client: PrismaClient) {',
    '  prismaInstance = client',
    '}',
    '',
    '// ============================================================================',
    '// Hook Configurations (customize in hooks.ts)',
    '// ============================================================================',
    '',
    'export interface RouteHooksConfig {',
  ]

  // Generate hook config interface
  for (const model of models) {
    lines.push(`  ${model.name}?: ModelHooks`)
  }
  lines.push('}')
  lines.push('')
  lines.push('let hooksConfig: RouteHooksConfig = {}')
  lines.push('')
  lines.push('/**')
  lines.push(' * Set hooks configuration')
  lines.push(' */')
  lines.push('export function setHooks(config: RouteHooksConfig) {')
  lines.push('  hooksConfig = config')
  lines.push('}')
  lines.push('')

  // Generate route creator for each model
  for (const model of models) {
    const modelConfig = modelConfigs[model.name] || {}
    const disabled = modelConfig.disable || []
    const routePath = toRoutePath(model.name)
    const modelLower = toCamelCase(model.name)
    const idField = getIdField(model)
    
    if (!idField) {
      warnings.push(`Model '${model.name}' has no @id field, skipping`)
      continue
    }

    lines.push('// ============================================================================')
    lines.push(`// ${model.name} Routes`)
    lines.push('// ============================================================================')
    lines.push('')
    lines.push(`function create${model.name}Routes(): Hono {`)
    lines.push('  const router = new Hono()')
    lines.push('  const prisma = getPrisma()')
    lines.push(`  const hooks = hooksConfig.${model.name} || {}`)
    lines.push('')

    // Helper to build context
    lines.push('  const buildContext = (c: any, body?: any): RouteHookContext => ({')
    lines.push('    body: body || {},')
    lines.push('    params: c.req.param() || {},')
    lines.push('    query: Object.fromEntries(new URL(c.req.url).searchParams),')
    lines.push('    userId: c.get("auth")?.userId,')
    lines.push('    prisma,')
    lines.push('  })')
    lines.push('')

    // LIST route
    if (!disabled.includes("list")) {
      lines.push('  // GET / - List all')
      lines.push('  router.get("/", async (c) => {')
      lines.push('    try {')
      lines.push('      const ctx = buildContext(c)')
      lines.push('      let where: any = {}')
      lines.push('      let include: any = undefined')
      lines.push('')
      lines.push('      // Apply beforeList hook')
      lines.push('      if (hooks.beforeList) {')
      lines.push('        const result = await hooks.beforeList(ctx)')
      lines.push('        if (result && !result.ok) {')
      lines.push('          return c.json({ error: result.error }, 400)')
      lines.push('        }')
      lines.push('        if (result?.data) {')
      lines.push('          where = result.data.where || where')
      lines.push('          include = result.data.include || include')
      lines.push('        }')
      lines.push('      }')
      lines.push('')
      lines.push('      // Query params are handled by hooks, not directly passed to Prisma')
      lines.push('      // Use hooks.beforeList to convert query params to Prisma where clauses')
      lines.push('      const query = ctx.query')
      lines.push('')
      lines.push(`      const items = await prisma.${modelLower}.findMany({`)
      lines.push('        where,')
      lines.push('        include,')
      lines.push('        take: query.limit ? parseInt(query.limit) : undefined,')
      lines.push('        skip: query.offset ? parseInt(query.offset) : undefined,')
      lines.push('      })')
      lines.push('')
      lines.push('      return c.json({ ok: true, items })')
      lines.push('    } catch (error: any) {')
      lines.push(`      console.error("[${model.name}] List error:", error)`)
      lines.push('      return c.json({ error: { code: "list_failed", message: error.message } }, 500)')
      lines.push('    }')
      lines.push('  })')
      lines.push('')
    }

    // GET route
    if (!disabled.includes("get")) {
      lines.push('  // GET /:id - Get by ID')
      lines.push('  router.get("/:id", async (c) => {')
      lines.push('    try {')
      lines.push('      const id = c.req.param("id")')
      lines.push('      const ctx = buildContext(c)')
      lines.push('')
      lines.push('      // Apply beforeGet hook')
      lines.push('      if (hooks.beforeGet) {')
      lines.push('        const result = await hooks.beforeGet(id, ctx)')
      lines.push('        if (result && !result.ok) {')
      lines.push('          return c.json({ error: result.error }, result.error?.code === "not_found" ? 404 : 400)')
      lines.push('        }')
      lines.push('      }')
      lines.push('')
      lines.push(`      const item = await prisma.${modelLower}.findUnique({`)
      lines.push('        where: { id },')
      lines.push('      })')
      lines.push('')
      lines.push('      if (!item) {')
      lines.push(`        return c.json({ error: { code: "not_found", message: "${model.name} not found" } }, 404)`)
      lines.push('      }')
      lines.push('')
      lines.push('      return c.json({ ok: true, data: item })')
      lines.push('    } catch (error: any) {')
      lines.push(`      console.error("[${model.name}] Get error:", error)`)
      lines.push('      return c.json({ error: { code: "get_failed", message: error.message } }, 500)')
      lines.push('    }')
      lines.push('  })')
      lines.push('')
    }

    // CREATE route
    if (!disabled.includes("create")) {
      lines.push('  // POST / - Create')
      lines.push('  router.post("/", async (c) => {')
      lines.push('    try {')
      lines.push('      let body = await c.req.json()')
      lines.push('      const ctx = buildContext(c, body)')
      lines.push('')
      lines.push('      // Apply beforeCreate hook')
      lines.push('      if (hooks.beforeCreate) {')
      lines.push('        const result = await hooks.beforeCreate(body, ctx)')
      lines.push('        if (result && !result.ok) {')
      lines.push('          return c.json({ error: result.error }, 400)')
      lines.push('        }')
      lines.push('        if (result?.data) {')
      lines.push('          body = result.data')
      lines.push('        }')
      lines.push('      }')
      lines.push('')
      lines.push(`      const item = await prisma.${modelLower}.create({`)
      lines.push('        data: body,')
      lines.push('      })')
      lines.push('')
      lines.push('      // Apply afterCreate hook')
      lines.push('      if (hooks.afterCreate) {')
      lines.push('        await hooks.afterCreate(item, ctx)')
      lines.push('      }')
      lines.push('')
      lines.push('      return c.json({ ok: true, data: item }, 201)')
      lines.push('    } catch (error: any) {')
      lines.push(`      console.error("[${model.name}] Create error:", error)`)
      lines.push('      return c.json({ error: { code: "create_failed", message: error.message } }, 500)')
      lines.push('    }')
      lines.push('  })')
      lines.push('')
    }

    // UPDATE route
    if (!disabled.includes("update")) {
      lines.push('  // PATCH /:id - Update')
      lines.push('  router.patch("/:id", async (c) => {')
      lines.push('    try {')
      lines.push('      const id = c.req.param("id")')
      lines.push('      let body = await c.req.json()')
      lines.push('      const ctx = buildContext(c, body)')
      lines.push('')
      lines.push('      // Apply beforeUpdate hook')
      lines.push('      if (hooks.beforeUpdate) {')
      lines.push('        const result = await hooks.beforeUpdate(id, body, ctx)')
      lines.push('        if (result && !result.ok) {')
      lines.push('          return c.json({ error: result.error }, 400)')
      lines.push('        }')
      lines.push('        if (result?.data) {')
      lines.push('          body = result.data')
      lines.push('        }')
      lines.push('      }')
      lines.push('')
      lines.push(`      const item = await prisma.${modelLower}.update({`)
      lines.push('        where: { id },')
      lines.push('        data: body,')
      lines.push('      })')
      lines.push('')
      lines.push('      // Apply afterUpdate hook')
      lines.push('      if (hooks.afterUpdate) {')
      lines.push('        await hooks.afterUpdate(item, ctx)')
      lines.push('      }')
      lines.push('')
      lines.push('      return c.json({ ok: true, data: item })')
      lines.push('    } catch (error: any) {')
      lines.push(`      console.error("[${model.name}] Update error:", error)`)
      lines.push('      return c.json({ error: { code: "update_failed", message: error.message } }, 500)')
      lines.push('    }')
      lines.push('  })')
      lines.push('')
    }

    // DELETE route
    if (!disabled.includes("delete")) {
      lines.push('  // DELETE /:id - Delete')
      lines.push('  router.delete("/:id", async (c) => {')
      lines.push('    try {')
      lines.push('      const id = c.req.param("id")')
      lines.push('      const ctx = buildContext(c)')
      lines.push('')
      lines.push('      // Apply beforeDelete hook')
      lines.push('      if (hooks.beforeDelete) {')
      lines.push('        const result = await hooks.beforeDelete(id, ctx)')
      lines.push('        if (result && !result.ok) {')
      lines.push('          return c.json({ error: result.error }, 400)')
      lines.push('        }')
      lines.push('      }')
      lines.push('')
      lines.push(`      await prisma.${modelLower}.delete({`)
      lines.push('        where: { id },')
      lines.push('      })')
      lines.push('')
      lines.push('      // Apply afterDelete hook')
      lines.push('      if (hooks.afterDelete) {')
      lines.push('        await hooks.afterDelete(id, ctx)')
      lines.push('      }')
      lines.push('')
      lines.push('      return c.json({ ok: true })')
      lines.push('    } catch (error: any) {')
      lines.push(`      console.error("[${model.name}] Delete error:", error)`)
      lines.push('      return c.json({ error: { code: "delete_failed", message: error.message } }, 500)')
      lines.push('    }')
      lines.push('  })')
      lines.push('')
    }

    lines.push('  return router')
    lines.push('}')
    lines.push('')
  }

  // Generate main router creation function
  lines.push('// ============================================================================')
  lines.push('// Main Router Factory')
  lines.push('// ============================================================================')
  lines.push('')
  lines.push('export interface CreateRoutesOptions {')
  lines.push('  /** Prisma client instance */')
  lines.push('  prisma?: PrismaClient')
  lines.push('  /** Hook configurations */')
  lines.push('  hooks?: RouteHooksConfig')
  lines.push('  /** Custom routes to add */')
  lines.push('  customRoutes?: (router: Hono) => void')
  lines.push('}')
  lines.push('')
  lines.push('/**')
  lines.push(' * Create all generated routes')
  lines.push(' */')
  lines.push('export function createGeneratedRoutes(options: CreateRoutesOptions = {}): Hono {')
  lines.push('  const router = new Hono()')
  lines.push('')
  lines.push('  // Set Prisma client if provided')
  lines.push('  if (options.prisma) {')
  lines.push('    setPrisma(options.prisma)')
  lines.push('  }')
  lines.push('')
  lines.push('  // Set hooks if provided')
  lines.push('  if (options.hooks) {')
  lines.push('    setHooks(options.hooks)')
  lines.push('  }')
  lines.push('')
  lines.push('  // Mount model routes')

  for (const model of models) {
    const routePath = toRoutePath(model.name)
    lines.push(`  router.route("/${routePath}", create${model.name}Routes())`)
  }

  lines.push('')
  lines.push('  // Apply custom routes if provided')
  lines.push('  if (options.customRoutes) {')
  lines.push('    options.customRoutes(router)')
  lines.push('  }')
  lines.push('')
  lines.push('  return router')
  lines.push('}')
  lines.push('')
  lines.push('export default createGeneratedRoutes')

  return lines.join('\n')
}

/**
 * Generate Hono CRUD route code from Prisma schema
 *
 * @param config - Generation configuration
 * @returns Generated TypeScript code and metadata
 *
 * @example
 * ```typescript
 * import { prismaToRoutesCode } from "@shogo/state-api/generators"
 *
 * const result = await prismaToRoutesCode({
 *   schemaPath: "./prisma/schema.prisma",
 *   models: ["Workspace", "Project", "Folder"],
 * })
 *
 * writeFileSync("./src/generated/routes.ts", result.code)
 * ```
 */
export async function prismaToRoutesCode(
  config: PrismaRoutesConfig
): Promise<PrismaRoutesResult> {
  const warnings: string[] = []

  // Parse Prisma schema
  const dmmf = await parsePrismaSchema(config)

  // Filter models
  let models = dmmf.datamodel.models
  if (config.models) {
    models = models.filter(m => config.models!.includes(m.name))
  }
  if (config.excludeModels) {
    models = models.filter(m => !config.excludeModels!.includes(m.name))
  }

  if (models.length === 0) {
    throw new Error("No models found to generate routes for")
  }

  // Generate code
  const code = generateRoutesCode(models, config, warnings)

  return {
    code,
    models: models.map(m => m.name),
    warnings,
  }
}

