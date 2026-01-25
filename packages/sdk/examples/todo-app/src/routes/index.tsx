/**
 * Todo App - Shogo SDK Example
 *
 * Demonstrates:
 * - Auto-generated server functions (from Prisma schema)
 * - Auto-generated domain store with optimistic updates
 * - Route loader for initial data
 */

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { useStores, type TodoType, type UserType } from '../stores'
import { getCurrentUser, createUser } from '../utils/user'
import { getTodoList } from '../generated/server-functions'

export const Route = createFileRoute('/')({
  loader: async () => {
    const user = await getCurrentUser()
    if (user) {
      const todos = await getTodoList({ data: { userId: user.id } })
      return { user, todos }
    }
    return { user: null, todos: [] }
  },
  component: TodoApp,
})

function TodoApp() {
  const { user, todos } = Route.useLoaderData()
  const router = useRouter()
  
  // Safety fallback for initialTodos - ensure it's always an array
  const initialTodos = Array.isArray(todos) ? todos : []

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <TodoList user={user} initialTodos={initialTodos} onSignOut={() => router.invalidate()} />
}

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setIsLoading(true)
    setError('')

    try {
      await createUser({ data: { email, name: name || undefined } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Todo App</h1>
          <p className="text-gray-500 text-sm mt-2">
            Built with <strong>@shogo-ai/sdk</strong>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-50"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-50"
          />

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-400">
          Uses auto-generated server functions from Prisma
        </p>
      </div>
    </div>
  )
}

const TodoList = observer(function TodoList({ 
  user,
  initialTodos,
  onSignOut,
}: { 
  user: UserType
  initialTodos: TodoType[]
  onSignOut: () => void 
}) {
  const store = useStores()
  const [newTitle, setNewTitle] = useState('')
  const [initialized, setInitialized] = useState(false)

  // Initialize store with server data on first render
  useEffect(() => {
    if (!initialized && initialTodos.length > 0) {
      runInAction(() => {
        for (const todo of initialTodos) {
          store.todo.items.set(todo.id, todo)
        }
      })
      setInitialized(true)
    }
  }, [initialized, initialTodos, store.todo])

  // Get todos from store (sorted by createdAt desc)
  const todos = store.todo.all.slice().sort((a, b) => {
    const dateA = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt)
    const dateB = b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt)
    return dateB.getTime() - dateA.getTime()
  })

  const completedCount = todos.filter(t => t.completed).length
  const pendingCount = todos.filter(t => !t.completed).length

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return

    try {
      await store.todo.create({
        title: newTitle.trim(),
        userId: user.id,
        completed: false,
      })
      setNewTitle('')
    } catch {
      // Error is handled by the store
    }
  }

  const handleToggle = async (todo: TodoType) => {
    try {
      await store.todo.update(todo.id, { completed: !todo.completed })
    } catch {
      // Error is handled by the store
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await store.todo.delete(id)
    } catch {
      // Error is handled by the store
    }
  }

  const handleSignOut = async () => {
    store.clearAll()
    onSignOut()
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        {/* Header */}
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-gray-100">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Todo App</h1>
            <p className="text-sm text-gray-500 mt-1">{user.name || user.email}</p>
          </div>
          <button
            onClick={handleSignOut}
            className="px-3 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Sign Out
          </button>
        </div>

        {/* Add Todo Form */}
        <form onSubmit={handleAdd} className="flex gap-2 mb-4">
          <input
            type="text"
            placeholder="What needs to be done?"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="flex-1 px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
          />
          <button
            type="submit"
            disabled={!newTitle.trim()}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </form>

        {/* Error Display */}
        {store.todo.error && (
          <div className="flex justify-between items-center p-3 bg-red-50 rounded-lg mb-4 text-red-600 text-sm">
            <p>{store.todo.error}</p>
            <button onClick={() => store.todo.clearError()} className="hover:underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Todo List */}
        {store.todo.isLoading && todos.length === 0 ? (
          <p className="text-center text-gray-400 py-8">Loading todos...</p>
        ) : todos.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No todos yet. Add one above!</p>
        ) : (
          <>
            {/* Stats */}
            <div className="flex gap-4 text-xs text-gray-500 mb-3">
              <span>{pendingCount} pending</span>
              <span>{completedCount} completed</span>
            </div>

            {/* Todo Items */}
            <ul className="space-y-1">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  className={`flex items-center gap-3 py-3 border-b border-gray-50 transition-opacity ${
                    store.todo.isPending(todo.id) ? 'opacity-60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => handleToggle(todo)}
                    disabled={store.todo.isPending(todo.id)}
                    className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span
                    className={`flex-1 text-sm ${
                      todo.completed ? 'line-through text-gray-400' : 'text-gray-900'
                    }`}
                  >
                    {todo.title}
                  </span>
                  <button
                    onClick={() => handleDelete(todo.id)}
                    disabled={store.todo.isPending(todo.id)}
                    className="px-2 py-1 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-gray-100 text-center text-xs text-gray-400">
          <p>
            Built with <code className="bg-gray-100 px-1 py-0.5 rounded">@shogo-ai/sdk</code> + auto-generated stores
          </p>
        </div>
      </div>
    </main>
  )
})
