/**
 * User Server Functions
 * 
 * Custom user functions that aren't basic CRUD.
 * Basic CRUD operations are in ../generated/server-functions.ts
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { UserType } from '../generated/types'

// Re-export the type for convenience
export type { UserType }

export const getCurrentUser = createServerFn({ method: 'GET' })
  .handler(async () => {
    const user = await shogo.db.user.findFirst({
      orderBy: { createdAt: 'asc' },
    })
    return user as UserType | null
  })

export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    if (existing) {
      throw new Error('User already exists')
    }

    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })
    return user as UserType
  })
