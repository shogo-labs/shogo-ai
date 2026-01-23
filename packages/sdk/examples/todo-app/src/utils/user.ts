/**
 * User Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for user operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type UserType = {
  id: string
  email: string
  name: string | null
  createdAt: Date
  updatedAt: Date
}

// Get current user using shogo.db
export const getCurrentUser = createServerFn({ method: 'GET' })
  .handler(async () => {
    // shogo.db is the Prisma client
    const user = await shogo.db.user.findFirst({
      orderBy: { createdAt: 'asc' },
    })
    return user as UserType | null
  })

// Create user using shogo.db
export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => {
    console.log('[createUser] inputValidator received:', data)
    return data
  })
  .handler(async ({ data }) => {
    console.log('[createUser] handler called with data:', data)
    
    // Check if user exists
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    console.log('[createUser] existing user:', existing)
    
    if (existing) {
      throw new Error('User already exists')
    }

    // Create user with shogo.db
    console.log('[createUser] creating user...')
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })
    console.log('[createUser] user created:', user)
    return user as UserType
  })
