// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server Function Hooks
 *
 * Customize CRUD behavior with before/after hooks.
 * This file is safe to edit - it will not be overwritten.
 */

import type { ServerFunctionHooks } from './types'

export const hooks: ServerFunctionHooks = {
  User: {
    // Users don't need filtering
  },
  Category: {
    // Filter categories by user
    beforeList: async (ctx) => {
      if (!ctx.userId) {
        return { where: {} }
      }
      return { where: { userId: ctx.userId } }
    },
  },
  Transaction: {
    // Filter transactions by user
    beforeList: async (ctx) => {
      if (!ctx.userId) {
        return { where: {} }
      }
      return { where: { userId: ctx.userId } }
    },
  },
  Budget: {
    // Filter budgets by user
    beforeList: async (ctx) => {
      if (!ctx.userId) {
        return { where: {} }
      }
      return { where: { userId: ctx.userId } }
    },
  },
}

export default hooks
