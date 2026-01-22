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
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    // Check if user exists
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    if (existing) {
      throw new Error('User already exists')
    }

    // Create user with shogo.db
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })
    return user as UserType
  })
