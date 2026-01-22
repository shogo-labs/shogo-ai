/**
 * Todo App - Shogo SDK Example
 * 
 * Demonstrates the SDK's Prisma pass-through:
 * - shogo.db.user.* for user operations
 * - shogo.db.todo.* for todo operations
 * 
 * Key pattern: shogo.db IS your Prisma client - same API, zero overhead
 */

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createUser, type UserType } from '../utils/user'
import { getTodos, createTodo, toggleTodo, deleteTodo, type TodoType } from '../utils/todos'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    if (!context.user) {
      return { todos: [] as TodoType[] }
    }

    const todos = await getTodos({ data: { userId: context.user.id } })
    return { todos }
  },
  component: TodoApp,
})

function TodoApp() {
  const { user } = Route.useRouteContext()
  const { todos } = Route.useLoaderData()
  const router = useRouter()

  if (!user) {
    return <SetupForm onComplete={() => router.invalidate()} />
  }

  return <TodoList user={user} todos={todos} />
}

function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setLoading(true)
    setError('')

    try {
      // Uses shogo.db.user.create() internally
      await createUser({ data: { email, name: name || undefined } })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    } finally {
      setLoading(false)
    }
  }

  return (
    <article style={{ maxWidth: '400px', margin: '4rem auto' }}>
      <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <h1>Todo App</h1>
        <p>Built with <strong>@shogo-ai/sdk</strong></p>
      </header>

      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <p style={{ color: '#e00', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? 'Setting up...' : 'Get Started'}
        </button>
      </form>

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#666' }}>
        <p>User created via <code>shogo.db.user.create()</code></p>
      </footer>
    </article>
  )
}

function TodoList({ user, todos }: { user: UserType; todos: TodoType[] }) {
  const router = useRouter()
  const [newTitle, setNewTitle] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim() || isLoading) return

    setIsLoading(true)
    // Uses shogo.db.todo.create()
    await createTodo({ data: { title: newTitle.trim(), userId: user.id } })
    setNewTitle('')
    setIsLoading(false)
    router.invalidate()
  }

  const handleToggle = async (id: string, completed: boolean) => {
    // Uses shogo.db.todo.update()
    await toggleTodo({ data: { id, userId: user.id, completed: !completed } })
    router.invalidate()
  }

  const handleDelete = async (id: string) => {
    // Uses shogo.db.todo.delete()
    await deleteTodo({ data: { id, userId: user.id } })
    router.invalidate()
  }

  return (
    <article>
      <header>
        <h1>Todo App</h1>
        <p>{user.name || user.email}</p>
      </header>

      <form onSubmit={handleAdd} role="group">
        <input
          type="text"
          placeholder="What needs to be done?"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !newTitle.trim()}>
          {isLoading ? 'Adding...' : 'Add'}
        </button>
      </form>

      {todos.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#666' }}>
          No todos yet. Add one above!
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {todos.map((todo) => (
            <li
              key={todo.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                padding: '0.75rem 0',
                borderBottom: '1px solid #e5e5e5',
              }}
            >
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => handleToggle(todo.id, todo.completed)}
                style={{ margin: 0 }}
              />
              <span
                style={{
                  flex: 1,
                  textDecoration: todo.completed ? 'line-through' : 'none',
                  opacity: todo.completed ? 0.6 : 1,
                }}
              >
                {todo.title}
              </span>
              <button
                className="outline secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.875rem' }}
                onClick={() => handleDelete(todo.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.875rem', color: '#666' }}>
        <p>
          All operations use <code>shogo.db</code> (Prisma pass-through)
        </p>
      </footer>
    </article>
  )
}
