/**
 * Card Operations via shogo.db
 * 
 * Demonstrates: Position/ordering, moving between columns
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type CardType = {
  id: string
  title: string
  description: string | null
  position: number
  dueDate: Date | null
  columnId: string
  userId: string
}

/**
 * Create a new card
 */
export const createCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { title: string; description?: string; columnId: string; userId: string; dueDate?: string }) => data)
  .handler(async ({ data }) => {
    // Get max position in column
    const maxPos = await shogo.db.card.aggregate({
      where: { columnId: data.columnId },
      _max: { position: true }
    })
    
    const card = await shogo.db.card.create({
      data: {
        title: data.title,
        description: data.description,
        columnId: data.columnId,
        userId: data.userId,
        position: (maxPos._max.position ?? -1) + 1,
        dueDate: data.dueDate ? new Date(data.dueDate) : null
      }
    })
    return card
  })

/**
 * Update a card
 */
export const updateCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; title?: string; description?: string; dueDate?: string | null }) => data)
  .handler(async ({ data }) => {
    const card = await shogo.db.card.update({
      where: { id: data.id },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.dueDate !== undefined && { dueDate: data.dueDate ? new Date(data.dueDate) : null })
      }
    })
    return card
  })

/**
 * Delete a card
 */
export const deleteCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.card.delete({
      where: { id: data.id }
    })
    return { success: true }
  })

/**
 * Move a card to a new column and/or position
 * This is the key operation for drag-and-drop
 */
export const moveCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { cardId: string; targetColumnId: string; targetPosition: number }) => data)
  .handler(async ({ data }) => {
    const { cardId, targetColumnId, targetPosition } = data
    
    // Get the card's current state
    const card = await shogo.db.card.findUnique({
      where: { id: cardId }
    })
    
    if (!card) throw new Error('Card not found')
    
    const sourceColumnId = card.columnId
    const sourcePosition = card.position
    
    // Same column - just reorder
    if (sourceColumnId === targetColumnId) {
      if (sourcePosition < targetPosition) {
        // Moving down - shift cards between source and target up
        await shogo.db.card.updateMany({
          where: {
            columnId: sourceColumnId,
            position: { gt: sourcePosition, lte: targetPosition }
          },
          data: { position: { decrement: 1 } }
        })
      } else if (sourcePosition > targetPosition) {
        // Moving up - shift cards between target and source down
        await shogo.db.card.updateMany({
          where: {
            columnId: sourceColumnId,
            position: { gte: targetPosition, lt: sourcePosition }
          },
          data: { position: { increment: 1 } }
        })
      }
    } else {
      // Different column - remove from source, insert into target
      
      // Shift cards in source column up
      await shogo.db.card.updateMany({
        where: {
          columnId: sourceColumnId,
          position: { gt: sourcePosition }
        },
        data: { position: { decrement: 1 } }
      })
      
      // Shift cards in target column down
      await shogo.db.card.updateMany({
        where: {
          columnId: targetColumnId,
          position: { gte: targetPosition }
        },
        data: { position: { increment: 1 } }
      })
    }
    
    // Update the card's column and position
    const updatedCard = await shogo.db.card.update({
      where: { id: cardId },
      data: {
        columnId: targetColumnId,
        position: targetPosition
      }
    })
    
    return updatedCard
  })

/**
 * Add a label to a card
 */
export const addLabelToCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { cardId: string; labelId: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.cardLabel.create({
      data: {
        cardId: data.cardId,
        labelId: data.labelId
      }
    })
    return { success: true }
  })

/**
 * Remove a label from a card
 */
export const removeLabelFromCard = createServerFn({ method: 'POST' })
  .inputValidator((data: { cardId: string; labelId: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.cardLabel.delete({
      where: {
        cardId_labelId: {
          cardId: data.cardId,
          labelId: data.labelId
        }
      }
    })
    return { success: true }
  })
