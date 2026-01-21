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
      { name: 'Electronics', icon: '💻', color: '#3B82F6' },
      { name: 'Clothing', icon: '👕', color: '#8B5CF6' },
      { name: 'Food & Beverages', icon: '🍎', color: '#22C55E' },
      { name: 'Office Supplies', icon: '📎', color: '#F59E0B' },
      { name: 'Tools & Hardware', icon: '🔧', color: '#6B7280' },
      { name: 'Home & Garden', icon: '🏠', color: '#EC4899' },
    ]

    for (const cat of defaultCategories) {
      await shogo.db.category.create({
        data: { ...cat, userId: user.id },
      })
    }

    // Seed a default supplier
    await shogo.db.supplier.create({
      data: {
        name: 'Default Supplier',
        email: 'supplier@example.com',
        userId: user.id,
      },
    })

    return user as UserType
  })
