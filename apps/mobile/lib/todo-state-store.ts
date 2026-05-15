// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Session-scoped store for the chat's TodoWrite state.
 *
 * Each `TodoWrite` tool call sends a brand-new snapshot of the agent's
 * task list. The chat used to render every call as its own frozen
 * widget, which left earlier widgets stuck at their initial state
 * (e.g. "0/10") while later widgets showed the up-to-date counts.
 *
 * This store holds the *latest* snapshot for the current session plus
 * the ordered list of tool-call ids that have written into it. The
 * first id is treated as the "primary" widget that should default to
 * expanded and reflect the latest body; every later id is a milestone
 * marker whose collapsed header keeps its own snapshot count but
 * whose expanded body also reads from the latest snapshot.
 *
 * Cleared on session change by `ChatPanel`.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

let latestTodos: TodoItem[] = []
const orderedToolIds: string[] = []
const idIndex = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  listeners.forEach((fn) => fn())
}

const validStatuses: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]

/**
 * Normalize a TodoWrite tool's `args` payload into a flat `TodoItem[]`.
 * Accepts the canonical `{ todos: [...] }` shape, a stringified
 * version of it, and the AI SDK's `{ input: { todos: [...] } }`
 * wrapping. Returns `[]` for anything malformed or empty so callers
 * can use `length > 0` as a cheap "real snapshot" guard.
 */
export function parseTodos(args?: Record<string, unknown>): TodoItem[] {
  if (!args) return []

  let todosArray: unknown[] | undefined

  if (Array.isArray(args.todos)) {
    todosArray = args.todos
  } else if (typeof args.todos === "string") {
    try {
      const parsed = JSON.parse(args.todos)
      if (Array.isArray(parsed)) todosArray = parsed
    } catch {
      /* ignore */
    }
  } else if (args.input && typeof args.input === "object") {
    const input = args.input as Record<string, unknown>
    if (Array.isArray(input.todos)) {
      todosArray = input.todos
    }
  }

  if (!todosArray || todosArray.length === 0) return []

  return todosArray
    .filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object") return false
      const t = item as Record<string, unknown>
      return typeof t.content === "string" && t.content.length > 0
    })
    .map((item, index): TodoItem => {
      const t = item as Record<string, unknown>
      const rawStatus = typeof t.status === "string" ? t.status : ""
      return {
        id: typeof t.id === "string" ? t.id : `todo-${index}`,
        content: t.content as string,
        status: validStatuses.includes(rawStatus as TodoStatus)
          ? (rawStatus as TodoStatus)
          : "pending",
      }
    })
}

export const todoStateStore = {
  getVersion(): number {
    return version
  },

  getLatest(): TodoItem[] {
    return latestTodos
  },

  getFirstId(): string | undefined {
    return orderedToolIds[0]
  },

  isFirst(toolId: string): boolean {
    return orderedToolIds[0] === toolId
  },

  hasRegistered(toolId: string): boolean {
    return idIndex.has(toolId)
  },

  /**
   * Record a TodoWrite snapshot from a specific tool call.
   *
   * - First call for a given `toolId` appends it to the ordered list
   *   so the first writer is stable for the session (this is what
   *   selects the primary, default-expanded card).
   * - Every call overwrites `latestTodos` so subscribers always see
   *   the freshest agent state.
   */
  registerWrite(toolId: string, todos: TodoItem[]) {
    let changed = false
    if (!idIndex.has(toolId)) {
      idIndex.add(toolId)
      orderedToolIds.push(toolId)
      changed = true
    }
    if (latestTodos !== todos) {
      latestTodos = todos
      changed = true
    }
    if (changed) notify()
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  clear() {
    latestTodos = []
    orderedToolIds.length = 0
    idIndex.clear()
    notify()
  },
}
