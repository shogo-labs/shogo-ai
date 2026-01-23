/**
 * Summary Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for aggregation operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { CategoryType } from './categories'
import type { ProductType } from './products'

export type SummaryType = {
  totalProducts: number
  totalValue: number
  totalCost: number
  lowStockCount: number
  outOfStockCount: number
  productsByCategory: Array<{
    category: CategoryType
    count: number
    value: number
  }>
  lowStockProducts: ProductType[]
}

export const getSummary = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    // Get all products for this user
    const products = await shogo.db.product.findMany({
      where: { userId: data.userId },
      include: { category: true },
    })

    // Calculate totals
    let totalValue = 0
    let totalCost = 0
    let lowStockCount = 0
    let outOfStockCount = 0

    for (const product of products) {
      totalValue += product.price * product.quantity
      totalCost += product.cost * product.quantity
      if (product.quantity === 0) {
        outOfStockCount++
      } else if (product.quantity < product.minQuantity) {
        lowStockCount++
      }
    }

    // Group by category
    const categoryTotals = await shogo.db.product.groupBy({
      by: ['categoryId'],
      where: { userId: data.userId },
      _count: { id: true },
      _sum: { quantity: true, price: true },
    })

    // Get category details
    const categoryIds = categoryTotals.map((b) => b.categoryId)
    const categories = await shogo.db.category.findMany({
      where: { id: { in: categoryIds } },
    })

    const categoryMap = new Map(categories.map((c) => [c.id, c]))
    const productsByCategory = categoryTotals
      .map((b) => {
        const category = categoryMap.get(b.categoryId) as CategoryType
        // Calculate value for this category
        const categoryProducts = products.filter((p) => p.categoryId === b.categoryId)
        const value = categoryProducts.reduce((sum, p) => sum + p.price * p.quantity, 0)
        return {
          category,
          count: b._count.id,
          value,
        }
      })
      .filter((item) => item.category)
      .sort((a, b) => b.count - a.count)

    // Get low stock products
    const lowStockProducts = products
      .filter((p) => p.quantity < p.minQuantity)
      .sort((a, b) => a.quantity - b.quantity)
      .slice(0, 10) as ProductType[]

    return {
      totalProducts: products.length,
      totalValue,
      totalCost,
      lowStockCount,
      outOfStockCount,
      productsByCategory,
      lowStockProducts,
    } as SummaryType
  })

export type MovementSummaryType = {
  recentIn: number
  recentOut: number
  adjustments: number
}

export const getMovementSummary = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; days?: number }) => data)
  .handler(async ({ data }) => {
    const days = data.days ?? 7
    const since = new Date()
    since.setDate(since.getDate() - days)

    const movements = await shogo.db.stockMovement.findMany({
      where: {
        userId: data.userId,
        createdAt: { gte: since },
      },
    })

    let recentIn = 0
    let recentOut = 0
    let adjustments = 0

    for (const m of movements) {
      if (m.type === 'in') {
        recentIn += m.quantity
      } else if (m.type === 'out') {
        recentOut += m.quantity
      } else {
        adjustments++
      }
    }

    return { recentIn, recentOut, adjustments } as MovementSummaryType
  })
