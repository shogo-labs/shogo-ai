/**
 * Summary Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for aggregation operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { CategoryType } from './categories'

export type SummaryType = {
  totalIncome: number
  totalExpenses: number
  balance: number
  expensesByCategory: Array<{
    category: CategoryType
    total: number
  }>
}

export type MonthlyTrendType = {
  month: string
  income: number
  expenses: number
}

export const getSummary = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    startDate?: string
    endDate?: string
  }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }
    
    if (data.startDate || data.endDate) {
      where.date = {}
      if (data.startDate) (where.date as Record<string, unknown>).gte = new Date(data.startDate)
      if (data.endDate) (where.date as Record<string, unknown>).lte = new Date(data.endDate)
    }

    // Total income using shogo.db.transaction.aggregate()
    const incomeResult = await shogo.db.transaction.aggregate({
      where: { ...where, type: 'income' },
      _sum: { amount: true },
    })

    // Total expenses
    const expenseResult = await shogo.db.transaction.aggregate({
      where: { ...where, type: 'expense' },
      _sum: { amount: true },
    })

    // Expenses by category using shogo.db.transaction.groupBy()
    const byCategory = await shogo.db.transaction.groupBy({
      by: ['categoryId'],
      where: { ...where, type: 'expense' },
      _sum: { amount: true },
    })

    // Get category details
    const categoryIds = byCategory.map((b) => b.categoryId)
    const categories = await shogo.db.category.findMany({
      where: { id: { in: categoryIds } },
    })

    const categoryMap = new Map(categories.map((c) => [c.id, c]))
    const expensesByCategory = byCategory
      .map((b) => ({
        category: categoryMap.get(b.categoryId) as CategoryType,
        total: b._sum.amount ?? 0,
      }))
      .filter((item) => item.category)
      .sort((a, b) => b.total - a.total)

    return {
      totalIncome: incomeResult._sum.amount ?? 0,
      totalExpenses: expenseResult._sum.amount ?? 0,
      balance: (incomeResult._sum.amount ?? 0) - (expenseResult._sum.amount ?? 0),
      expensesByCategory,
    } as SummaryType
  })

export const getMonthlyTrend = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; months?: number }) => data)
  .handler(async ({ data }) => {
    const months = data.months ?? 6
    const now = new Date()
    const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1)

    const transactions = await shogo.db.transaction.findMany({
      where: {
        userId: data.userId,
        date: { gte: startDate },
      },
      orderBy: { date: 'asc' },
    })

    // Group by month
    const monthlyData: Record<string, { income: number; expenses: number }> = {}

    for (const tx of transactions) {
      const monthKey = `${tx.date.getFullYear()}-${String(tx.date.getMonth() + 1).padStart(2, '0')}`
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { income: 0, expenses: 0 }
      }
      if (tx.type === 'income') {
        monthlyData[monthKey].income += tx.amount
      } else {
        monthlyData[monthKey].expenses += tx.amount
      }
    }

    // Convert to array sorted by month
    const trend = Object.entries(monthlyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, trendData]) => ({ month, ...trendData }))

    return trend as MonthlyTrendType[]
  })
