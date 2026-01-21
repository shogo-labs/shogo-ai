/**
 * Stock Movement Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for stock tracking.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { ProductType } from './products'

export type StockMovementType = {
  id: string
  type: 'in' | 'out' | 'adjustment'
  quantity: number
  reason: string | null
  productId: string
  userId: string
  createdAt: Date
  product?: ProductType
}

export const getStockMovements = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    productId?: string
    type?: 'in' | 'out' | 'adjustment'
    limit?: number
  }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    if (data.productId) where.productId = data.productId
    if (data.type) where.type = data.type

    const movements = await shogo.db.stockMovement.findMany({
      where,
      include: { product: true },
      orderBy: { createdAt: 'desc' },
      take: data.limit ?? 50,
    })
    return movements as StockMovementType[]
  })

export const addStock = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    productId: string
    quantity: number
    reason?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    if (data.quantity <= 0) {
      throw new Error('Quantity must be positive')
    }

    // Verify product belongs to user
    const product = await shogo.db.product.findFirst({
      where: { id: data.productId, userId: data.userId },
    })
    if (!product) {
      throw new Error('Product not found')
    }

    // Create movement record
    const movement = await shogo.db.stockMovement.create({
      data: {
        type: 'in',
        quantity: data.quantity,
        reason: data.reason ?? 'Stock received',
        productId: data.productId,
        userId: data.userId,
      },
      include: { product: true },
    })

    // Update product quantity
    await shogo.db.product.update({
      where: { id: data.productId },
      data: { quantity: { increment: data.quantity } },
    })

    return movement as StockMovementType
  })

export const removeStock = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    productId: string
    quantity: number
    reason?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    if (data.quantity <= 0) {
      throw new Error('Quantity must be positive')
    }

    // Verify product belongs to user
    const product = await shogo.db.product.findFirst({
      where: { id: data.productId, userId: data.userId },
    })
    if (!product) {
      throw new Error('Product not found')
    }

    if (product.quantity < data.quantity) {
      throw new Error('Insufficient stock')
    }

    // Create movement record
    const movement = await shogo.db.stockMovement.create({
      data: {
        type: 'out',
        quantity: data.quantity,
        reason: data.reason ?? 'Stock removed',
        productId: data.productId,
        userId: data.userId,
      },
      include: { product: true },
    })

    // Update product quantity
    await shogo.db.product.update({
      where: { id: data.productId },
      data: { quantity: { decrement: data.quantity } },
    })

    return movement as StockMovementType
  })

export const adjustStock = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    productId: string
    newQuantity: number
    reason?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    if (data.newQuantity < 0) {
      throw new Error('Quantity cannot be negative')
    }

    // Verify product belongs to user
    const product = await shogo.db.product.findFirst({
      where: { id: data.productId, userId: data.userId },
    })
    if (!product) {
      throw new Error('Product not found')
    }

    const difference = data.newQuantity - product.quantity

    // Create movement record
    const movement = await shogo.db.stockMovement.create({
      data: {
        type: 'adjustment',
        quantity: difference,
        reason: data.reason ?? `Adjusted from ${product.quantity} to ${data.newQuantity}`,
        productId: data.productId,
        userId: data.userId,
      },
      include: { product: true },
    })

    // Update product quantity
    await shogo.db.product.update({
      where: { id: data.productId },
      data: { quantity: data.newQuantity },
    })

    return movement as StockMovementType
  })
