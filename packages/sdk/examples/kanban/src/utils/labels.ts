/**
 * Label Operations via shogo.db
 * 
 * Demonstrates: Labels with colors for categorization
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type LabelType = {
  id: string
  name: string
  color: string
  boardId: string
}

// Default label colors
export const LABEL_COLORS = [
  '#EF4444', // Red
  '#F97316', // Orange
  '#EAB308', // Yellow
  '#22C55E', // Green
  '#3B82F6', // Blue
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#6B7280', // Gray
]

/**
 * Get all labels for a board
 */
export const getLabels = createServerFn({ method: 'GET' })
  .inputValidator((data: { boardId: string }) => data)
  .handler(async ({ data }) => {
    const labels = await shogo.db.label.findMany({
      where: { boardId: data.boardId },
      orderBy: { name: 'asc' }
    })
    return labels
  })

/**
 * Create a new label
 */
export const createLabel = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; color: string; boardId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const label = await shogo.db.label.create({
      data: {
        name: data.name,
        color: data.color,
        boardId: data.boardId,
        userId: data.userId
      }
    })
    return label
  })

/**
 * Update a label
 */
export const updateLabel = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; name?: string; color?: string }) => data)
  .handler(async ({ data }) => {
    const label = await shogo.db.label.update({
      where: { id: data.id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.color && { color: data.color })
      }
    })
    return label
  })

/**
 * Delete a label
 */
export const deleteLabel = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.label.delete({
      where: { id: data.id }
    })
    return { success: true }
  })
