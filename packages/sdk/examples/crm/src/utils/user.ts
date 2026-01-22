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

// Get the current user (single-user app pattern)
export const getCurrentUser = createServerFn({ method: 'GET' })
  .handler(async () => {
    const user = await shogo.db.user.findFirst({
      orderBy: { createdAt: 'asc' },
    })
    return user as UserType | null
  })

// Create user and seed sample data
export const createUser = createServerFn({ method: 'POST' })
  .inputValidator((data: { email: string; name?: string }) => data)
  .handler(async ({ data }) => {
    // Check if user already exists
    const existing = await shogo.db.user.findUnique({
      where: { email: data.email },
    })
    if (existing) {
      throw new Error('User with this email already exists')
    }

    // Create the user
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })

    // Seed default tags
    const defaultTags = [
      { name: 'VIP', color: '#EF4444' },
      { name: 'Hot Lead', color: '#F59E0B' },
      { name: 'Follow Up', color: '#3B82F6' },
      { name: 'Decision Maker', color: '#8B5CF6' },
      { name: 'Partner', color: '#10B981' },
    ]

    for (const tag of defaultTags) {
      await shogo.db.tag.create({
        data: { ...tag, userId: user.id },
      })
    }

    return user as UserType
  })
