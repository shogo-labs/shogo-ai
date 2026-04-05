// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Types (React Native)
 *
 * Shared types for tool timeline components.
 * Identical to web version — pure TypeScript, no DOM dependencies.
 */

export type ToolCategory = "mcp" | "file" | "skill" | "bash" | "other"

export interface AskUserQuestionOption {
  label: string
  description: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

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

export interface AskUserQuestionArgs {
  questions: AskUserQuestionItem[]
}

export type ToolExecutionState = "streaming" | "success" | "error"

export interface ToolCallData {
  id: string
  toolName: string
  category: ToolCategory
  state: ToolExecutionState
  args?: Record<string, unknown>
  result?: unknown
  error?: string
  duration?: number
  timestamp: number
}

export function getToolCategory(name: string): ToolCategory {
  if (name.startsWith("mcp__")) return "mcp"
  if (["Read", "Write", "Edit", "Glob", "Grep", "read_file", "write_file", "edit_file", "glob", "grep", "search"].includes(name)) return "file"
  if (["Skill", "Task", "task", "skill"].includes(name)) return "skill"
  if (["Bash", "exec"].includes(name)) return "bash"
  return "other"
}

export function formatToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.replace("mcp__", "").split("__")
    return parts.join(".")
  }
  return name
}

export function getToolNamespace(name: string): string | null {
  if (name.startsWith("mcp__")) {
    const parts = name.replace("mcp__", "").split("__")
    return parts[0] || null
  }
  return null
}

export const GRADIENT_CONFIG = {
  maxItems: 5,
  opacities: [1, 0.85, 0.7, 0.55, 0.4] as const,
}

export function getGradientOpacity(index: number): number {
  return GRADIENT_CONFIG.opacities[Math.min(index, GRADIENT_CONFIG.opacities.length - 1)]
}

export function getToolKeyArg(toolName: string, args?: Record<string, unknown>): string | null {
  if (!args) return null

  if (toolName === "ask_user") {
    const questions = args.questions as AskUserQuestionItem[] | undefined
    if (questions?.[0]?.header) {
      return questions[0].header
    }
  }

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit" ||
      toolName === "read_file" || toolName === "write_file" || toolName === "edit_file") {
    const path = (args.file_path ?? args.path) as string | undefined
    if (path) {
      const segments = path.split("/")
      return segments[segments.length - 1] || path
    }
  }

  if (toolName === "Grep" || toolName === "Glob" || toolName === "grep" || toolName === "glob" || toolName === "search") {
    const pattern = args.pattern as string | undefined
    if (pattern) {
      return pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern
    }
  }

  if (toolName === "Bash" || toolName === "exec") {
    const command = args.command as string | undefined
    if (command) {
      const firstLine = command.split("\n")[0]
      return firstLine.length > 40 ? firstLine.slice(0, 37) + "..." : firstLine
    }
  }

  if (toolName === "browser") {
    const action = args.action as string | undefined
    if (action === "navigate") {
      const url = args.url as string | undefined
      if (url) return url.length > 30 ? url.slice(0, 27) + "..." : url
    }
    return action || null
  }

  if (toolName === "Task") {
    const desc = args.description as string | undefined
    if (desc) {
      return desc.length > 30 ? desc.slice(0, 27) + "..." : desc
    }
  }

  if (toolName === "Skill") {
    return (args.skill as string | undefined) || null
  }

  if (toolName.startsWith("mcp__shogo__")) {
    const shortName = toolName.replace("mcp__shogo__", "")

    if (shortName.startsWith("schema_")) {
      return (args.name as string | undefined) || (args.schemaName as string | undefined) || null
    }

    if (shortName.startsWith("store_")) {
      const model = args.model as string | undefined
      const schema = args.schema as string | undefined
      if (model && schema) return `${schema}.${model}`
      return model || schema || null
    }

    if (shortName.startsWith("view_")) {
      return (args.view as string | undefined) || (args.name as string | undefined) || null
    }
  }

  if (toolName.startsWith("mcp__obsidian")) {
    return (
      (args.filename as string | undefined) ||
      (args.query as string | undefined) ||
      (args.directory as string | undefined) ||
      null
    )
  }

  if (toolName.startsWith("mcp__chrome-devtools__")) {
    const shortName = toolName.replace("mcp__chrome-devtools__", "")
    if (shortName === "navigate_page") return (args.url as string | undefined) || null
    if (shortName === "click" || shortName === "fill" || shortName === "hover") {
      return (args.uid as string | undefined) || null
    }
    if (shortName === "evaluate_script") return "script"
    if (shortName === "take_screenshot") return args.fullPage ? "full page" : "viewport"
  }

  const fallbackKeys = ["name", "path", "query", "pattern", "id", "url"]
  for (const key of fallbackKeys) {
    if (typeof args[key] === "string") {
      const val = args[key] as string
      return val.length > 30 ? val.slice(0, 27) + "..." : val
    }
  }

  return null
}
