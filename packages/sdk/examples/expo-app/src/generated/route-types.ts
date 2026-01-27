/**
 * Route Hook Types
 */

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
