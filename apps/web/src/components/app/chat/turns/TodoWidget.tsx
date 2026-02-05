/**
 * TodoWidget Component
 * 
 * Renders the agent's task list from TodoWrite tool calls.
 * Inspired by AI SDK Elements Task component and Cursor's todo display.
 * 
 * Shows:
 * - Task list with status indicators (pending, in_progress, completed, cancelled)
 * - Collapsible details
 * - Progress tracking
 */

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  ChevronRight,
  ChevronDown,
  ListTodo,
} from "lucide-react"
import type { ToolCallData } from "../tools/types"

// ============================================================
// Types
// ============================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export interface TodoWriteArgs {
  todos: TodoItem[]
  merge: boolean
}

export interface TodoWidgetProps {
  /** Tool call data containing the todos */
  tool: ToolCallData
  /** Whether the widget is expanded (controlled mode) */
  isExpanded?: boolean
  /** Callback when expand/collapse is toggled */
  onToggle?: () => void
  /** Optional class name */
  className?: string
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Validate a todo item has required fields
 */
function isValidTodoItem(item: unknown): item is TodoItem {
  if (!item || typeof item !== "object") return false
  const t = item as Record<string, unknown>
  return (
    typeof t.id === "string" &&
    typeof t.content === "string" &&
    typeof t.status === "string" &&
    ["pending", "in_progress", "completed", "cancelled"].includes(t.status as string)
  )
}

/**
 * Parse todos from tool args with validation
 */
function parseTodos(args?: Record<string, unknown>): TodoItem[] {
  if (!args?.todos || !Array.isArray(args.todos)) {
    return []
  }
  return args.todos.filter(isValidTodoItem)
}

/**
 * Get status icon component
 */
function getStatusIcon(status: TodoStatus) {
  switch (status) {
    case "completed":
      return CheckCircle2
    case "in_progress":
      return Loader2
    case "cancelled":
      return XCircle
    case "pending":
    default:
      return Circle
  }
}

/**
 * Get status color classes
 */
function getStatusColors(status: TodoStatus) {
  switch (status) {
    case "completed":
      return "text-green-500"
    case "in_progress":
      return "text-blue-500"
    case "cancelled":
      return "text-muted-foreground line-through"
    case "pending":
    default:
      return "text-muted-foreground"
  }
}

// ============================================================
// Sub-Components
// ============================================================

interface TodoItemRowProps {
  todo: TodoItem
  index: number
}

function TodoItemRow({ todo, index }: TodoItemRowProps) {
  const StatusIcon = getStatusIcon(todo.status)
  const colorClass = getStatusColors(todo.status)
  
  return (
    <div
      className={cn(
        "flex items-start gap-2 py-1.5 px-2",
        "animate-in fade-in slide-in-from-left-2",
        todo.status === "cancelled" && "opacity-50"
      )}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Status icon */}
      <StatusIcon
        className={cn(
          "w-3.5 h-3.5 mt-0.5 shrink-0 transition-colors",
          colorClass,
          todo.status === "in_progress" && "animate-spin"
        )}
      />
      
      {/* Content */}
      <span
        className={cn(
          "text-xs flex-1",
          todo.status === "completed" && "text-muted-foreground",
          todo.status === "cancelled" && "line-through text-muted-foreground"
        )}
      >
        {todo.content}
      </span>
    </div>
  )
}

interface ProgressBarProps {
  todos: TodoItem[]
}

function ProgressBar({ todos }: ProgressBarProps) {
  const total = todos.length
  const completed = todos.filter(t => t.status === "completed").length
  const inProgress = todos.filter(t => t.status === "in_progress").length
  const cancelled = todos.filter(t => t.status === "cancelled").length
  
  if (total === 0) return null
  
  const completedPercent = (completed / total) * 100
  const inProgressPercent = (inProgress / total) * 100
  
  return (
    <div className="space-y-1">
      {/* Progress bar */}
      <div className="h-1 bg-muted rounded-full overflow-hidden flex">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${completedPercent}%` }}
        />
        <div
          className="h-full bg-blue-500 transition-all duration-300"
          style={{ width: `${inProgressPercent}%` }}
        />
      </div>
      
      {/* Stats */}
      <div className="flex gap-3 text-[9px] text-muted-foreground">
        <span>{completed}/{total} completed</span>
        {inProgress > 0 && <span className="text-blue-500">{inProgress} in progress</span>}
        {cancelled > 0 && <span>{cancelled} cancelled</span>}
      </div>
    </div>
  )
}

// ============================================================
// Main Component
// ============================================================

export function TodoWidget({
  tool,
  isExpanded: controlledExpanded,
  onToggle,
  className,
}: TodoWidgetProps) {
  // Parse todos from tool args
  const todos = useMemo(() => parseTodos(tool.args), [tool.args])
  
  // Default to expanded
  const isExpanded = controlledExpanded ?? true
  
  // Handle toggle
  const handleToggle = () => {
    onToggle?.()
  }
  
  // Calculate summary stats
  const stats = useMemo(() => {
    const total = todos.length
    const completed = todos.filter(t => t.status === "completed").length
    const inProgress = todos.filter(t => t.status === "in_progress").length
    return { total, completed, inProgress }
  }, [todos])
  
  // Streaming state - show loading while args are being populated
  const isStreaming = tool.state === "streaming" && todos.length === 0
  
  if (isStreaming) {
    return (
      <div
        className={cn(
          "rounded-md border border-blue-500/20 bg-blue-500/5 p-2",
          "animate-in fade-in duration-200",
          className
        )}
      >
        <div className="flex items-center gap-1.5">
          <ListTodo className="w-3 h-3 text-blue-500 animate-pulse" />
          <span
            className="font-mono text-[10px] font-medium text-foreground"
            style={{ fontFamily: "var(--font-display)" }}
          >
            TodoWrite
          </span>
          <span className="text-[9px] text-muted-foreground">Planning tasks...</span>
        </div>
      </div>
    )
  }
  
  // Empty state
  if (todos.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-border/50 bg-muted/30 p-2",
          className
        )}
      >
        <div className="flex items-center gap-1.5">
          <ListTodo className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">No tasks</span>
        </div>
      </div>
    )
  }
  
  // Determine border color based on progress
  const allComplete = stats.completed === stats.total
  const hasInProgress = stats.inProgress > 0
  
  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden transition-all duration-300",
        allComplete
          ? "border-green-500/30 bg-green-500/5"
          : hasInProgress
          ? "border-blue-500/30 bg-blue-500/5"
          : "border-border/50 bg-muted/30",
        "animate-in fade-in slide-in-from-bottom-2 duration-300",
        className
      )}
    >
      {/* Header - always visible */}
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          "w-full flex items-center gap-1.5 py-1.5 px-2",
          "hover:bg-muted/50 transition-colors",
          "text-left"
        )}
      >
        {/* Expand/collapse chevron */}
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
        
        {/* Icon */}
        <ListTodo
          className={cn(
            "w-3 h-3 shrink-0",
            allComplete
              ? "text-green-500"
              : hasInProgress
              ? "text-blue-500"
              : "text-muted-foreground"
          )}
        />
        
        {/* Title */}
        <span
          className="font-mono text-[10px] font-medium text-foreground"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Tasks
        </span>
        
        {/* Summary stats */}
        <span className="flex-1 text-[9px] text-muted-foreground text-right">
          {stats.completed}/{stats.total} complete
          {stats.inProgress > 0 && (
            <span className="ml-1.5 text-blue-500">
              • {stats.inProgress} active
            </span>
          )}
        </span>
        
        {/* Status icon */}
        {allComplete ? (
          <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
        ) : hasInProgress ? (
          <Loader2 className="w-3 h-3 text-blue-500 shrink-0 animate-spin" />
        ) : null}
      </button>
      
      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-border/50 animate-in fade-in duration-200">
          {/* Progress bar */}
          <div className="px-3 pt-2">
            <ProgressBar todos={todos} />
          </div>
          
          {/* Task list */}
          <div className="py-1">
            {todos.map((todo, index) => (
              <TodoItemRow key={todo.id} todo={todo} index={index} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default TodoWidget
