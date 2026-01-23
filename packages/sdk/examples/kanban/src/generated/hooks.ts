/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {},
  Board: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  Column: {
    // Columns are filtered by board, which is filtered by user
  },
  Card: {
    // Cards are filtered by column/board
  },
  Label: {
    beforeList: async (ctx) => {
      if (!ctx.userId) return { where: {} }
      return { where: { userId: ctx.userId } }
    },
  },
  CardLabel: {},
}

export default hooks
