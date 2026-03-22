export interface HookResult<T = any> { ok: boolean; error?: { code: string; message: string }; data?: T }
export interface HookContext { body: any; params: Record<string, string>; query: Record<string, string>; userId?: string; prisma: any }

export interface SavedQueryHooks {
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any }> | void>
  beforeGet?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  beforeCreate?: (input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  afterCreate?: (record: any, ctx: HookContext) => Promise<void>
  beforeUpdate?: (id: string, input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  afterUpdate?: (record: any, ctx: HookContext) => Promise<void>
  beforeDelete?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  afterDelete?: (id: string, ctx: HookContext) => Promise<void>
}

export const savedQueryHooks: SavedQueryHooks = {}
