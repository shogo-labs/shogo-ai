/**
 * Supplier Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for supplier operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type SupplierType = {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  userId: string
  createdAt: Date
  updatedAt: Date
  _count?: {
    products: number
  }
}

export const getSuppliers = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const suppliers = await shogo.db.supplier.findMany({
      where: { userId: data.userId },
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    })
    return suppliers as SupplierType[]
  })

export const createSupplier = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    name: string
    email?: string
    phone?: string
    address?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    // Check for duplicate name
    const existing = await shogo.db.supplier.findFirst({
      where: { userId: data.userId, name: data.name },
    })
    if (existing) {
      throw new Error('Supplier with this name already exists')
    }

    const supplier = await shogo.db.supplier.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address,
        userId: data.userId,
      },
    })
    return supplier as SupplierType
  })

export const deleteSupplier = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.supplier.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Supplier not found')
    }

    await shogo.db.supplier.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
