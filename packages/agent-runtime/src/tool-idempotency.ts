import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { TSchema } from '@sinclair/typebox'
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
/**
 * Shogo's extension of pi-agent-core's AgentTool: every tool definition
 * carries its own idempotency classification. Putting `cls` on the type
 * as REQUIRED (not optional) means TypeScript enforces it at the
 * definition site for every current and future tool — eliminating the
 * drift hazard of a hardcoded name-to-class map (Russell review, PR #442).
 */
export interface ShogoAgentTool<TP extends TSchema = TSchema, TD = any>
  extends AgentTool<TP, TD> {
  /**
   * Idempotency classification. Tools MUST declare whether they are
   * safe to blind-replay (read-only) or have side effects that cannot
   * be re-executed without risk of double-application (mutating).
   */
  cls: ToolCallClass
}

/**
 * Conservative default for dynamic / externally-sourced tools (MCP,
 * composio, skill-server proxies) where static metadata isn't
 * available at definition time. Assume mutating so the registry's
 * safety gate is opt-out for replay rather than opt-in.
 */
export const DEFAULT_UNKNOWN_TOOL_CLASS: ToolCallClass = {
  readOnly: false,
  mutating: true,
}

/**
 * Classify a tool. Prefer the explicit `cls` field on a `ShogoAgentTool`
 * (single source of truth, type-enforced). Fall back to the conservative
 * default for tools that don't carry metadata (dynamic / external).
 *
 * Accepts either a full tool object, or `(name, explicitCls)` for the
 * legacy call pattern still used by ToolIdempotencyRegistry.start().
 *
 * The prior hardcoded name-to-class map was removed in response to
 * review feedback — metadata belongs at the definition site so
 * TypeScript enforces it on every future tool.
 */
export function classifyTool(
  toolOrName: { cls?: ToolCallClass } | string,
  explicit?: Partial<ToolCallClass>,
): ToolCallClass {
  if (explicit) {
    return {
      readOnly: explicit.readOnly ?? !(explicit.mutating ?? true),
      mutating: explicit.mutating ?? !(explicit.readOnly ?? false),
    }
  }
  if (typeof toolOrName === 'string') {
    // Legacy / dynamic call site without a tool object. New code should
    // pass the tool itself (ShogoAgentTool has a required `cls` field).
    // For MCP proxies and external tools where we only have a string
    // name, use naming conventions as a best-effort hint.
    if (toolOrName.startsWith('mcp_') && toolOrName.endsWith('_read')) {
      return { readOnly: true, mutating: false }
    }
    return { ...DEFAULT_UNKNOWN_TOOL_CLASS }
  }
  return toolOrName.cls ?? { ...DEFAULT_UNKNOWN_TOOL_CLASS }
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
