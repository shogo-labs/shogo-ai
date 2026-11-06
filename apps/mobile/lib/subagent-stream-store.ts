// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ephemeral store for sub-agent stream content.
 *
 * ChatPanel accumulates sub-agent parts (text, reasoning, tool calls) here
 * keyed by tool call ID. The AgentsPanel reads from this store to render
 * all sub-agents in the "Agents" tab.
 *
 * Module-level Map — survives across renders but is cleared when the
 * streaming session ends.
 */

import type { MessagePart } from "../components/chat/turns/types"
import { logScreencast } from "./screencast-debug"

export type SubagentStreamPart = MessagePart

export interface SubagentStreamData {
  agentId: string
  /** AgentManager instance id — used to open the live browser screencast SSE stream. */
  instanceId?: string
  agentType: string
  description: string
  /** Concrete LLM model id the subagent is running on (displayed as a badge). */
  model?: string
  status: "running" | "completed" | "error"
  parts: SubagentStreamPart[]
}

const store = new Map<string, SubagentStreamData>()
const listeners = new Set<() => void>()
const toolListeners = new Map<string, Set<() => void>>()
let tabSwitchHandler: ((toolId?: string) => void) | null = null
let version = 0

function notify(toolId?: string) {
  version++
  listeners.forEach((fn) => fn())
  if (toolId) toolListeners.get(toolId)?.forEach((fn) => fn())
}

/**
 * Whether `parts` is the same transcript the entry already holds. The
 * transcript is append-only, so the only part that changes in place is the
 * last one — a tool going `streaming → success`, or text still growing.
 */
function samePartsTail(prev: SubagentStreamPart[], next: SubagentStreamPart[]): boolean {
  if (prev === next) return true
  if (prev.length !== next.length) return false
  const a = prev[prev.length - 1] as any
  const b = next[next.length - 1] as any
  if (!a || !b) return a === b
  if (a === b) return true
  if (a.type !== b.type) return false
  if (a.type === "tool") return a.id === b.id && a.tool?.state === b.tool?.state && a.tool?.result === b.tool?.result
  return a.id === b.id && a.text === b.text
}

export const subagentStreamStore = {
  getVersion(): number {
    return version
  },

  get(toolId: string): SubagentStreamData | undefined {
    return store.get(toolId)
  },

  getAll(): Map<string, SubagentStreamData> {
    return store
  },

  init(toolId: string, data: Omit<SubagentStreamData, "parts">) {
    const existing = store.get(toolId)
    if (existing) {
      const next = {
        ...existing,
        agentType: data.agentType || existing.agentType,
        description: data.description || existing.description,
        status: data.status,
      }
      // Re-read on every streaming frame: an unchanged entry must not wake
      // every subscriber.
      if (
        next.agentType === existing.agentType &&
        next.description === existing.description &&
        next.status === existing.status
      ) {
        return
      }
      store.set(toolId, next)
    } else {
      store.set(toolId, { ...data, parts: [] })
    }
    notify(toolId)
  },

  setParts(toolId: string, parts: SubagentStreamPart[]) {
    const entry = store.get(toolId)
    if (!entry) return
    if (samePartsTail(entry.parts, parts)) return
    store.set(toolId, { ...entry, parts })
    notify(toolId)
  },

  appendPart(toolId: string, part: SubagentStreamPart) {
    const entry = store.get(toolId)
    if (!entry) return
    store.set(toolId, { ...entry, parts: [...entry.parts, part] })
    notify(toolId)
  },

  updateStatus(toolId: string, status: SubagentStreamData["status"]) {
    const entry = store.get(toolId)
    if (!entry || entry.status === status) return
    store.set(toolId, { ...entry, status })
    notify(toolId)
  },

  setInstanceId(toolId: string, instanceId: string) {
    const entry = store.get(toolId)
    if (!entry || entry.instanceId === instanceId) return
    logScreencast(
      `[screencast] subagentStreamStore.setInstanceId toolId=${toolId} ` +
      `instanceId=${instanceId}`,
    )
    store.set(toolId, { ...entry, instanceId })
    notify(toolId)
  },

  setModel(toolId: string, model: string) {
    const entry = store.get(toolId)
    if (!entry || entry.model === model) return
    store.set(toolId, { ...entry, model })
    notify(toolId)
  },

  clear() {
    store.clear()
    notify()
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  /**
   * Subscribe to one sub-agent's entry. A card uses this so a frame for a
   * different (or a sibling) sub-agent does not re-render it.
   */
  subscribeTool(toolId: string, fn: () => void): () => void {
    const set = toolListeners.get(toolId) ?? new Set<() => void>()
    toolListeners.set(toolId, set)
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) toolListeners.delete(toolId)
    }
  },

  onRequestTabSwitch(handler: ((toolId?: string) => void) | null) {
    tabSwitchHandler = handler
  },

  requestTabSwitch(toolId?: string) {
    tabSwitchHandler?.(toolId)
  },
}
