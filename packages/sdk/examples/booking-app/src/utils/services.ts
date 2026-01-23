/**
 * Service Server Functions
 * 
 * Demonstrates CRUD operations for services that can be booked.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type ServiceType = {
  id: string
  userId: string
  name: string
  description: string | null
  duration: number
  price: number
  currency: string
  isActive: boolean
  color: string
  createdAt: Date
  updatedAt: Date
  _count?: {
    bookings: number
  }
}

// Get all services for a user
export const getServices = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; activeOnly?: boolean }) => data)
  .handler(async ({ data }) => {
    const services = await shogo.db.service.findMany({
      where: {
        userId: data.userId,
        ...(data.activeOnly ? { isActive: true } : {}),
      },
      include: {
        _count: {
          select: { bookings: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return services as ServiceType[]
  })

// Get a single service
export const getService = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const service = await shogo.db.service.findUnique({
      where: { id: data.id },
      include: {
        user: {
          select: { id: true, name: true, email: true, timezone: true },
        },
      },
    })
    return service as ServiceType & { user: { id: string; name: string | null; email: string; timezone: string } } | null
  })

// Create a new service
export const createService = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    name: string
    description?: string
    duration?: number
    price?: number
    currency?: string
    color?: string
  }) => data)
  .handler(async ({ data }) => {
    const service = await shogo.db.service.create({
      data: {
        userId: data.userId,
        name: data.name,
        description: data.description,
        duration: data.duration ?? 60,
        price: data.price ?? 0,
        currency: data.currency ?? 'USD',
        color: data.color ?? '#3B82F6',
      },
    })
    return service as ServiceType
  })

// Update a service
export const updateService = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    name?: string
    description?: string
    duration?: number
    price?: number
    currency?: string
    isActive?: boolean
    color?: string
  }) => data)
  .handler(async ({ data }) => {
    const { id, userId, ...updateData } = data

    // Verify ownership
    const existing = await shogo.db.service.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      throw new Error('Service not found')
    }

    const service = await shogo.db.service.update({
      where: { id },
      data: updateData,
    })
    return service as ServiceType
  })

// Delete a service
export const deleteService = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.service.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Service not found')
    }

    await shogo.db.service.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
