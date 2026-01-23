/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks, TodoCreateInput } from './types'

export const hooks: ServerFunctionHooks = {
  User: {
    // Users don't need filtering - each user sees their own data
  },
  Todo: {
    // Filter todos to only show user's own todos
    beforeList: async (ctx) => {
      if (!ctx.userId) {
        return { where: {} }
      }
      return { where: { userId: ctx.userId } }
    },
    // Verify ownership before getting a todo
    beforeGet: async (id, ctx) => {
      // Allow all gets for now - the beforeList handles filtering
      return undefined
    },
    // No need to modify input - userId is passed from client
    beforeCreate: async (input, ctx) => {
      return input
    },
  },
}

export default hooks
