// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * User Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

/**
 * Result from a hook that can modify or reject the operation
 */
export interface HookResult<T = any> {
  ok: boolean
  error?: { code: string; message: string }
  data?: T
}

/**
 * Hook context with Prisma client
 */
export interface HookContext {
  body: any
  params: Record<string, string>
  query: Record<string, string>
  userId?: string
  prisma: any
}

/**
 * Hooks for User routes
 */
export interface UserHooks {
  /**
   * Called before listing records. Can modify where/include.
   * Note: Query parameters (except limit, offset, include, orderBy) are automatically
   * added to the where clause. This hook receives them and can override/extend them.
   */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any }> | void>
  /** Called before getting a single record. Can reject access. */
  beforeGet?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called before creating a record. Can modify input or reject. */
  beforeCreate?: (input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after creating a record. Can perform side effects. */
  afterCreate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before updating a record. Can modify input or reject. */
  beforeUpdate?: (id: string, input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after updating a record. Can perform side effects. */
  afterUpdate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before deleting a record. Can reject deletion. */
  beforeDelete?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called after deleting a record. Can perform cleanup. */
  afterDelete?: (id: string, ctx: HookContext) => Promise<void>
}

const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', icon: '🍔', color: '#EF4444', type: 'expense' },
  { name: 'Transportation', icon: '🚗', color: '#F59E0B', type: 'expense' },
  { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', type: 'expense' },
  { name: 'Entertainment', icon: '🎬', color: '#EC4899', type: 'expense' },
  { name: 'Bills & Utilities', icon: '💡', color: '#6366F1', type: 'expense' },
  { name: 'Health', icon: '🏥', color: '#14B8A6', type: 'expense' },
  { name: 'Housing', icon: '🏠', color: '#F97316', type: 'expense' },
  { name: 'Other', icon: '📦', color: '#6B7280', type: 'expense' },
  { name: 'Salary', icon: '💰', color: '#10B981', type: 'income' },
  { name: 'Freelance', icon: '💻', color: '#3B82F6', type: 'income' },
  { name: 'Investments', icon: '📈', color: '#22C55E', type: 'income' },
  { name: 'Other Income', icon: '💵', color: '#06B6D4', type: 'income' },
]

/**
 * Default User hooks
 */
export const userHooks: UserHooks = {
  afterCreate: async (record, ctx) => {
    try {
      await ctx.prisma.category.createMany({
        data: DEFAULT_CATEGORIES.map((cat) => ({ ...cat, userId: record.id })),
        skipDuplicates: true,
      })
    } catch (err) {
      console.error('[User Hook] Failed to seed categories:', err)
    }
  },
}
