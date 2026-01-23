/**
 * Board Operations via shogo.db
 * 
 * Demonstrates: shogo.db.board.* methods with nested includes
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type BoardType = {
  id: string
  name: string
  description: string | null
  color: string
  userId: string
  columns: {
    id: string
    name: string
    position: number
    cards: {
      id: string
      title: string
      description: string | null
      position: number
      dueDate: Date | null
      labels: {
        label: {
          id: string
          name: string
          color: string
        }
      }[]
    }[]
  }[]
  labels: {
    id: string
    name: string
    color: string
  }[]
}

/**
 * Get all boards for a user
 */
export const getBoards = createServerFn({ method: 'GET' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const boards = await shogo.db.board.findMany({
      where: { userId: data.userId },
      orderBy: { createdAt: 'desc' },
    })
    return boards
  })

/**
 * Get a single board with all columns, cards, and labels
 */
export const getBoard = createServerFn({ method: 'GET' })
  .inputValidator((data: { boardId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const board = await shogo.db.board.findFirst({
      where: { 
        id: data.boardId,
        userId: data.userId,
      },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            cards: {
              orderBy: { position: 'asc' },
              include: {
                labels: {
                  include: { label: true }
                }
              }
            }
          }
        },
        labels: {
          orderBy: { name: 'asc' }
        }
      }
    })
    return board as BoardType | null
  })

/**
 * Create a new board with default columns
 */
export const createBoard = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; description?: string; color?: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const board = await shogo.db.board.create({
      data: {
        name: data.name,
        description: data.description,
        color: data.color || '#3B82F6',
        userId: data.userId,
        // Create default columns
        columns: {
          create: [
            { name: 'To Do', position: 0 },
            { name: 'In Progress', position: 1 },
            { name: 'Done', position: 2 },
          ]
        }
      },
      include: {
        columns: true
      }
    })
    return board
  })

/**
 * Update a board
 */
export const updateBoard = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; name?: string; description?: string; color?: string }) => data)
  .handler(async ({ data }) => {
    const board = await shogo.db.board.update({
      where: { id: data.id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.color && { color: data.color }),
      }
    })
    return board
  })

/**
 * Delete a board
 */
export const deleteBoard = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    await shogo.db.board.delete({
      where: { id: data.id }
    })
    return { success: true }
  })
