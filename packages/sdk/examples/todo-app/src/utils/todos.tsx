import { createServerFn } from '@tanstack/react-start'
import { prisma } from './db'

export type TodoType = {
  id: string
  title: string
  completed: boolean
  userId: string
  createdAt: Date
  updatedAt: Date
}

export const getTodos = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const todos = await prisma.todo.findMany({
      where: { userId: data.userId },
      orderBy: { createdAt: 'desc' },
    })
    return todos as TodoType[]
  })

export const createTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { title: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const todo = await prisma.todo.create({
      data: {
        title: data.title,
        userId: data.userId,
      },
    })
    return todo as TodoType
  })

export const toggleTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; completed: boolean }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await prisma.todo.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Todo not found')
    }

    const todo = await prisma.todo.update({
      where: { id: data.id },
      data: { completed: data.completed },
    })
    return todo as TodoType
  })

export const deleteTodo = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await prisma.todo.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Todo not found')
    }

    await prisma.todo.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
