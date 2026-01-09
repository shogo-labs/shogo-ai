/**
 * Tool Types
 * Task: task-chat-005
 *
 * Shared types for tool timeline components.
 */

/** Tool category for styling */
export type ToolCategory = "mcp" | "file" | "skill" | "bash" | "other"

/** Tool execution state */
export type ToolExecutionState = "streaming" | "success" | "error"

/** Extracted tool call data for display */
export interface ToolCallData {
  /** Unique identifier */
  id: string
  /** Tool name (may include namespace) */
  toolName: string
  /** Tool category for color styling */
  category: ToolCategory
  /** Current execution state */
  state: ToolExecutionState
  /** Tool arguments (if available) */
  args?: Record<string, unknown>
  /** Tool result (if completed) */
  result?: unknown
  /** Error message (if failed) */
  error?: string
  /** Execution duration in ms (if completed) */
  duration?: number
  /** Timestamp when tool was called */
  timestamp: number
}

/**
 * Get tool category from tool name.
 */
export function getToolCategory(name: string): ToolCategory {
  if (name.startsWith("mcp__")) return "mcp"
  if (["Read", "Write", "Edit", "Glob", "Grep"].includes(name)) return "file"
  if (["Skill", "Task"].includes(name)) return "skill"
  if (["Bash"].includes(name)) return "bash"
  return "other"
}

/**
 * Format tool name for display.
 * Handles MCP namespacing: mcp__wavesmith__store_query -> wavesmith.store_query
 */
export function formatToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.replace("mcp__", "").split("__")
    return parts.join(".")
  }
  return name
}

/**
 * Get namespace from tool name (for styling).
 */
export function getToolNamespace(name: string): string | null {
  if (name.startsWith("mcp__")) {
    const parts = name.replace("mcp__", "").split("__")
    return parts[0] || null
  }
  return null
}
