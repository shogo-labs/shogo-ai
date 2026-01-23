/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {},
  Category: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Supplier: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Product: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  StockMovement: {
    // Stock movements are filtered through product
  },
}

export default hooks
