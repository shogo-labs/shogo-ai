// SPDX-License-Identifier: AGPL-3.0-or-later
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
  status: "running" | "completed" | "error"
  parts: SubagentStreamPart[]
}

const store = new Map<string, SubagentStreamData>()
const listeners = new Set<() => void>()
let tabSwitchHandler: ((toolId?: string) => void) | null = null
let version = 0

function notify() {
  version++
  listeners.forEach((fn) => fn())
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
      store.set(toolId, {
        ...existing,
        agentType: data.agentType || existing.agentType,
        description: data.description || existing.description,
        status: data.status,
      })
    } else {
      store.set(toolId, { ...data, parts: [] })
    }
    notify()
  },

  setParts(toolId: string, parts: SubagentStreamPart[]) {
    const entry = store.get(toolId)
    if (!entry) return
    if (entry.parts.length === parts.length) return
    store.set(toolId, { ...entry, parts })
    notify()
  },

  appendPart(toolId: string, part: SubagentStreamPart) {
    const entry = store.get(toolId)
    if (!entry) return
    store.set(toolId, { ...entry, parts: [...entry.parts, part] })
    notify()
  },

  updateStatus(toolId: string, status: SubagentStreamData["status"]) {
    const entry = store.get(toolId)
    if (!entry) return
    store.set(toolId, { ...entry, status })
    notify()
  },

  setInstanceId(toolId: string, instanceId: string) {
    const entry = store.get(toolId)
    if (!entry || entry.instanceId === instanceId) return
    logScreencast(
      `[screencast] subagentStreamStore.setInstanceId toolId=${toolId} ` +
      `instanceId=${instanceId}`,
    )
    store.set(toolId, { ...entry, instanceId })
    notify()
  },

  clear() {
    store.clear()
    notify()
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  onRequestTabSwitch(handler: ((toolId?: string) => void) | null) {
    tabSwitchHandler = handler
  },

  requestTabSwitch(toolId?: string) {
    tabSwitchHandler?.(toolId)
  },
}
