/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {},
  Contact: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Company: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Tag: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  ContactTag: {},
  Note: {},
  Deal: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
}

export default hooks
