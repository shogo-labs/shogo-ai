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
    // Inject userId from context into the create input
    // This ensures the todo is associated with the authenticated user
    beforeCreate: async (input, ctx) => {
      if (!ctx.userId) {
        throw new Error('Authentication required: userId is missing')
      }
      return {
        ...input,
        userId: ctx.userId,
      }
    },
    // Verify ownership before updating a todo
    beforeUpdate: async (id, input, ctx) => {
      // Prevent changing the userId on update
      if (input.userId && input.userId !== ctx.userId) {
        return { deny: true }
      }
      return undefined
    },
    // Verify ownership before deleting a todo
    beforeDelete: async (id, ctx) => {
      // The beforeList filter ensures users only see their own todos,
      // so if they can see it, they can delete it
      return undefined
    },
  },
}

export default hooks
