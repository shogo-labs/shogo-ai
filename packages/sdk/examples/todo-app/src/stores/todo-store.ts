/**
 * TodoStore - MobX store for todo management
 *
 * Production-grade state management with:
 * - Server functions for database operations
 * - Optimistic updates for instant UI feedback
 * - Automatic rollback on errors
 * - Loading and error states
 */

import { makeAutoObservable, runInAction } from 'mobx'
import {
  getTodos,
  createTodo,
  toggleTodo,
  deleteTodo,
  type TodoType,
} from '../utils/todos'

export type Todo = TodoType

export class TodoStore {
  todos: Todo[] = []
  isLoading = false
  error: string | null = null

  // Track pending operations for optimistic updates
  private pendingDeletes = new Set<string>()
  private pendingToggles = new Set<string>()

  constructor() {
    makeAutoObservable(this, {
      pendingDeletes: false,
      pendingToggles: false,
    })
  }

  /**
   * Load todos for a user
   */
  async loadTodos(userId: string) {
    runInAction(() => {
      this.isLoading = true
      this.error = null
    })

    try {
      const todos = await getTodos({ data: { userId } })

      runInAction(() => {
        this.todos = todos
        this.isLoading = false
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : 'Failed to load todos'
        this.isLoading = false
      })
    }
  }

  /**
   * Add a new todo with optimistic update
   */
  async addTodo(title: string, userId: string) {
    // Create optimistic todo
    const tempId = `temp-${crypto.randomUUID()}`
    const optimisticTodo: Todo = {
      id: tempId,
      title,
      completed: false,
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    // Optimistically add to list
    runInAction(() => {
      this.todos.unshift(optimisticTodo)
    })

    try {
      const todo = await createTodo({ data: { title, userId } })

      runInAction(() => {
        // Replace optimistic todo with real one
        const idx = this.todos.findIndex((t) => t.id === tempId)
        if (idx !== -1) {
          this.todos[idx] = todo
        }
      })

      return todo
    } catch (e) {
      runInAction(() => {
        // Rollback optimistic update
        this.todos = this.todos.filter((t) => t.id !== tempId)
        this.error = e instanceof Error ? e.message : 'Failed to create todo'
      })
      throw e
    }
  }

  /**
   * Toggle todo completion with optimistic update
   */
  async toggleTodoItem(id: string, userId: string) {
    const todo = this.todos.find((t) => t.id === id)
    if (!todo || this.pendingToggles.has(id)) return

    const previousCompleted = todo.completed
    this.pendingToggles.add(id)

    // Optimistically toggle
    runInAction(() => {
      todo.completed = !todo.completed
      todo.updatedAt = new Date()
    })

    try {
      await toggleTodo({
        data: { id, userId, completed: !previousCompleted },
      })

      runInAction(() => {
        this.pendingToggles.delete(id)
      })
    } catch (e) {
      runInAction(() => {
        // Rollback optimistic update
        const t = this.todos.find((t) => t.id === id)
        if (t) {
          t.completed = previousCompleted
        }
        this.pendingToggles.delete(id)
        this.error = e instanceof Error ? e.message : 'Failed to update todo'
      })
      throw e
    }
  }

  /**
   * Delete a todo with optimistic update
   */
  async deleteTodoItem(id: string, userId: string) {
    if (this.pendingDeletes.has(id)) return

    const todoIndex = this.todos.findIndex((t) => t.id === id)
    if (todoIndex === -1) return

    const deletedTodo = this.todos[todoIndex]
    this.pendingDeletes.add(id)

    // Optimistically remove
    runInAction(() => {
      this.todos.splice(todoIndex, 1)
    })

    try {
      await deleteTodo({ data: { id, userId } })

      runInAction(() => {
        this.pendingDeletes.delete(id)
      })
    } catch (e) {
      runInAction(() => {
        // Rollback optimistic update - reinsert at original position
        this.todos.splice(todoIndex, 0, deletedTodo)
        this.pendingDeletes.delete(id)
        this.error = e instanceof Error ? e.message : 'Failed to delete todo'
      })
      throw e
    }
  }

  /**
   * Clear error state
   */
  clearError() {
    this.error = null
  }

  /**
   * Clear all todos (used on sign out)
   */
  clear() {
    this.todos = []
    this.error = null
    this.isLoading = false
  }

  /**
   * Computed: count of completed todos
   */
  get completedCount() {
    return this.todos.filter((t) => t.completed).length
  }

  /**
   * Computed: count of pending todos
   */
  get pendingCount() {
    return this.todos.filter((t) => !t.completed).length
  }

  /**
   * Check if a specific todo has a pending operation
   */
  isPending(id: string) {
    return this.pendingDeletes.has(id) || this.pendingToggles.has(id)
  }
}
