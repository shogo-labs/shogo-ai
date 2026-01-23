/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {},
  Form: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Field: {
    // Fields are filtered through form
  },
  Submission: {
    // Submissions are filtered through form
  },
  Response: {
    // Responses are filtered through submission
  },
}

export default hooks
