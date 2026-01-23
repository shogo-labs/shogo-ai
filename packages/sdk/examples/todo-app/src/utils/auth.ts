/**
 * Auth Server Functions
 *
 * Server-side authentication operations using shogo.db (Prisma).
 * These run on the server and are called from the client via RPC.
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

/**
 * Get user by ID
 */
export const getUserById = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const user = await shogo.db.user.findUnique({
      where: { id: data.userId },
    })
    return user as UserType | null
  })

/**
 * Get user by email
 */
export const getUserByEmail = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    const user = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    return user as UserType | null
  })

/**
 * Create a new user (sign up)
 */
export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    // Check if user already exists
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })

    if (existing) {
      throw new Error('User already exists')
    }

    // Create new user
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name || null,
      },
    })

    return user as UserType
  })

/**
 * Sign in - verify user exists by email
 * In a real app, you'd also verify the password
 */
export const signInUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; password: string }) => data)
  .handler(async ({ data }) => {
    const user = await shogo.db.user.findUnique({
      where: { email: data.email },
    })

    if (!user) {
      throw new Error('User not found')
    }

    // In a real app, verify password here
    // For demo purposes, we just return the user

    return user as UserType
  })
