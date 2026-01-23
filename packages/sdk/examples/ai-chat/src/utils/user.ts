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
  .inputValidator((data: { email: string; password?: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    if (existing) {
      throw new Error('User with this email already exists')
    }

    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        password: data.password,
      },
    })

    return user as UserType
  })

export const loginUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; password?: string }) => data)
  .handler(async ({ data }) => {
    const user = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    
    if (!user) {
      // Create new user if doesn't exist
      const newUser = await shogo.db.user.create({
        data: {
          email: data.email,
          password: data.password,
        },
      })
      return newUser as UserType
    }

    return user as UserType
  })
