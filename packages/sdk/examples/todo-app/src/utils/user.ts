/**
 * User Server Functions
 * 
 * Custom user functions that aren't CRUD - like getCurrentUser.
 * The basic CRUD operations are in ../generated/server-functions.ts
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { UserType } from '../generated/types'

// Re-export the type for convenience
export type { UserType }

/**
 * Get current user - finds the first user (demo app simplicity)
 * In a real app, this would use session/auth
 */
export const getCurrentUser = createServerFn({ method: 'GET' })
  .handler(async () => {
    const user = await shogo.db.user.findFirst({
      orderBy: { createdAt: 'asc' },
    })
    return user as UserType | null
  })

/**
 * Create user - custom because we need to check for existing
 */
export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    // Check if user exists
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    
    if (existing) {
      throw new Error('User already exists')
    }

    // Create user
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })
    
    return user as UserType
  })
