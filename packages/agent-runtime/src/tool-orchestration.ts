// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Orchestration — Parallel Batching with Write Serialization
 *
 * Pi Agent Core's "parallel" mode runs all tool calls concurrently. This is
 * fast for reads but dangerous for writes — two concurrent edit_file calls
 * on the same file will race. Claude Code solves this with partitionToolCalls
 * that groups consecutive concurrency-safe tools into batches.
 *
 * Our approach wraps each tool's execute() function:
 * - Read-only tools acquire a shared concurrency semaphore (max N)
 * - Write/mutating tools additionally acquire an exclusive write lock
 *   so they execute one at a time, preventing file corruption
 *
 * The wrapping is transparent to Pi Agent Core — it still sees the same
 * AgentTool interface and runs them with Promise.all in parallel mode.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'

// ============================================================================
// Concurrency-safe tool registry
// ============================================================================

/**
 * Tools that only read state and can safely run in parallel with anything.
 * Everything NOT in this set is treated as a write/mutating tool.
 */
export const CONCURRENT_SAFE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'ls',
  'list_files',
  'search',
  'impact_radius',
  'detect_changes',
  'review_context',
  'memory_read',
  'memory_search',
  'read_lints',
  'mcp_search',
  'tool_search',
  'web_search',
  'notify_user_error',
  'task',
  'task_status',
  'agent_spawn',
  'agent_status',
  'agent_result',
  'agent_list',
  'agent_cancel',
])

export function isConcurrencySafe(toolName: string): boolean {
  return CONCURRENT_SAFE_TOOLS.has(toolName)
}

// ============================================================================
// Async primitives
// ============================================================================

/**
 * Counting semaphore — limits the number of concurrent tasks.
 */
export class Semaphore {
  private count: number
  private readonly max: number
  private waiters: Array<() => void> = []

  constructor(max: number) {
    this.max = max
    this.count = max
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.count = Math.min(this.count + 1, this.max)
    }
  }

  get available(): number {
    return this.count
  }

  get waiting(): number {
    return this.waiters.length
  }
}

/**
 * Exclusive async mutex — only one holder at a time.
 * Write tools acquire this before executing, ensuring edits don't race.
 */
export class WriteMutex {
  private locked = false
  private waiters: Array<() => void> = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  get isLocked(): boolean {
    return this.locked
  }

  get queueLength(): number {
    return this.waiters.length
  }
}

// ============================================================================
// Tool call partitioning (for analysis / external orchestration)
// ============================================================================

export interface ToolBatch {
  concurrent: boolean
  calls: Array<{ name: string; id: string; input: any }>
}

/**
 * Partition an array of tool calls into sequential batches.
 * Consecutive concurrency-safe calls form a single concurrent batch.
 * Non-safe calls each form their own serial batch.
 *
 * Example: [read, read, edit, read, write] =>
 *   [{ concurrent: true, [read, read] }, { concurrent: false, [edit] },
 *    { concurrent: true, [read] },      { concurrent: false, [write] }]
 */
export function partitionToolCalls(
  calls: Array<{ name: string; id: string; input: any }>,
): ToolBatch[] {
  if (calls.length === 0) return []

  const batches: ToolBatch[] = []
  let currentBatch: ToolBatch | null = null

  for (const call of calls) {
    const safe = isConcurrencySafe(call.name)

    if (safe) {
      if (currentBatch?.concurrent) {
        currentBatch.calls.push(call)
      } else {
        currentBatch = { concurrent: true, calls: [call] }
        batches.push(currentBatch)
      }
    } else {
      currentBatch = { concurrent: false, calls: [call] }
      batches.push(currentBatch)
    }
  }

  return batches
}

// ============================================================================
// Tool wrapping
// ============================================================================

const DEFAULT_MAX_TOOL_CONCURRENCY = 10

export interface OrchestrationOptions {
  maxConcurrency?: number
}

export interface OrchestrationState {
  semaphore: Semaphore
  writeMutex: WriteMutex
}

/**
 * Wrap a single tool with orchestration (semaphore + optional write mutex).
 */
function wrapSingleTool(
  tool: AgentTool,
  semaphore: Semaphore,
  writeMutex: WriteMutex,
): AgentTool {
  const safe = isConcurrencySafe(tool.name)

  if (safe) {
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: any,
      ): Promise<AgentToolResult<any>> => {
        await semaphore.acquire()
        try {
          return await tool.execute(toolCallId, params, signal, onUpdate)
        } finally {
          semaphore.release()
        }
      },
    }
  }

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: any,
    ): Promise<AgentToolResult<any>> => {
      await semaphore.acquire()
      await writeMutex.acquire()
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate)
      } finally {
        writeMutex.release()
        semaphore.release()
      }
    },
  }
}

/**
 * Wrap an array of AgentTools with orchestration logic.
 *
 * - All tools are gated by a concurrency semaphore (default 10)
 * - Write/mutating tools additionally acquire an exclusive write mutex
 *   so they execute serially even when Pi runs them in parallel mode
 *
 * IMPORTANT: The input `tools` may be a Proxy that dynamically merges
 * live MCP tools on access (e.g. after mcp_install). We must NOT
 * materialize it into a plain array (via .map/.slice/spread) because
 * that would snapshot the tools at creation time and miss any servers
 * added mid-turn. Instead we return a Proxy that wraps tools lazily.
 *
 * Returns both the wrapped tools and the orchestration state (for testing/metrics).
 */
export function wrapToolsWithOrchestration(
  tools: AgentTool[],
  options: OrchestrationOptions = {},
): { tools: AgentTool[]; state: OrchestrationState } {
  const envConcurrency = parseInt(process.env.MAX_TOOL_CONCURRENCY || '', 10)
  const maxConcurrency = options.maxConcurrency
    ?? (Number.isNaN(envConcurrency) ? DEFAULT_MAX_TOOL_CONCURRENCY : envConcurrency)

  const semaphore = new Semaphore(maxConcurrency)
  const writeMutex = new WriteMutex()
  const state: OrchestrationState = { semaphore, writeMutex }

  const wrappedCache = new Map<string, AgentTool>()

  function getOrWrap(tool: AgentTool): AgentTool {
    let w = wrappedCache.get(tool.name)
    if (w) return w
    w = wrapSingleTool(tool, semaphore, writeMutex)
    wrappedCache.set(tool.name, w)
    return w
  }

  const PROXIED_PROPS = new Set<string | symbol>([
    'find', 'filter', 'map', 'forEach', 'some', 'every',
    'slice', 'concat', 'includes', 'reduce', 'flatMap',
    'indexOf', 'findIndex',
  ])

  const proxy = new Proxy(tools, {
    get(target, prop, receiver) {
      if (prop === 'length') {
        return Array.from(target).length
      }
      if (prop === Symbol.iterator) {
        const wrapped = Array.from(target).map(getOrWrap)
        return wrapped[Symbol.iterator].bind(wrapped)
      }
      if (typeof prop === 'string' && PROXIED_PROPS.has(prop)) {
        const wrapped = Array.from(target).map(getOrWrap)
        return (wrapped as any)[prop].bind(wrapped)
      }
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const current = Array.from(target)
        const idx = parseInt(prop, 10)
        return idx < current.length ? getOrWrap(current[idx]) : undefined
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as AgentTool[]

  return { tools: proxy, state }
}
