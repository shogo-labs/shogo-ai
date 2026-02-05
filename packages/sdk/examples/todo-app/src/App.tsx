import { useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { TodoList } from './components/TodoList'
import { AddTodo } from './components/AddTodo'

const API_BASE = '/api'

export interface Todo {
  id: string
  title: string
  completed: boolean
  userId: string
  createdAt: string
  updatedAt: string
}

// Main todo list component (only shown when authenticated)
const TodoApp = observer(function TodoApp() {
  const { auth } = useStores()
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTodos = async () => {
    if (!auth.user) return

    try {
      // Fetch only todos for the current user
      const res = await fetch(`${API_BASE}/todos?userId=${auth.user.id}`)
      const data = await res.json()
      if (data.ok) {
        setTodos(data.items)
      } else {
        setError(data.error?.message || 'Failed to fetch todos')
      }
    } catch (err) {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTodos()
  }, [auth.user?.id])

  const addTodo = async (title: string) => {
    if (!auth.user) return

    try {
      const res = await fetch(`${API_BASE}/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, userId: auth.user.id }),
      })
      const data = await res.json()
      if (data.ok) {
        setTodos((prev) => [data.data, ...prev])
      } else {
        setError(data.error?.message || 'Failed to add todo')
      }
    } catch (err) {
      setError('Network error')
    }
  }

  const toggleTodo = async (id: string) => {
    const todo = todos.find((t) => t.id === id)
    if (!todo) return

    try {
      const res = await fetch(`${API_BASE}/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: !todo.completed }),
      })
      const data = await res.json()
      if (data.ok) {
        setTodos((prev) => prev.map((t) => (t.id === id ? data.data : t)))
      }
    } catch (err) {
      setError('Network error')
    }
  }

  const deleteTodo = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/todos/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.ok) {
        setTodos((prev) => prev.filter((t) => t.id !== id))
      }
    } catch (err) {
      setError('Network error')
    }
  }

  const handleLogout = () => {
    auth.signOut()
    setTodos([])
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Todo App</h1>
          <p style={styles.subtitle}>
            Welcome, <strong>{auth.user?.name || auth.user?.email}</strong>
          </p>
        </div>
        <button onClick={handleLogout} style={styles.logoutButton}>
          Sign Out
        </button>
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={() => setError(null)} style={styles.errorClose}>×</button>
        </div>
      )}

      <AddTodo onAdd={addTodo} />

      {loading ? (
        <p style={styles.loading}>Loading...</p>
      ) : (
        <TodoList todos={todos} onToggle={toggleTodo} onDelete={deleteTodo} />
      )}
    </div>
  )
})

// Root App component with AuthGate
export default function App() {
  return (
    <AuthGate>
      <TodoApp />
    </AuthGate>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'white',
    borderRadius: '16px',
    padding: '2rem',
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
    maxWidth: '500px',
    margin: '2rem auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1.5rem',
  },
  title: {
    fontSize: '2rem',
    fontWeight: 700,
    color: '#333',
    marginBottom: '0.25rem',
    margin: 0,
  },
  subtitle: {
    color: '#888',
    margin: '0.25rem 0 0 0',
    fontSize: '0.875rem',
  },
  logoutButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    cursor: 'pointer',
    transition: 'background-color 0.15s',
  },
  error: {
    background: '#fee2e2',
    color: '#dc2626',
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    marginBottom: '1rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorClose: {
    background: 'none',
    border: 'none',
    fontSize: '1.25rem',
    cursor: 'pointer',
    color: '#dc2626',
  },
  loading: {
    textAlign: 'center',
    color: '#888',
    padding: '2rem',
  },
}
