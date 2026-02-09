import type { Todo } from '../App'

interface TodoItemProps {
  todo: Todo
  onToggle: () => void
  onDelete: () => void
}

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <li style={styles.item}>
      <label style={styles.label}>
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={onToggle}
          style={styles.checkbox}
        />
        <span style={{
          ...styles.title,
          textDecoration: todo.completed ? 'line-through' : 'none',
          color: todo.completed ? '#888' : '#333',
        }}>
          {todo.title}
        </span>
      </label>
      <button onClick={onDelete} style={styles.delete}>
        Delete
      </button>
    </li>
  )
}

const styles: Record<string, React.CSSProperties> = {
  item: {
    padding: '1rem',
    borderRadius: '8px',
    background: '#f9fafb',
    marginBottom: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    cursor: 'pointer',
    flex: 1,
  },
  checkbox: {
    width: '1.25rem',
    height: '1.25rem',
    cursor: 'pointer',
  },
  title: {
    fontSize: '1rem',
    flex: 1,
  },
  delete: {
    background: 'none',
    border: '1px solid #dc2626',
    color: '#dc2626',
    padding: '0.25rem 0.75rem',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
}
