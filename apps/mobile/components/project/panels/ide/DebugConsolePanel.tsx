// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Debug Console — VS Code-style scrollable log surface + REPL input.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ [console.log] [demo.js:7]  hello world                      │
 *   │ [stdout]                    server listening on :3000       │
 *   │ [result]                    ▸ { foo: 1, bar: [2,3] }        │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ > _                                                         │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Architecture:
 *   - Subscribes to the process-wide `DebugSessionEmitter` singleton
 *     (`window.shogoDebugEmitter` if the host bridge has injected one;
 *     otherwise an internal echo-only emitter so the REPL still works).
 *   - Keeps an in-memory ring buffer of the last `MAX_LINES` events.
 *   - REPL accepts a single line by default, Shift+Enter inserts a
 *     newline (renders a multi-line textarea after the first newline).
 *   - History via ↑/↓; Tab-completion is a stub for now (cycles through
 *     the last 5 expressions matching the current prefix).
 *
 * When no debug session is attached, REPL submissions print a one-line
 * 'system' event reminding the user to start one with `node --inspect`.
 * The REPL itself still echoes expressions + simple arithmetic so the
 * UX is never dead.
 */

import * as React from 'react'

// ─── shared event shape (mirrors apps/desktop/src/debug/session-emitter.ts) ──

type DebugEventKind =
  | 'stdout'
  | 'stderr'
  | 'console.log'
  | 'console.error'
  | 'console.warn'
  | 'expression'
  | 'result'
  | 'breakpoint'
  | 'system'

interface DebugEvent {
  id: number
  kind: DebugEventKind
  ts: number
  text: string
  data?: unknown
  source?: string
}

interface DebugEmitterLike {
  readonly isAttached: boolean
  on(listener: (e: DebugEvent) => void): () => void
  expression(text: string): DebugEvent
  result(text: string, data?: unknown): DebugEvent
  system(text: string): DebugEvent
}

declare global {
  interface Window {
    shogoDebugEmitter?: DebugEmitterLike
  }
}

// ─── fallback emitter (used when the host bridge isn't there) ─────────

class FallbackEmitter implements DebugEmitterLike {
  readonly isAttached = false
  private listeners = new Set<(e: DebugEvent) => void>()
  private nextId = 1
  on(l: (e: DebugEvent) => void): () => void {
    this.listeners.add(l)
    return () => { this.listeners.delete(l) }
  }
  private emit(e: Omit<DebugEvent, 'id' | 'ts'>): DebugEvent {
    const full: DebugEvent = { id: this.nextId++, ts: Date.now(), ...e }
    for (const l of [...this.listeners]) { try { l(full) } catch { /* swallow */ } }
    return full
  }
  expression(text: string): DebugEvent { return this.emit({ kind: 'expression', text }) }
  result(text: string, data?: unknown): DebugEvent { return this.emit({ kind: 'result', text, data }) }
  system(text: string): DebugEvent { return this.emit({ kind: 'system', text }) }
}

const fallbackEmitter = new FallbackEmitter()

// ─── trivial REPL eval (math-only, hermetic) ──────────────────────────

/**
 * Evaluate a one-liner the user typed into the REPL.
 *
 * We intentionally do *not* `eval()` user input — that's a sandbox-escape
 * vector and would also misrepresent the experience (no module scope, no v8
 * frame).  For the no-debug-session case we support:
 *   - simple arithmetic / parens (e.g. `2 + 2`, `(3*4)/2`)
 *   - string literals (e.g. `"hi"`)
 *   - booleans
 *
 * Anything else falls through to a 'system' message nudging the user to
 * attach a real session.
 *
 * When a real CDP wire is connected (13b), this function is bypassed and
 * the expression is sent to v8's `Runtime.evaluate`.
 */
export function evalSimpleExpression(src: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = src.trim()
  if (!trimmed) return { ok: false }

  // String literals.
  const strMatch = /^(['"])(.*)\1$/.exec(trimmed)
  if (strMatch) return { ok: true, value: strMatch[2] }

  // Booleans / null / undefined.
  if (trimmed === 'true')      return { ok: true, value: true }
  if (trimmed === 'false')     return { ok: true, value: false }
  if (trimmed === 'null')      return { ok: true, value: null }
  if (trimmed === 'undefined') return { ok: true, value: undefined }

  // Arithmetic: digits, decimals, + - * / % ( ) and whitespace only.
  if (/^[\d.+\-*/%()\s]+$/.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new-func
      const value = Function(`"use strict"; return (${trimmed});`)() as unknown
      if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
    } catch { /* fall through */ }
  }

  return { ok: false }
}

// ─── component ────────────────────────────────────────────────────────

const MAX_LINES = 2000

export interface DebugConsolePanelProps {
  visible: boolean
  /** Override the global emitter — used by tests. */
  emitter?: DebugEmitterLike
}

export function DebugConsolePanel({ visible, emitter: emitterOverride }: DebugConsolePanelProps): React.ReactElement {
  const emitter = React.useMemo<DebugEmitterLike>(() => {
    if (emitterOverride) return emitterOverride
    if (typeof window !== 'undefined' && window.shogoDebugEmitter) return window.shogoDebugEmitter
    return fallbackEmitter
  }, [emitterOverride])

  const [events, setEvents] = React.useState<DebugEvent[]>([])
  const [input, setInput] = React.useState('')
  const [history, setHistory] = React.useState<string[]>([])
  const [historyIdx, setHistoryIdx] = React.useState<number | null>(null)
  const [multiline, setMultiline] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const logRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const off = emitter.on((ev) => {
      setEvents((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev
        return [...next, ev]
      })
    })
    return off
  }, [emitter])

  // Auto-stick to bottom on new events when already near the bottom.
  React.useEffect(() => {
    const el = logRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [events])

  const submit = React.useCallback((raw: string): void => {
    const expr = raw.replace(/\n+$/, '')
    if (!expr.trim()) return
    emitter.expression(expr)
    setHistory((h) => (h[h.length - 1] === expr ? h : [...h.slice(-49), expr]))
    setHistoryIdx(null)

    if (emitter.isAttached) {
      // Real session attached — the wire-protocol client (13b) will respond
      // with a 'result' or 'console.error' event of its own. We just echo
      // the expression and wait.
      return
    }

    const ev = evalSimpleExpression(expr)
    if (ev.ok) {
      emitter.result(formatValue(ev.value), ev.value)
    } else {
      emitter.system('No debug session — start one with `node --inspect script.js`')
    }
  }, [emitter])

  const handleKey = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(input)
      setInput('')
      setMultiline(false)
      return
    }
    if (e.key === 'Enter' && e.shiftKey) {
      // Promote to multiline if not already.
      if (!multiline) {
        e.preventDefault()
        setMultiline(true)
        setInput(input + '\n')
        // Refocus on the new textarea on next tick.
        requestAnimationFrame(() => inputRef.current?.focus())
      }
      return
    }
    if (e.key === 'ArrowUp' && !multiline) {
      if (history.length === 0) return
      e.preventDefault()
      const nextIdx = historyIdx === null ? history.length - 1 : Math.max(historyIdx - 1, 0)
      setHistoryIdx(nextIdx)
      setInput(history[nextIdx]!)
      return
    }
    if (e.key === 'ArrowDown' && !multiline) {
      if (historyIdx === null) return
      e.preventDefault()
      const nextIdx = historyIdx + 1
      if (nextIdx >= history.length) {
        setHistoryIdx(null)
        setInput('')
      } else {
        setHistoryIdx(nextIdx)
        setInput(history[nextIdx]!)
      }
      return
    }
    if (e.key === 'Tab') {
      // Stub: cycle most-recent history entry that startsWith current input.
      e.preventDefault()
      const match = [...history].reverse().find((h) => h.startsWith(input) && h !== input)
      if (match) setInput(match)
    }
  }, [input, multiline, history, historyIdx, submit])

  return (
    <div
      data-testid="bottompanel-pane-debug-console"
      aria-hidden={!visible}
      className="flex h-full w-full flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]"
    >
      <div
        ref={logRef}
        className="flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-[18px]"
        role="log"
        aria-live="polite"
      >
        {events.length === 0 ? (
          <div className="text-[#858585] italic">
            No debug session active. Type an expression below, or run
            <span className="font-mono"> node --inspect script.js </span>
            in the Terminal to attach one.
          </div>
        ) : (
          events.map((ev) => <DebugLine key={ev.id} ev={ev} />)
        )}
      </div>

      <div className="flex items-start border-t border-[#3c3c3c] bg-[#1e1e1e] px-3 py-1.5">
        <span
          className="select-none pr-2 pt-[1px] font-mono text-[12px] text-[#3794ff]"
          aria-hidden="true"
        >&gt;</span>
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            rows={Math.min(8, Math.max(2, input.split('\n').length))}
            className="flex-1 resize-none bg-transparent font-mono text-[12px] text-[#cccccc] outline-none placeholder:text-[#858585]"
            placeholder="multiline · Enter to submit · Shift+Enter for newline"
            spellCheck={false}
            aria-label="Debug Console input"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            className="flex-1 bg-transparent font-mono text-[12px] text-[#cccccc] outline-none placeholder:text-[#858585]"
            placeholder={emitter.isAttached ? 'evaluate in debug session…' : 'expression…'}
            spellCheck={false}
            aria-label="Debug Console input"
            autoComplete="off"
          />
        )}
      </div>
    </div>
  )
}

// ─── subcomponents ────────────────────────────────────────────────────

function DebugLine({ ev }: { ev: DebugEvent }): React.ReactElement {
  const colors = pillColors(ev.kind)
  return (
    <div className="flex items-start gap-2 py-[1px]" data-testid={`debug-line-${ev.id}`} data-kind={ev.kind}>
      <span
        className="inline-block min-w-[88px] shrink-0 select-none rounded px-1.5 py-[1px] text-[10px] uppercase tracking-wide"
        style={{ backgroundColor: colors.bg, color: colors.fg }}
      >
        {pillLabel(ev.kind)}
      </span>
      {ev.source && <span className="select-none text-[#858585]">{ev.source}</span>}
      <span className="flex-1 whitespace-pre-wrap break-words">
        {ev.text}
        {ev.data !== undefined && typeof ev.data === 'object' && ev.data !== null && (
          <CollapsibleObject value={ev.data} />
        )}
      </span>
    </div>
  )
}

function pillLabel(kind: DebugEventKind): string {
  switch (kind) {
    case 'console.log':   return 'console.log'
    case 'console.error': return 'console.error'
    case 'console.warn':  return 'console.warn'
    case 'stdout':        return 'stdout'
    case 'stderr':        return 'stderr'
    case 'expression':    return '>'
    case 'result':        return '←'
    case 'breakpoint':    return 'breakpoint'
    case 'system':        return 'system'
  }
}

function pillColors(kind: DebugEventKind): { bg: string; fg: string } {
  switch (kind) {
    case 'console.log':   return { bg: '#264f78', fg: '#9cdcfe' }
    case 'console.error': return { bg: '#5a1d1d', fg: '#f48771' }
    case 'console.warn':  return { bg: '#5c4a18', fg: '#dcdc8e' }
    case 'stdout':        return { bg: '#2d2d2d', fg: '#cccccc' }
    case 'stderr':        return { bg: '#5a1d1d', fg: '#f48771' }
    case 'expression':    return { bg: '#0e639c', fg: '#ffffff' }
    case 'result':        return { bg: '#1e4620', fg: '#b5cea8' }
    case 'breakpoint':    return { bg: '#5c4a18', fg: '#dcdc8e' }
    case 'system':        return { bg: '#2d2d2d', fg: '#858585' }
  }
}

/** Pretty-print a value the way Chrome DevTools does — primitives inline, objects/arrays summarised. */
function formatValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `Array(${v.length})`
  if (typeof v === 'object') {
    try { return `{${Object.keys(v as object).slice(0, 3).join(', ')}}` } catch { return '{…}' }
  }
  return String(v)
}

/**
 * Lazy tree view for object/array `data` carried on a DebugEvent.
 * Collapsed by default — click the triangle to expand. Limits depth to
 * 10 levels to bound DOM size on huge graphs.
 */
function CollapsibleObject({ value, depth = 0 }: { value: unknown; depth?: number }): React.ReactElement {
  const [open, setOpen] = React.useState(depth < 1)
  if (depth > 10) return <span className="text-[#858585]">…</span>

  const isArr = Array.isArray(value)
  const isObj = !isArr && typeof value === 'object' && value !== null
  if (!isArr && !isObj) {
    return <span className="text-[#b5cea8]">{formatValue(value)}</span>
  }

  const entries: Array<[string, unknown]> = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as object)

  const summary = isArr
    ? `Array(${entries.length})`
    : `{${Object.keys(value as object).slice(0, 3).join(', ')}${Object.keys(value as object).length > 3 ? ', …' : ''}}`

  return (
    <span className="ml-1 inline-block align-top">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="select-none text-[#3794ff] hover:underline"
        aria-expanded={open}
      >
        {open ? '▾ ' : '▸ '}{summary}
      </button>
      {open && (
        <div className="ml-4 border-l border-[#3c3c3c] pl-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-1">
              <span className="text-[#9cdcfe]">{k}:</span>
              {typeof v === 'object' && v !== null
                ? <CollapsibleObject value={v} depth={depth + 1} />
                : <span className="text-[#b5cea8]">{formatValue(v)}</span>}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
