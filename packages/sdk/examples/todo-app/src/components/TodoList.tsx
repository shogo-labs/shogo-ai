import type { Todo } from '../App'
import { TodoItem } from './TodoItem'

interface TodoListProps {
  todos: Todo[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

export function TodoList({ todos, onToggle, onDelete }: TodoListProps) {
  if (todos.length === 0) {
    return (
      <div style={styles.empty}>
        <p>No todos yet!</p>
        <p style={styles.emptyHint}>Add one above to get started.</p>
      </div>
    )
  }

  const completedCount = todos.filter((t) => t.completed).length

  return (
    <div>
      <div style={styles.stats}>
        {completedCount} of {todos.length} completed
      </div>
      <ul style={styles.list}>
        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={() => onToggle(todo.id)}
            onDelete={() => onDelete(todo.id)}
          />
        ))}
      </ul>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    textAlign: 'center',
    padding: '3rem 1rem',
    color: '#888',
  },
  emptyHint: {
    fontSize: '0.875rem',
    marginTop: '0.5rem',
  },
  stats: {
    fontSize: '0.875rem',
    color: '#888',
    marginBottom: '1rem',
  },
  list: {
    listStyle: 'none',
  },
}
