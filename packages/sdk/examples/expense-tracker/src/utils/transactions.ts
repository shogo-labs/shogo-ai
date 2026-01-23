/**
 * Transaction Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for transaction operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { CategoryType } from './categories'

export type TransactionType = {
  id: string
  amount: number
  description: string | null
  date: Date
  type: 'expense' | 'income'
  categoryId: string
  userId: string
  createdAt: Date
  updatedAt: Date
  category?: CategoryType
}

export const getTransactions = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    startDate?: string
    endDate?: string
    categoryId?: string
    type?: 'expense' | 'income'
  }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    if (data.startDate || data.endDate) {
      where.date = {}
      if (data.startDate) (where.date as Record<string, unknown>).gte = new Date(data.startDate)
      if (data.endDate) (where.date as Record<string, unknown>).lte = new Date(data.endDate)
    }

    if (data.categoryId) where.categoryId = data.categoryId
    if (data.type) where.type = data.type

    // Using shogo.db (Prisma pass-through)
    const transactions = await shogo.db.transaction.findMany({
      where,
      include: { category: true },
      orderBy: { date: 'desc' },
    })
    return transactions as TransactionType[]
  })

export const createTransaction = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    amount: number
    description?: string
    date?: string
    type: 'expense' | 'income'
    categoryId: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify the category belongs to this user
    const category = await shogo.db.category.findFirst({
      where: { id: data.categoryId, userId: data.userId },
    })
    if (!category) {
      throw new Error('Category not found')
    }

    const transaction = await shogo.db.transaction.create({
      data: {
        amount: data.amount,
        description: data.description,
        date: data.date ? new Date(data.date) : new Date(),
        type: data.type,
        categoryId: data.categoryId,
        userId: data.userId,
      },
      include: { category: true },
    })
    return transaction as TransactionType
  })

export const updateTransaction = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    amount?: number
    description?: string
    date?: string
    type?: 'expense' | 'income'
    categoryId?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.transaction.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Transaction not found')
    }

    // If changing category, verify it belongs to user
    if (data.categoryId) {
      const category = await shogo.db.category.findFirst({
        where: { id: data.categoryId, userId: data.userId },
      })
      if (!category) {
        throw new Error('Category not found')
      }
    }

    const updateData: Record<string, unknown> = {}
    if (data.amount !== undefined) updateData.amount = data.amount
    if (data.description !== undefined) updateData.description = data.description
    if (data.date !== undefined) updateData.date = new Date(data.date)
    if (data.type !== undefined) updateData.type = data.type
    if (data.categoryId !== undefined) updateData.categoryId = data.categoryId

    const transaction = await shogo.db.transaction.update({
      where: { id: data.id },
      data: updateData,
      include: { category: true },
    })
    return transaction as TransactionType
  })

export const deleteTransaction = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership before deleting
    const existing = await shogo.db.transaction.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Transaction not found')
    }

    await shogo.db.transaction.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
