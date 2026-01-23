/**
 * Product Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for product operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { CategoryType } from './categories'
import type { SupplierType } from './suppliers'

export type ProductType = {
  id: string
  name: string
  sku: string
  description: string | null
  price: number
  cost: number
  quantity: number
  minQuantity: number
  categoryId: string
  supplierId: string | null
  userId: string
  createdAt: Date
  updatedAt: Date
  category?: CategoryType
  supplier?: SupplierType | null
}

export const getProducts = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    categoryId?: string
    supplierId?: string
    lowStock?: boolean
    search?: string
  }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    if (data.categoryId) where.categoryId = data.categoryId
    if (data.supplierId) where.supplierId = data.supplierId
    if (data.search) {
      where.OR = [
        { name: { contains: data.search } },
        { sku: { contains: data.search } },
        { description: { contains: data.search } },
      ]
    }

    // Using shogo.db (Prisma pass-through)
    let products = await shogo.db.product.findMany({
      where,
      include: { category: true, supplier: true },
      orderBy: { name: 'asc' },
    })

    // Filter low stock items (quantity < minQuantity)
    if (data.lowStock) {
      products = products.filter((p: { quantity: number; minQuantity: number }) => p.quantity < p.minQuantity)
    }

    return products as ProductType[]
  })

export const getProduct = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const product = await shogo.db.product.findFirst({
      where: { id: data.id, userId: data.userId },
      include: { category: true, supplier: true },
    })
    return product as ProductType | null
  })

export const createProduct = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    name: string
    sku: string
    description?: string
    price?: number
    cost?: number
    quantity?: number
    minQuantity?: number
    categoryId: string
    supplierId?: string
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

    // Check for duplicate SKU
    const existingSku = await shogo.db.product.findFirst({
      where: { userId: data.userId, sku: data.sku },
    })
    if (existingSku) {
      throw new Error('Product with this SKU already exists')
    }

    // Verify supplier if provided
    if (data.supplierId) {
      const supplier = await shogo.db.supplier.findFirst({
        where: { id: data.supplierId, userId: data.userId },
      })
      if (!supplier) {
        throw new Error('Supplier not found')
      }
    }

    const product = await shogo.db.product.create({
      data: {
        name: data.name,
        sku: data.sku,
        description: data.description,
        price: data.price ?? 0,
        cost: data.cost ?? 0,
        quantity: data.quantity ?? 0,
        minQuantity: data.minQuantity ?? 10,
        categoryId: data.categoryId,
        supplierId: data.supplierId,
        userId: data.userId,
      },
      include: { category: true, supplier: true },
    })
    return product as ProductType
  })

export const updateProduct = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    name?: string
    sku?: string
    description?: string
    price?: number
    cost?: number
    minQuantity?: number
    categoryId?: string
    supplierId?: string | null
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.product.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Product not found')
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

    // If changing SKU, check for duplicates
    if (data.sku && data.sku !== existing.sku) {
      const existingSku = await shogo.db.product.findFirst({
        where: { userId: data.userId, sku: data.sku },
      })
      if (existingSku) {
        throw new Error('Product with this SKU already exists')
      }
    }

    const updateData: Record<string, unknown> = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.sku !== undefined) updateData.sku = data.sku
    if (data.description !== undefined) updateData.description = data.description
    if (data.price !== undefined) updateData.price = data.price
    if (data.cost !== undefined) updateData.cost = data.cost
    if (data.minQuantity !== undefined) updateData.minQuantity = data.minQuantity
    if (data.categoryId !== undefined) updateData.categoryId = data.categoryId
    if (data.supplierId !== undefined) updateData.supplierId = data.supplierId

    const product = await shogo.db.product.update({
      where: { id: data.id },
      data: updateData,
      include: { category: true, supplier: true },
    })
    return product as ProductType
  })

export const deleteProduct = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership before deleting
    const existing = await shogo.db.product.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Product not found')
    }

    await shogo.db.product.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
