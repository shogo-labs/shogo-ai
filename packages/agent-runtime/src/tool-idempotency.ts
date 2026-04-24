// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Idempotency Registry
 *
 * Tracks the lifecycle of each tool call across agent-loop attempts so that
 * automatic continuations (see durable-turn-runner.ts) do not duplicate
 * work when a turn is re-invoked.
 *
 * Lifecycle of a single tool call, keyed by the provider-assigned
 * `toolCallId` (Anthropic `tool_use_id`):
 *
 *   planned  — the model emitted a tool_use block but the runtime has not
 *              started executing it yet (tool input still streaming).
 *   started  — onBeforeToolCall has fired but onAfterToolCall has not.
 *   completed — onAfterToolCall fired with a recorded result.
 *   failed   — onAfterToolCall fired with isError=true.
 *
 * When an attempt crashes / the provider stream terminates mid-turn, any
 * tool that reached `started` but not `completed` is in a questionable
 * state. For purely read-only tools the runner can safely re-execute; for
 * mutating tools, the caller should either:
 *   - consult a tool-specific verifier (e.g. "does this file already exist
 *     with the expected contents?"), or
 *   - surface an `ask_user` checkpoint ("I may have started <action>; should
 *     I retry, skip, or abort?").
 *
 * This module intentionally does NOT attempt to persist results to disk.
 * The durable-stream-ledger already captures the wire-level frames, and
 * pi-agent-core's session history captures the semantic tool results. This
 * registry is a lightweight in-memory index keyed by toolCallId that lets
 * the gateway reason about what has/hasn't happened during a single turn
 * run, even across auto-continuations.
 */

export type ToolCallState = 'planned' | 'started' | 'completed' | 'failed'

export interface ToolCallClass {
  /** Whether the tool is known to be purely read-only. */
  readonly readOnly: boolean
  /** Whether the tool mutates shared state (FS, external APIs, DB, etc.). */
  readonly mutating: boolean
}

export interface ToolCallRecord {
  toolCallId: string
  toolName: string
  state: ToolCallState
  args?: any
  result?: any
  isError?: boolean
  startedAt?: number
  completedAt?: number
  attempt: number
  cls: ToolCallClass
}

/**
 * Built-in classification of tool names. A tool not listed here defaults
 * to `mutating: true` (pessimistic); callers can override per-invocation.
 *
 * Keep this list in sync with gateway-tools.ts — it's fine to leave unknown
 * tools as mutating since the only cost is a conservative "ask before
 * retry" in the continuation path.
 */
const BUILTIN_TOOL_CLASSES: Record<string, ToolCallClass> = {
  // Read-only (pure queries / safe to replay)
  read_file: { readOnly: true, mutating: false },
  search: { readOnly: true, mutating: false },
  glob: { readOnly: true, mutating: false },
  grep: { readOnly: true, mutating: false },
  list_dir: { readOnly: true, mutating: false },
  read_lints: { readOnly: true, mutating: false },
  web: { readOnly: true, mutating: false },
  memory_read: { readOnly: true, mutating: false },
  memory_search: { readOnly: true, mutating: false },
  read_guide: { readOnly: true, mutating: false },
  impact_radius: { readOnly: true, mutating: false },
  agent_list: { readOnly: true, mutating: false },
  agent_status: { readOnly: true, mutating: false },
  task_get: { readOnly: true, mutating: false },
  task_list: { readOnly: true, mutating: false },
  // Meta / UI-side-effect-only (safe to replay: UI reconciles by id)
  todo_write: { readOnly: true, mutating: false },
  notify_user_error: { readOnly: true, mutating: false },
  quick_action: { readOnly: true, mutating: false },
  ask_user: { readOnly: true, mutating: false },
  // Mutating (filesystem, process, external APIs, team/agent state)
  exec: { readOnly: false, mutating: true },
  write_file: { readOnly: false, mutating: true },
  edit_file: { readOnly: false, mutating: true },
  create_file: { readOnly: false, mutating: true },
  delete_file: { readOnly: false, mutating: true },
  move_file: { readOnly: false, mutating: true },
  send_message: { readOnly: false, mutating: true },
  send_team_message: { readOnly: false, mutating: true },
  channel_connect: { readOnly: false, mutating: true },
  channel_disconnect: { readOnly: false, mutating: true },
  agent_spawn: { readOnly: false, mutating: true },
  agent_cancel: { readOnly: false, mutating: true },
  agent_create: { readOnly: false, mutating: true },
  team_create: { readOnly: false, mutating: true },
  team_delete: { readOnly: false, mutating: true },
  task_create: { readOnly: false, mutating: true },
  task_update: { readOnly: false, mutating: true },
  skill: { readOnly: false, mutating: true },
  create_plan: { readOnly: false, mutating: true },
  update_plan: { readOnly: false, mutating: true },
}

function classifyTool(toolName: string, explicit?: Partial<ToolCallClass>): ToolCallClass {
  if (explicit) {
    return {
      readOnly: explicit.readOnly ?? !(explicit.mutating ?? true),
      mutating: explicit.mutating ?? !(explicit.readOnly ?? false),
    }
  }
  const builtin = BUILTIN_TOOL_CLASSES[toolName]
  if (builtin) return builtin
  // Tools beginning with these prefixes are always read-only subagents/queries
  if (toolName.startsWith('mcp_') && toolName.endsWith('_read')) {
    return { readOnly: true, mutating: false }
  }
  return { readOnly: false, mutating: true }
}

export class ToolIdempotencyRegistry {
  private readonly byId = new Map<string, ToolCallRecord>()
  private currentAttempt = 1

  beginAttempt(attempt: number): void {
    this.currentAttempt = attempt
  }

  plan(toolCallId: string, toolName: string, cls?: Partial<ToolCallClass>): ToolCallRecord {
    const existing = this.byId.get(toolCallId)
    if (existing) return existing
    const rec: ToolCallRecord = {
      toolCallId,
      toolName,
      state: 'planned',
      attempt: this.currentAttempt,
      cls: classifyTool(toolName, cls),
    }
    this.byId.set(toolCallId, rec)
    return rec
  }

  start(toolCallId: string, toolName: string, args: any, cls?: Partial<ToolCallClass>): ToolCallRecord {
    const rec = this.plan(toolCallId, toolName, cls)
    rec.state = 'started'
    rec.args = args
    rec.startedAt = Date.now()
    return rec
  }

  finish(toolCallId: string, result: any, isError: boolean): ToolCallRecord | null {
    const rec = this.byId.get(toolCallId)
    if (!rec) return null
    rec.state = isError ? 'failed' : 'completed'
    rec.result = result
    rec.isError = isError
    rec.completedAt = Date.now()
    return rec
  }

  get(toolCallId: string): ToolCallRecord | null {
    return this.byId.get(toolCallId) ?? null
  }

  isCompleted(toolCallId: string): boolean {
    return this.byId.get(toolCallId)?.state === 'completed'
  }

  /**
   * List tool calls that started in a previous attempt but never completed.
   * These are the dangerous ones: mutating, started-but-unverified work.
   */
  listStartedButUnfinished(): ToolCallRecord[] {
    return [...this.byId.values()].filter(r => r.state === 'started')
  }

  /**
   * Clear entries from the registry so a caller can reset on a new user
   * turn. The DurableTurnRunner keeps the registry across auto-continuations
   * of the same turn, but a brand-new user message should start fresh.
   */
  reset(): void {
    this.byId.clear()
    this.currentAttempt = 1
  }

  snapshot(): ToolCallRecord[] {
    return [...this.byId.values()].map(r => ({ ...r }))
  }
}
