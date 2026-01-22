/**
 * Todo Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for database operations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type TodoType = {
  id: string
  title: string
  completed: boolean
  userId: string
  createdAt: Date
  updatedAt: Date
}

// Get all todos for a user using shogo.db (Prisma pass-through)
export const getTodos = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    // shogo.db is the Prisma client - same API you know and love
    const todos = await shogo.db.todo.findMany({
      where: { userId: data.userId },
      orderBy: { createdAt: 'desc' },
    })
    return todos as TodoType[]
  })

// Create a todo using shogo.db
export const createTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { title: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const todo = await shogo.db.todo.create({
      data: {
        title: data.title,
        userId: data.userId,
      },
    })
    return todo as TodoType
  })

// Toggle todo completion using shogo.db
export const toggleTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; completed: boolean }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.todo.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Todo not found')
    }

    const todo = await shogo.db.todo.update({
      where: { id: data.id },
      data: { completed: data.completed },
    })
    return todo as TodoType
  })

// Delete a todo using shogo.db
export const deleteTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.todo.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Todo not found')
    }

    await shogo.db.todo.delete({
      where: { id: data.id },
    })

    return { success: true }
  })
