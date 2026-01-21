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

// Get the current user using shogo.db
export const getCurrentUser = createServerFn({ method: 'GET' })
  .handler(async () => {
    const user = await shogo.db.user.findFirst({
      orderBy: { createdAt: 'asc' },
    })
    return user as UserType | null
  })

// Create user and seed initial categories using shogo.db
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

    // Create the user with shogo.db
    const user = await shogo.db.user.create({
      data: {
        email: data.email,
        name: data.name,
      },
    })

    // Seed default categories for new user
    const defaultCategories = [
      { name: 'Food & Dining', icon: '🍔', color: '#EF4444', type: 'expense' },
      { name: 'Transportation', icon: '🚗', color: '#F59E0B', type: 'expense' },
      { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', type: 'expense' },
      { name: 'Entertainment', icon: '🎬', color: '#EC4899', type: 'expense' },
      { name: 'Bills & Utilities', icon: '💡', color: '#6366F1', type: 'expense' },
      { name: 'Health', icon: '🏥', color: '#10B981', type: 'expense' },
      { name: 'Salary', icon: '💰', color: '#22C55E', type: 'income' },
      { name: 'Freelance', icon: '💻', color: '#14B8A6', type: 'income' },
      { name: 'Other Income', icon: '📈', color: '#06B6D4', type: 'income' },
    ]

    for (const cat of defaultCategories) {
      await shogo.db.category.create({
        data: { ...cat, userId: user.id },
      })
    }

    return user as UserType
  })
