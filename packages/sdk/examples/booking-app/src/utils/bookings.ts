/**
 * Booking Server Functions
 * 
 * Demonstrates:
 * - Enum status management
 * - Date/time handling
 * - Availability checking
 * - Confirmation codes
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { BookingStatus } from '../generated/prisma/client'

export type BookingType = {
  id: string
  userId: string
  serviceId: string
  status: BookingStatus
  startTime: Date
  endTime: Date
  customerName: string
  customerEmail: string
  customerPhone: string | null
  notes: string | null
  confirmationCode: string
  createdAt: Date
  updatedAt: Date
  service?: {
    id: string
    name: string
    duration: number
    price: number
    currency: string
    color: string
  }
}

export type BookingStats = {
  total: number
  pending: number
  confirmed: number
  completed: number
  cancelled: number
  today: number
  upcoming: number
}

// Generate confirmation code
function generateConfirmationCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

// Get bookings for a user
export const getBookings = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    status?: BookingStatus
    startDate?: string
    endDate?: string
  }) => data)
  .handler(async ({ data }) => {
    const where: any = { userId: data.userId }

    if (data.status) {
      where.status = data.status
    }

    if (data.startDate || data.endDate) {
      where.startTime = {}
      if (data.startDate) {
        where.startTime.gte = new Date(data.startDate)
      }
      if (data.endDate) {
        where.startTime.lte = new Date(data.endDate)
      }
    }

    const bookings = await shogo.db.booking.findMany({
      where,
      include: {
        service: {
          select: { id: true, name: true, duration: true, price: true, currency: true, color: true },
        },
      },
      orderBy: { startTime: 'desc' },
    })
    return bookings as BookingType[]
  })

// Get a single booking by confirmation code (public)
export const getBookingByCode = createServerFn({ method: 'POST' })
  .inputValidator((data: { confirmationCode: string }) => data)
  .handler(async ({ data }) => {
    const booking = await shogo.db.booking.findUnique({
      where: { confirmationCode: data.confirmationCode },
      include: {
        service: {
          select: { id: true, name: true, duration: true, price: true, currency: true, color: true },
        },
        user: {
          select: { name: true, email: true },
        },
      },
    })
    return booking as BookingType & { user: { name: string | null; email: string } } | null
  })

// Check availability for a specific time
export const checkAvailability = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    serviceId: string
    date: string // ISO date string
  }) => data)
  .handler(async ({ data }) => {
    const date = new Date(data.date)
    const dayOfWeek = date.getDay()

    // Get service duration
    const service = await shogo.db.service.findUnique({
      where: { id: data.serviceId },
    })
    if (!service || !service.isActive) {
      return { slots: [] }
    }

    // Get available time slots for this day
    const timeSlots = await shogo.db.timeSlot.findMany({
      where: {
        userId: data.userId,
        dayOfWeek,
        isActive: true,
      },
      orderBy: { startTime: 'asc' },
    })

    // Get existing bookings for this day
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    const existingBookings = await shogo.db.booking.findMany({
      where: {
        userId: data.userId,
        startTime: { gte: startOfDay, lte: endOfDay },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    })

    // Generate available slots
    const availableSlots: { startTime: string; endTime: string }[] = []
    const duration = service.duration

    for (const slot of timeSlots) {
      const [slotStartHour, slotStartMin] = slot.startTime.split(':').map(Number)
      const [slotEndHour, slotEndMin] = slot.endTime.split(':').map(Number)

      let currentTime = new Date(date)
      currentTime.setHours(slotStartHour, slotStartMin, 0, 0)

      const slotEnd = new Date(date)
      slotEnd.setHours(slotEndHour, slotEndMin, 0, 0)

      while (currentTime.getTime() + duration * 60000 <= slotEnd.getTime()) {
        const potentialEnd = new Date(currentTime.getTime() + duration * 60000)

        // Check if this slot conflicts with any existing booking
        const hasConflict = existingBookings.some((booking) => {
          const bookingStart = new Date(booking.startTime)
          const bookingEnd = new Date(booking.endTime)
          return (
            (currentTime >= bookingStart && currentTime < bookingEnd) ||
            (potentialEnd > bookingStart && potentialEnd <= bookingEnd) ||
            (currentTime <= bookingStart && potentialEnd >= bookingEnd)
          )
        })

        if (!hasConflict) {
          availableSlots.push({
            startTime: currentTime.toISOString(),
            endTime: potentialEnd.toISOString(),
          })
        }

        // Move to next slot (30-minute increments)
        currentTime = new Date(currentTime.getTime() + 30 * 60000)
      }
    }

    return { slots: availableSlots }
  })

// Create a booking (public)
export const createBooking = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    serviceId: string
    startTime: string
    customerName: string
    customerEmail: string
    customerPhone?: string
    notes?: string
  }) => data)
  .handler(async ({ data }) => {
    // Get service for duration
    const service = await shogo.db.service.findUnique({
      where: { id: data.serviceId },
    })
    if (!service || !service.isActive) {
      throw new Error('Service not available')
    }

    const startTime = new Date(data.startTime)
    const endTime = new Date(startTime.getTime() + service.duration * 60000)

    // Check for conflicts
    const existingBookings = await shogo.db.booking.findMany({
      where: {
        userId: data.userId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        OR: [
          { startTime: { lt: endTime }, endTime: { gt: startTime } },
        ],
      },
    })

    if (existingBookings.length > 0) {
      throw new Error('Time slot is no longer available')
    }

    // Generate unique confirmation code
    let confirmationCode = generateConfirmationCode()
    let codeExists = await shogo.db.booking.findUnique({ where: { confirmationCode } })
    while (codeExists) {
      confirmationCode = generateConfirmationCode()
      codeExists = await shogo.db.booking.findUnique({ where: { confirmationCode } })
    }

    const booking = await shogo.db.booking.create({
      data: {
        userId: data.userId,
        serviceId: data.serviceId,
        startTime,
        endTime,
        customerName: data.customerName,
        customerEmail: data.customerEmail,
        customerPhone: data.customerPhone,
        notes: data.notes,
        confirmationCode,
      },
      include: {
        service: {
          select: { id: true, name: true, duration: true, price: true, currency: true, color: true },
        },
      },
    })

    return booking as BookingType
  })

// Update booking status
export const updateBookingStatus = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; status: BookingStatus }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.booking.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Booking not found')
    }

    const booking = await shogo.db.booking.update({
      where: { id: data.id },
      data: { status: data.status },
      include: {
        service: {
          select: { id: true, name: true, duration: true, price: true, currency: true, color: true },
        },
      },
    })

    return booking as BookingType
  })

// Cancel a booking (by confirmation code - for customers)
export const cancelBookingByCode = createServerFn({ method: 'POST' })
  .inputValidator((data: { confirmationCode: string }) => data)
  .handler(async ({ data }) => {
    const booking = await shogo.db.booking.findUnique({
      where: { confirmationCode: data.confirmationCode },
    })

    if (!booking) {
      throw new Error('Booking not found')
    }

    if (booking.status === 'CANCELLED') {
      throw new Error('Booking is already cancelled')
    }

    if (booking.status === 'COMPLETED') {
      throw new Error('Cannot cancel a completed booking')
    }

    const updated = await shogo.db.booking.update({
      where: { id: booking.id },
      data: { status: 'CANCELLED' },
    })

    return updated as BookingType
  })

// Get booking stats
export const getBookingStats = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const bookings = await shogo.db.booking.findMany({
      where: { userId: data.userId },
    })

    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const endOfToday = new Date(now)
    endOfToday.setHours(23, 59, 59, 999)

    return {
      total: bookings.length,
      pending: bookings.filter((b) => b.status === 'PENDING').length,
      confirmed: bookings.filter((b) => b.status === 'CONFIRMED').length,
      completed: bookings.filter((b) => b.status === 'COMPLETED').length,
      cancelled: bookings.filter((b) => b.status === 'CANCELLED').length,
      today: bookings.filter((b) => {
        const start = new Date(b.startTime)
        return start >= startOfToday && start <= endOfToday
      }).length,
      upcoming: bookings.filter((b) => {
        return new Date(b.startTime) > now && ['PENDING', 'CONFIRMED'].includes(b.status)
      }).length,
    } as BookingStats
  })
