// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generated Routes Wrapper
 * 
 * This file re-exports the createAllRoutes function as createGeneratedRoutes
 * to match the expected import in server.ts
 */

import { createAllRoutes } from './index'
import { PrismaClient } from './prisma/client'

export interface CreateGeneratedRoutesOptions {
  prisma: PrismaClient
  hooks?: any
}

export function createGeneratedRoutes({ prisma }: CreateGeneratedRoutesOptions) {
  return createAllRoutes(prisma)
}
