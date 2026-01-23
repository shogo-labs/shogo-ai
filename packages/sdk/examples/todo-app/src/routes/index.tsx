/**
 * Todo App - Shogo SDK Example
 *
 * Demonstrates:
 * - Server functions for database operations
 * - Route loader for initial data
 * - MobX store for todo state with optimistic updates
 */

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'
import { createUser, getCurrentUser, type UserType } from '../utils/user'
import { getTodos } from '../utils/todos'

export const Route = createFileRoute('/')({
  loader: async () => {
    const user = await getCurrentUser()
    if (user) {
      const todos = await getTodos({ data: { userId: user.id } })
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
    console.log('[SetupForm] handleSubmit called with email:', email, 'name:', name)
    if (!email) return

    setIsLoading(true)
    setError('')

    try {
      console.log('[SetupForm] calling createUser...')
      const user = await createUser({ data: { email, name: name || undefined } })
      console.log('[SetupForm] createUser returned:', user)
      onComplete()
    } catch (err) {
      console.error('[SetupForm] createUser error:', err)
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
          <p>Uses <code>shogo.db</code> via server functions</p>
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
  initialTodos: any[]
  onSignOut: () => void 
}) {
  const { todos } = useStores()
  const router = useRouter()
  const [newTitle, setNewTitle] = useState('')
  const [initialized, setInitialized] = useState(false)

  // Initialize MobX store with server data on first render
  if (!initialized && initialTodos.length > 0) {
    todos.todos = initialTodos
    setInitialized(true)
  }

  // Load fresh todos if store is empty
  if (!initialized && initialTodos.length === 0 && !todos.isLoading) {
    todos.loadTodos(user.id)
    setInitialized(true)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTitle.trim()) return

    try {
      await todos.addTodo(newTitle.trim(), user.id)
      setNewTitle('')
    } catch {
      // Error is handled by the store
    }
  }

  const handleToggle = async (id: string) => {
    try {
      await todos.toggleTodoItem(id, user.id)
    } catch {
      // Error is handled by the store
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await todos.deleteTodoItem(id, user.id)
    } catch {
      // Error is handled by the store
    }
  }

  const handleSignOut = async () => {
    todos.clear()
    // Delete user from DB to reset demo state
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
        {todos.error && (
          <div style={styles.errorBox}>
            <p>{todos.error}</p>
            <button onClick={() => todos.clearError()} style={styles.dismissButton}>
              Dismiss
            </button>
          </div>
        )}

        {/* Todo List */}
        {todos.isLoading && todos.todos.length === 0 ? (
          <p style={styles.emptyState}>Loading todos...</p>
        ) : todos.todos.length === 0 ? (
          <p style={styles.emptyState}>No todos yet. Add one above!</p>
        ) : (
          <>
            {/* Stats */}
            <div style={styles.stats}>
              <span>{todos.pendingCount} pending</span>
              <span>{todos.completedCount} completed</span>
            </div>

            {/* Todo Items */}
            <ul style={styles.list}>
              {todos.todos.map((todo) => (
                <li
                  key={todo.id}
                  style={{
                    ...styles.todoItem,
                    opacity: todos.isPending(todo.id) ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => handleToggle(todo.id)}
                    disabled={todos.isPending(todo.id)}
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
                    disabled={todos.isPending(todo.id)}
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
            Built with <code>@shogo-ai/sdk</code> + MobX
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
