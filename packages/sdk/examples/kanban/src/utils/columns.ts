/**
 * Column Operations via shogo.db
 * 
 * Demonstrates: Position/ordering patterns
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

/**
 * Create a new column
 */
export const createColumn = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; boardId: string }) => data)
  .handler(async ({ data }) => {
    // Get max position in board
    const maxPos = await shogo.db.column.aggregate({
      where: { boardId: data.boardId },
      _max: { position: true }
    })
    
    const column = await shogo.db.column.create({
      data: {
        name: data.name,
        boardId: data.boardId,
        position: (maxPos._max.position ?? -1) + 1
      }
    })
    return column
  })

/**
 * Update a column
 */
export const updateColumn = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; name?: string }) => data)
  .handler(async ({ data }) => {
    const column = await shogo.db.column.update({
      where: { id: data.id },
      data: {
        ...(data.name && { name: data.name })
      }
    })
    return column
  })

/**
 * Delete a column
 */
export const deleteColumn = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.column.delete({
      where: { id: data.id }
    })
    return { success: true }
  })

/**
 * Reorder columns within a board
 */
export const reorderColumns = createServerFn({ method: 'POST' })
  .inputValidator((data: { boardId: string; columnIds: string[] }) => data)
  .handler(async ({ data }) => {
    // Update positions based on array order
    await Promise.all(
      data.columnIds.map((id, index) =>
        shogo.db.column.update({
          where: { id },
          data: { position: index }
        })
      )
    )
    return { success: true }
  })
