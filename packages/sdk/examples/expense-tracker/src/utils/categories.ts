/**
 * Category Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for category operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type CategoryType = {
  id: string
  name: string
  icon: string
  color: string
  type: 'expense' | 'income'
  userId: string
  createdAt: Date
  updatedAt: Date
}

export const getCategories = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    // Using shogo.db (Prisma pass-through)
    const categories = await shogo.db.category.findMany({
      where: { userId: data.userId },
      orderBy: { name: 'asc' },
    })
    return categories as CategoryType[]
  })

export const createCategory = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    name: string
    icon?: string
    color?: string
    type: 'expense' | 'income'
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    // Check for duplicate name
    const existing = await shogo.db.category.findFirst({
      where: { userId: data.userId, name: data.name },
    })
    if (existing) {
      throw new Error('Category with this name already exists')
    }

    const category = await shogo.db.category.create({
      data: {
        name: data.name,
        icon: data.icon ?? '📁',
        color: data.color ?? '#6B7280',
        type: data.type,
        userId: data.userId,
      },
    })
    return category as CategoryType
  })

export const deleteCategory = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.category.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Category not found')
    }

    await shogo.db.category.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
