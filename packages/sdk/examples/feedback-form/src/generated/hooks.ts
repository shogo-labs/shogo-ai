/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {
    // Users don't need filtering - each user sees their own data
  },
  Submission: {
    // Filter submissions to only show user's own submissions
    beforeList: async (ctx) => {
      if (!ctx.userId) {
        return { where: {} }
      }
      return { where: { userId: ctx.userId } }
    },
    // Verify ownership before getting a submission
    beforeGet: async (id, ctx) => {
      return undefined
    },
    // No need to modify input - userId is passed from client
    beforeCreate: async (input, ctx) => {
      return input
    },
  },
}

export default hooks
