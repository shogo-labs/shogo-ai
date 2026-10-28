// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Progress event types for subagent streaming
 * Task: task-subagent-progress-streaming
 *
 * These types define the shape of progress events emitted by Claude Agent SDK
 * hooks and streamed to the client via SSE data-progress parts.
 */

export type SubagentProgressEvent =
  | {
      type: 'subagent-start'
      agentId: string
      agentType: string
      timestamp: number
    }
  | {
      type: 'subagent-stop'
      agentId: string
      timestamp: number
    }
  | {
      type: 'tool-complete'
      toolName: string
      toolUseId: string
      timestamp: number
    }

/**
 * A single background shell process tracked for a chat thread. Mirrors the
 * `RunningProcess` shape emitted by the runtime's CommandRegistry.
 */
export interface RunningProcess {
  runId: string
  command: string
  pid?: number
  sandboxed: boolean
  containerName?: string
  startedAt: number
  elapsedMs: number
  /** True if restored from a snapshot after a runtime restart (state unknown). */
  stale?: boolean
  /** Task id (same as runId). */
  id?: string
  /** shell | subagent | project_call | agent_reply | work_item */
  source?: string
  title?: string
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  /** Workspace-relative output log. */
  outputFile?: string
  /** The agent is woken when it finishes. */
  notify?: boolean
  /** Status comes from the API or another project's runtime. */
  remote?: boolean
}

/** `data-task-update` SSE part: the full running task list (replaces `data-process-update`). */
export interface TaskUpdateEvent {
  tasks: RunningProcess[]
}

/** `data-task-wait` SSE part: the agent is blocked in `wait` (active) or just stopped waiting. */
export interface TaskWaitEvent {
  toolCallId: string
  taskIds: string[]
  until?: string
  timeoutMs: number
  startedAt: number
  active: boolean
}

/**
 * Process tracking event streamed to the client as a `data-process-update`
 * SSE part. Carries the full current running list so the client can replace
 * its view wholesale (no per-event reconciliation needed).
 */
export interface ProcessUpdateEvent {
  processes: RunningProcess[]
}

/**
 * Virtual Tool event types for client-side execution
 * Task: virtual-tools-domain Phase 0 PoC
 *
 * Virtual tools are intercepted server-side via PreToolUse hook and
 * streamed to the client for execution rather than routing to MCP.
 */
export interface VirtualToolEvent {
  type: 'virtual-tool-execute'
  /** Unique ID for this tool invocation */
  toolUseId: string
  /** Virtual tool name (e.g., 'navigate_to_phase') */
  toolName: string
  /** Tool arguments from Claude's invocation */
  args: Record<string, unknown>
  /** Timestamp of invocation */
  timestamp: number
}

/**
 * Known virtual tool names for type-safe checking.
 * Add new virtual tools here as they're implemented.
 */
export const VIRTUAL_TOOL_NAMES = [
  'navigate_to_phase',
  'show_schema',
] as const

export type VirtualToolName = typeof VIRTUAL_TOOL_NAMES[number]

/**
 * Check if a tool name is a virtual tool.
 */
export function isVirtualTool(toolName: string): toolName is VirtualToolName {
  return VIRTUAL_TOOL_NAMES.includes(toolName as VirtualToolName)
}
