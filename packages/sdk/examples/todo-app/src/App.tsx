import { useState, useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { useStores } from './stores'
import { AuthGate } from './components/AuthGate'
import { TodoList } from './components/TodoList'
import { AddTodo } from './components/AddTodo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckSquare, LogOut, Loader2, AlertCircle, X } from 'lucide-react'

const API_BASE = '/api'

export interface Todo {
  id: string
  title: string
  completed: boolean
  userId: string
  createdAt: string
  updatedAt: string
}

const TodoApp = observer(function TodoApp() {
  const { auth } = useStores()
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTodos = async () => {
    if (!auth.user) return
    try {
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

  const completedCount = todos.filter((t) => t.completed).length

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckSquare className="h-5 w-5" />
              <CardTitle>Todo App</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { auth.signOut(); setTodos([]) }}>
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
          <CardDescription>
            Welcome, <span className="font-medium text-foreground">{auth.user?.name || auth.user?.email}</span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
              <button onClick={() => setError(null)} className="cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <AddTodo onAdd={addTodo} />

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {todos.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {completedCount} of {todos.length} completed
                </p>
              )}
              <TodoList todos={todos} onToggle={toggleTodo} onDelete={deleteTodo} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
})

export default function App() {
  return (
    <AuthGate>
      <TodoApp />
    </AuthGate>
  )
}
