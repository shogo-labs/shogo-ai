// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal writer / turn store for the interactive (CLI) agent.
 *
 * `AgentGateway.processChatMessageStream(text, writer, ...)` accepts any
 * `{ write(chunk) }` sink. The HTTP server passes a Server-Sent-Events
 * writer; the interactive CLI passes a `TurnStore` (this module), which
 * folds the AI SDK UI message chunks into an ordered list of renderable
 * `Entry` objects AND emits granular `StreamEvent`s.
 *
 * Two consumers read this:
 *   - The Ink UI subscribes via `subscribe()` + `getEntries()` and
 *     re-renders the live turn.
 *   - The readline renderer + headless one-shot mode consume the granular
 *     `onEvent` callback to stream tokens straight to a stream.
 *
 * Kept pure (no Ink / no process IO) so it is unit-testable in isolation.
 */

export type ToolStatus = 'running' | 'done' | 'error'

export interface TextEntry {
  kind: 'text'
  id: string
  text: string
}

export interface ReasoningEntry {
  kind: 'reasoning'
  id: string
  text: string
}

export interface ToolEntry {
  kind: 'tool'
  id: string
  toolName: string
  /** Parsed tool input once `tool-input-available` arrives. */
  input?: unknown
  /** Raw accumulated input text from `tool-input-delta` (pre-parse). */
  inputText: string
  output?: unknown
  status: ToolStatus
}

export interface ErrorEntry {
  kind: 'error'
  id: string
  text: string
}

export type Entry = TextEntry | ReasoningEntry | ToolEntry | ErrorEntry

export type StreamEvent =
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input'; toolCallId: string; input: unknown }
  | { type: 'tool-end'; toolCallId: string; status: 'done' | 'error'; output: unknown }
  | { type: 'error'; text: string }

/** Minimal shape the gateway expects from its stream `writer`. */
export interface TurnSink {
  write(chunk: Record<string, any>): void
}

export interface TurnStore extends TurnSink {
  /** Ordered renderable entries for the current turn. */
  getEntries(): readonly Entry[]
  /** Subscribe to coarse "something changed" notifications (for React). */
  subscribe(listener: () => void): () => void
  /** Concatenated assistant text (used by headless `-p` output). */
  assistantText(): string
  /** True if any `error` chunk was observed during the turn. */
  hadError(): boolean
}

export interface CreateTurnStoreOptions {
  /** Granular event callback for streaming consumers (readline / headless). */
  onEvent?: (event: StreamEvent) => void
}

/**
 * Normalize a `tool-output-available` payload into a `done`/`error` status.
 * The gateway wraps tool errors as `{ error: string }`.
 */
function statusFromOutput(output: unknown): 'done' | 'error' {
  if (output && typeof output === 'object' && 'error' in (output as Record<string, unknown>)) {
    return 'error'
  }
  return 'done'
}

export function createTurnStore(options: CreateTurnStoreOptions = {}): TurnStore {
  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let errored = false

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn()
      } catch {
        /* a subscriber throwing must not break the stream */
      }
    }
  }

  const event = (e: StreamEvent) => {
    try {
      options.onEvent?.(e)
    } catch {
      /* same — never let a consumer break the writer */
    }
  }

  const ensureText = (id: string): TextEntry => {
    const existing = byId.get(id)
    if (existing && existing.kind === 'text') return existing
    const next: TextEntry = { kind: 'text', id, text: '' }
    byId.set(id, next)
    entries.push(next)
    return next
  }

  const ensureReasoning = (id: string): ReasoningEntry => {
    const existing = byId.get(id)
    if (existing && existing.kind === 'reasoning') return existing
    const next: ReasoningEntry = { kind: 'reasoning', id, text: '' }
    byId.set(id, next)
    entries.push(next)
    return next
  }

  const ensureTool = (toolCallId: string, toolName?: string): ToolEntry => {
    const key = `tool:${toolCallId}`
    const existing = byId.get(key)
    if (existing && existing.kind === 'tool') {
      if (toolName) existing.toolName = toolName
      return existing
    }
    const next: ToolEntry = {
      kind: 'tool',
      id: toolCallId,
      toolName: toolName ?? 'tool',
      inputText: '',
      status: 'running',
    }
    byId.set(key, next)
    entries.push(next)
    return next
  }

  const write = (chunk: Record<string, any>): void => {
    const type = chunk?.type as string | undefined
    if (!type) return

    switch (type) {
      case 'text-start':
        ensureText(String(chunk.id))
        break
      case 'text-delta': {
        const delta = String(chunk.delta ?? '')
        if (!delta) break
        const entry = ensureText(String(chunk.id))
        entry.text += delta
        event({ type: 'text-delta', id: entry.id, delta })
        break
      }
      case 'text-end':
        break

      case 'reasoning-start':
        ensureReasoning(String(chunk.id))
        break
      case 'reasoning-delta': {
        const delta = String(chunk.delta ?? '')
        if (!delta) break
        const entry = ensureReasoning(String(chunk.id))
        entry.text += delta
        event({ type: 'reasoning-delta', id: entry.id, delta })
        break
      }
      case 'reasoning-end':
        break

      case 'tool-input-start': {
        const tool = ensureTool(String(chunk.toolCallId), chunk.toolName ? String(chunk.toolName) : undefined)
        event({ type: 'tool-start', toolCallId: tool.id, toolName: tool.toolName })
        break
      }
      case 'tool-input-delta': {
        const tool = ensureTool(String(chunk.toolCallId))
        tool.inputText += String(chunk.inputTextDelta ?? '')
        break
      }
      case 'tool-input-available': {
        const tool = ensureTool(String(chunk.toolCallId), chunk.toolName ? String(chunk.toolName) : undefined)
        tool.input = chunk.input
        event({ type: 'tool-input', toolCallId: tool.id, input: chunk.input })
        break
      }
      case 'tool-output-available': {
        const tool = ensureTool(String(chunk.toolCallId))
        const status = statusFromOutput(chunk.output)
        tool.output = chunk.output
        tool.status = status
        if (status === 'error') errored = true
        event({ type: 'tool-end', toolCallId: tool.id, status, output: chunk.output })
        break
      }
      case 'data-tool-error': {
        // Composio-style tool errors arrive out of band; surface them on the
        // matching tool row when we can identify it, else as a bare error.
        const data = chunk.data as { error?: string } | undefined
        const text = data?.error ? String(data.error) : 'tool error'
        errored = true
        event({ type: 'error', text })
        break
      }

      case 'error': {
        const text = String(chunk.errorText ?? chunk.error ?? 'unknown error')
        errored = true
        const entry: ErrorEntry = { kind: 'error', id: `error-${entries.length}`, text }
        entries.push(entry)
        event({ type: 'error', text })
        break
      }

      default:
        // data-routing-decision, data-context-usage, data-usage, etc. — not
        // rendered in the terminal v1. Intentionally ignored.
        return
    }

    emit()
  }

  return {
    write,
    getEntries: () => entries,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    assistantText() {
      return entries
        .filter((e): e is TextEntry => e.kind === 'text')
        .map((e) => e.text)
        .join('')
    },
    hadError: () => errored,
  }
}
