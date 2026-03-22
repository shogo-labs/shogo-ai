/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten by `bun run generate`.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {
    // beforeList: async (ctx) => { return { where: { userId: ctx.userId } } },
    // beforeCreate: async (input, ctx) => { return { ...input, userId: ctx.userId } },
  },
  Dataset: {
    // beforeList: async (ctx) => { return { where: { userId: ctx.userId } } },
    // beforeCreate: async (input, ctx) => { return { ...input, userId: ctx.userId } },
  },
  SavedQuery: {
    // beforeList: async (ctx) => { return { where: { userId: ctx.userId } } },
    // beforeCreate: async (input, ctx) => { return { ...input, userId: ctx.userId } },
  },
}

export default hooks
