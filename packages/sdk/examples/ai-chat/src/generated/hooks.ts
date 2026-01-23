/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {},
  Chat: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Message: {
    // Messages are filtered through chat
  },
}

export default hooks
