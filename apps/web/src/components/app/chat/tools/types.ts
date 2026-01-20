/**
 * Tool Types
 * Task: task-chat-005
 *
 * Shared types for tool timeline components.
 */

/** Tool category for styling */
export type ToolCategory = "mcp" | "file" | "skill" | "bash" | "other"

// ============================================================
// AskUserQuestion Tool Types
// ============================================================

/** Single option in an AskUserQuestion question */
export interface AskUserQuestionOption {
  label: string
  description: string
}

/** Single question in an AskUserQuestion tool call */
export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

/** Args structure for the AskUserQuestion tool */
export interface AskUserQuestionArgs {
  questions: AskUserQuestionItem[]
}

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

// ============================================================
// Shared Gradient Configuration
// ============================================================

/** Gradient configuration for tool list fade effect */
export const GRADIENT_CONFIG = {
  /** Maximum number of items to show in collapsed/compact view */
  maxItems: 5,
  /** Opacity levels from most recent to oldest */
  opacities: [1, 0.85, 0.7, 0.55, 0.4] as const,
}

/**
 * Get opacity for gradient fade effect based on item index.
 * Most recent item (index 0) has highest opacity.
 */
export function getGradientOpacity(index: number): number {
  return GRADIENT_CONFIG.opacities[Math.min(index, GRADIENT_CONFIG.opacities.length - 1)]
}

// ============================================================
// Tool Key Argument Extraction
// ============================================================

/**
 * Extract the most relevant argument to display for a tool call.
 * Returns a concise, meaningful value for each tool type.
 */
export function getToolKeyArg(toolName: string, args?: Record<string, unknown>): string | null {
  if (!args) return null

  // AskUserQuestion - show first question header
  if (toolName === "AskUserQuestion") {
    const questions = args.questions as AskUserQuestionItem[] | undefined
    if (questions?.[0]?.header) {
      return questions[0].header
    }
  }

  // File operations - show file path
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const path = args.file_path as string | undefined
    if (path) {
      // Show just filename or last path segment for brevity
      const segments = path.split("/")
      return segments[segments.length - 1] || path
    }
  }

  // Search operations - show pattern
  if (toolName === "Grep" || toolName === "Glob") {
    const pattern = args.pattern as string | undefined
    if (pattern) {
      // Truncate long patterns
      return pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern
    }
  }

  // Bash - show command (truncated)
  if (toolName === "Bash") {
    const command = args.command as string | undefined
    if (command) {
      // Show first line, truncated
      const firstLine = command.split("\n")[0]
      return firstLine.length > 40 ? firstLine.slice(0, 37) + "..." : firstLine
    }
  }

  // Task - show description
  if (toolName === "Task") {
    const desc = args.description as string | undefined
    if (desc) {
      return desc.length > 30 ? desc.slice(0, 27) + "..." : desc
    }
  }

  // Skill - show skill name
  if (toolName === "Skill") {
    return args.skill as string | undefined || null
  }

  // MCP wavesmith tools - extract relevant arg
  if (toolName.startsWith("mcp__wavesmith__")) {
    const shortName = toolName.replace("mcp__wavesmith__", "")

    // Schema operations
    if (shortName.startsWith("schema_")) {
      return args.name as string | undefined || args.schemaName as string | undefined || null
    }

    // Store operations
    if (shortName.startsWith("store_")) {
      const model = args.model as string | undefined
      const schema = args.schema as string | undefined
      if (model && schema) return `${schema}.${model}`
      return model || schema || null
    }

    // View operations
    if (shortName.startsWith("view_")) {
      return args.view as string | undefined || args.name as string | undefined || null
    }
  }

  // MCP obsidian tools
  if (toolName.startsWith("mcp__obsidian")) {
    return args.filename as string | undefined ||
           args.query as string | undefined ||
           args.directory as string | undefined || null
  }

  // MCP chrome-devtools tools
  if (toolName.startsWith("mcp__chrome-devtools__")) {
    const shortName = toolName.replace("mcp__chrome-devtools__", "")
    if (shortName === "navigate_page") return args.url as string | undefined || null
    if (shortName === "click" || shortName === "fill" || shortName === "hover") {
      return args.uid as string | undefined || null
    }
    if (shortName === "evaluate_script") return "script"
    if (shortName === "take_screenshot") return args.fullPage ? "full page" : "viewport"
  }

  // Fallback: try common argument names
  const fallbackKeys = ["name", "path", "query", "pattern", "id", "url"]
  for (const key of fallbackKeys) {
    if (typeof args[key] === "string") {
      const val = args[key] as string
      return val.length > 30 ? val.slice(0, 27) + "..." : val
    }
  }

  return null
}
