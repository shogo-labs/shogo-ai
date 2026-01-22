/**
 * TimeSlot Server Functions
 * 
 * Demonstrates managing available booking windows with day-of-week scheduling.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type TimeSlotType = {
  id: string
  userId: string
  dayOfWeek: number
  startTime: string
  endTime: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Get all time slots for a user
export const getTimeSlots = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; activeOnly?: boolean }) => data)
  .handler(async ({ data }) => {
    const slots = await shogo.db.timeSlot.findMany({
      where: {
        userId: data.userId,
        ...(data.activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    })
    return slots as TimeSlotType[]
  })

// Create a new time slot
export const createTimeSlot = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    dayOfWeek: number
    startTime: string
    endTime: string
  }) => data)
  .handler(async ({ data }) => {
    // Validate day of week
    if (data.dayOfWeek < 0 || data.dayOfWeek > 6) {
      throw new Error('Invalid day of week')
    }

    // Check for overlapping slots
    const existingSlots = await shogo.db.timeSlot.findMany({
      where: {
        userId: data.userId,
        dayOfWeek: data.dayOfWeek,
        isActive: true,
      },
    })

    for (const slot of existingSlots) {
      if (
        (data.startTime >= slot.startTime && data.startTime < slot.endTime) ||
        (data.endTime > slot.startTime && data.endTime <= slot.endTime) ||
        (data.startTime <= slot.startTime && data.endTime >= slot.endTime)
      ) {
        throw new Error('Time slot overlaps with existing slot')
      }
    }

    const slot = await shogo.db.timeSlot.create({
      data: {
        userId: data.userId,
        dayOfWeek: data.dayOfWeek,
        startTime: data.startTime,
        endTime: data.endTime,
      },
    })
    return slot as TimeSlotType
  })

// Update a time slot
export const updateTimeSlot = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    startTime?: string
    endTime?: string
    isActive?: boolean
  }) => data)
  .handler(async ({ data }) => {
    const { id, userId, ...updateData } = data

    const existing = await shogo.db.timeSlot.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      throw new Error('Time slot not found')
    }

    const slot = await shogo.db.timeSlot.update({
      where: { id },
      data: updateData,
    })
    return slot as TimeSlotType
  })

// Delete a time slot
export const deleteTimeSlot = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.timeSlot.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Time slot not found')
    }

    await shogo.db.timeSlot.delete({
      where: { id: data.id },
    })
    return { success: true }
  })

// Bulk create time slots (for quick setup)
export const createDefaultSlots = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    // Create default 9-5 slots for weekdays (Monday-Friday)
    const defaultSlots = [1, 2, 3, 4, 5].map((day) => ({
      userId: data.userId,
      dayOfWeek: day,
      startTime: '09:00',
      endTime: '17:00',
    }))

    await shogo.db.timeSlot.createMany({
      data: defaultSlots,
      skipDuplicates: true,
    })

    return { success: true, count: defaultSlots.length }
  })
