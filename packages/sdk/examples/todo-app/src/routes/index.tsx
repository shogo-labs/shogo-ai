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
  const { user, todos: initialTodos } = Route.useLoaderData()
  const router = useRouter()

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
    <div style={styles.container}>
      <article style={styles.card}>
        <header style={styles.header}>
          <h1 style={styles.title}>Todo App</h1>
          <p style={styles.subtitle}>
            Built with <strong>@shogo-ai/sdk</strong>
          </p>
        </header>

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isLoading}
            style={styles.input}
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            style={styles.input}
          />

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" disabled={isLoading} style={styles.submitButton}>
            {isLoading ? 'Setting up...' : 'Get Started'}
          </button>
        </form>

        <footer style={styles.footer}>
          <p>Uses auto-generated server functions from Prisma</p>
        </footer>
      </article>
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
    if (!initialized) {
      // Load initial todos into the store
      for (const todo of initialTodos) {
        store.todo.items.set(todo.id, todo)
      }
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
    <main style={styles.container}>
      <article style={styles.card}>
        {/* Header */}
        <header style={styles.listHeader}>
          <div>
            <h1 style={styles.title}>Todo App</h1>
            <p style={styles.userInfo}>{user.name || user.email}</p>
          </div>
          <button onClick={handleSignOut} style={styles.signOutButton}>
            Sign Out
          </button>
        </header>

        {/* Add Todo Form */}
        <form onSubmit={handleAdd} style={styles.addForm}>
          <input
            type="text"
            placeholder="What needs to be done?"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            style={styles.input}
          />
          <button
            type="submit"
            disabled={!newTitle.trim()}
            style={{
              ...styles.addButton,
              opacity: newTitle.trim() ? 1 : 0.5,
            }}
          >
            Add
          </button>
        </form>

        {/* Error Display */}
        {store.todo.error && (
          <div style={styles.errorBox}>
            <p>{store.todo.error}</p>
            <button onClick={() => store.todo.clearError()} style={styles.dismissButton}>
              Dismiss
            </button>
          </div>
        )}

        {/* Todo List */}
        {store.todo.isLoading && todos.length === 0 ? (
          <p style={styles.emptyState}>Loading todos...</p>
        ) : todos.length === 0 ? (
          <p style={styles.emptyState}>No todos yet. Add one above!</p>
        ) : (
          <>
            {/* Stats */}
            <div style={styles.stats}>
              <span>{pendingCount} pending</span>
              <span>{completedCount} completed</span>
            </div>

            {/* Todo Items */}
            <ul style={styles.list}>
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  style={{
                    ...styles.todoItem,
                    opacity: store.todo.isPending(todo.id) ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => handleToggle(todo)}
                    disabled={store.todo.isPending(todo.id)}
                    style={styles.checkbox}
                  />
                  <span
                    style={{
                      ...styles.todoTitle,
                      textDecoration: todo.completed ? 'line-through' : 'none',
                      color: todo.completed ? '#9ca3af' : '#111827',
                    }}
                  >
                    {todo.title}
                  </span>
                  <button
                    onClick={() => handleDelete(todo.id)}
                    disabled={store.todo.isPending(todo.id)}
                    style={styles.deleteButton}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Footer */}
        <footer style={styles.listFooter}>
          <p>
            Built with <code>@shogo-ai/sdk</code> + auto-generated stores
          </p>
        </footer>
      </article>
    </main>
  )
})

// Styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    backgroundColor: '#f9fafb',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: '12px',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
    padding: '2rem',
    width: '100%',
    maxWidth: '500px',
  },
  header: {
    textAlign: 'center',
    marginBottom: '1.5rem',
  },
  listHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
    paddingBottom: '1rem',
    borderBottom: '1px solid #e5e7eb',
  },
  title: {
    fontSize: '1.5rem',
    fontWeight: '700',
    color: '#111827',
    margin: 0,
  },
  subtitle: {
    color: '#6b7280',
    fontSize: '0.875rem',
    marginTop: '0.5rem',
  },
  userInfo: {
    fontSize: '0.875rem',
    color: '#6b7280',
    marginTop: '0.25rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  addForm: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '1rem',
  },
  input: {
    flex: 1,
    padding: '0.75rem 1rem',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    fontSize: '0.875rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  error: {
    color: '#dc2626',
    fontSize: '0.875rem',
    margin: '0.25rem 0',
  },
  errorBox: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.75rem 1rem',
    backgroundColor: '#fef2f2',
    borderRadius: '8px',
    marginBottom: '1rem',
    color: '#dc2626',
    fontSize: '0.875rem',
  },
  dismissButton: {
    background: 'none',
    border: 'none',
    color: '#dc2626',
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
  submitButton: {
    width: '100%',
    padding: '0.75rem 1rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: '500',
    cursor: 'pointer',
  },
  addButton: {
    padding: '0.75rem 1.5rem',
    backgroundColor: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: '500',
    cursor: 'pointer',
  },
  signOutButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#f3f4f6',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    fontSize: '0.875rem',
    color: '#374151',
    cursor: 'pointer',
  },
  stats: {
    display: 'flex',
    gap: '1rem',
    fontSize: '0.75rem',
    color: '#6b7280',
    marginBottom: '0.75rem',
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  todoItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 0',
    borderBottom: '1px solid #f3f4f6',
    transition: 'opacity 0.15s',
  },
  checkbox: {
    width: '18px',
    height: '18px',
    cursor: 'pointer',
  },
  todoTitle: {
    flex: 1,
    fontSize: '0.9375rem',
  },
  deleteButton: {
    padding: '0.25rem 0.75rem',
    backgroundColor: 'transparent',
    border: '1px solid #e5e7eb',
    borderRadius: '4px',
    fontSize: '0.75rem',
    color: '#6b7280',
    cursor: 'pointer',
  },
  emptyState: {
    textAlign: 'center',
    color: '#9ca3af',
    padding: '2rem 0',
  },
  footer: {
    marginTop: '1.5rem',
    textAlign: 'center',
    fontSize: '0.75rem',
    color: '#9ca3af',
  },
  listFooter: {
    marginTop: '1.5rem',
    paddingTop: '1rem',
    borderTop: '1px solid #e5e7eb',
    textAlign: 'center',
    fontSize: '0.75rem',
    color: '#9ca3af',
  },
}
