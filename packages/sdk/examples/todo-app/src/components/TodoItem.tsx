import type { Todo } from '../App'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TodoItemProps {
  todo: Todo
  onToggle: () => void
  onDelete: () => void
}

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <li className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <Checkbox
        checked={todo.completed}
        onCheckedChange={onToggle}
        className="h-5 w-5"
      />
      <span
        className={cn(
          'flex-1 text-sm',
          todo.completed && 'line-through text-muted-foreground'
        )}
      >
        {todo.title}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDelete}
        className="text-destructive hover:text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  )
}
