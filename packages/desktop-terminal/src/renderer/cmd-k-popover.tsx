// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ⌘K natural-language → command popover.
 *
 * Anchored at viewport bottom (Cursor pattern — simpler + steadier
 * than tracking the cursor row, which jumps on every redraw). The
 * popover takes the user's prose ("rename all .jpg to .jpeg"),
 * streams a shell command back from an `LlmClient`, and on Enter
 * sends `text + "\r"` to the PTY. Escape sends `^U` (clear line) to
 * cancel whatever the shell already has typed.
 *
 * Surface split:
 *
 *   - `CmdKController` — non-React state machine. idle → streaming →
 *     ready → submitted / cancelled. Tests drive it directly.
 *
 *   - `useCmdK(controller)` — React hook that subscribes to the
 *     controller and re-renders on state changes.
 *
 *   - `<CmdKPopover>` — the default React component (minimal markup;
 *     apps/desktop wraps with shadcn).
 *
 * LLM streaming is abstracted behind a narrow `LlmClient` interface
 * so unit tests use a deterministic fake — the real `client.llm` from
 * the Shogo SDK plugs in via the adapter in apps/desktop.
 */

import * as React from 'react'

// ─── narrow LLM interface ─────────────────────────────────────────

/**
 * Subset of a "streaming completion" provider we need. The host
 * wires a real LLM client (Vercel AI SDK, Shogo SDK gateway, etc.)
 * to this shape.
 *
 * `streamCommand` MUST resolve with a `cancel()` function — the
 * controller calls it when the user retypes mid-stream, presses
 * Escape, or unmounts the popover.
 */
export interface LlmClient {
  streamCommand(opts: LlmStreamRequest): Promise<LlmStreamHandle>
}

export interface LlmStreamRequest {
  /** User's natural-language prompt. */
  prompt: string
  /** Context appended to the system prompt: cwd, shell, OS, recent commands. */
  context: LlmStreamContext
  /** Receives partial-text deltas as they arrive. */
  onDelta(text: string): void
  /** Receives the final accumulated text, exactly once. */
  onDone(text: string): void
  /** Receives an error if the stream fails. */
  onError(error: Error): void
}

export interface LlmStreamContext {
  cwd: string | null
  shell: string | null
  os: 'mac' | 'linux' | 'win' | 'unknown'
  /** Most recent ~5 commands the user ran. Helps the model match style. */
  recentCommands: string[]
}

export interface LlmStreamHandle {
  cancel(): void
}

// ─── controller state machine ─────────────────────────────────────

export type CmdKState =
  | 'idle'         // popover closed
  | 'composing'    // popover open, no stream yet
  | 'streaming'    // stream in flight
  | 'ready'        // stream completed; user can press Enter
  | 'error'        // stream failed; user can edit + retry

export interface CmdKSnapshot {
  state: CmdKState
  /** Current NL prompt the user has typed. */
  prompt: string
  /** Accumulated streamed command suggestion. */
  suggestion: string
  /** Last error message, when state === 'error'. */
  errorMessage: string | null
}

export interface CmdKControllerOptions {
  llm: LlmClient
  /** Returns the context to ship with every request. Called per-stream. */
  contextProvider(): LlmStreamContext
  /** Called when the user presses Enter on a ready suggestion. */
  onSubmit(command: string): void
  /**
   * Debounce window before kicking off a new stream after the user
   * pauses typing. Default 250ms. Tests pass `schedule` to drive it.
   */
  debounceMs?: number
  /** Inject scheduler for tests. */
  schedule?: (cb: () => void, delayMs: number) => number
  cancel?: (handle: number) => void
}

const noopHandle: LlmStreamHandle = { cancel() {} }

export class CmdKController {
  private readonly llm: LlmClient
  private readonly contextProvider: () => LlmStreamContext
  private readonly onSubmitCb: (command: string) => void
  private readonly debounceMs: number
  private readonly schedule: (cb: () => void, delayMs: number) => number
  private readonly cancelScheduled: (handle: number) => void

  private snap: CmdKSnapshot = { state: 'idle', prompt: '', suggestion: '', errorMessage: null }
  private listeners = new Set<(s: CmdKSnapshot) => void>()
  private streamHandle: LlmStreamHandle = noopHandle
  private debounceTimer: number | null = null
  /** Monotonic stream id — used to ignore late deltas from cancelled streams. */
  private streamCounter = 0

  constructor(opts: CmdKControllerOptions) {
    this.llm = opts.llm
    this.contextProvider = opts.contextProvider
    this.onSubmitCb = opts.onSubmit
    this.debounceMs = Math.max(0, opts.debounceMs ?? 250)
    if (opts.schedule && opts.cancel) {
      this.schedule = opts.schedule
      this.cancelScheduled = opts.cancel
    } else {
      this.schedule = (cb, ms) => setTimeout(cb, ms) as unknown as number
      this.cancelScheduled = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
    }
  }

  // ─── inspectors ────────────────────────────────────────────────

  get state(): CmdKState { return this.snap.state }
  snapshot(): CmdKSnapshot { return { ...this.snap } }
  on(cb: (s: CmdKSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  // ─── intents ───────────────────────────────────────────────────

  open(): void {
    this.update({ state: 'composing', prompt: '', suggestion: '', errorMessage: null })
  }

  close(): void {
    this.cancelInflight()
    this.update({ state: 'idle', prompt: '', suggestion: '', errorMessage: null })
  }

  setPrompt(prompt: string): void {
    if (this.snap.state === 'idle') return
    this.update({ prompt })
    this.scheduleStream()
  }

  /**
   * Fire the submission callback iff we have a suggestion ready. The
   * controller returns to `idle` afterwards (popover should close).
   */
  submit(): boolean {
    if (this.snap.state !== 'ready') return false
    const cmd = this.snap.suggestion.trim()
    if (cmd.length === 0) return false
    this.cancelInflight()
    this.onSubmitCb(cmd)
    this.update({ state: 'idle', prompt: '', suggestion: '', errorMessage: null })
    return true
  }

  /** Cancel any in-flight stream + close. Same as close(). */
  cancel(): void { this.close() }

  dispose(): void {
    this.cancelInflight()
    this.listeners.clear()
  }

  // ─── stream lifecycle ─────────────────────────────────────────

  private scheduleStream(): void {
    if (this.debounceTimer !== null) {
      this.cancelScheduled(this.debounceTimer)
      this.debounceTimer = null
    }
    const prompt = this.snap.prompt.trim()
    if (prompt.length === 0) {
      this.cancelInflight()
      this.update({ state: 'composing', suggestion: '', errorMessage: null })
      return
    }
    this.debounceTimer = this.schedule(() => {
      this.debounceTimer = null
      this.fireStream(prompt)
    }, this.debounceMs)
  }

  private fireStream(prompt: string): void {
    this.cancelInflight()
    const myId = ++this.streamCounter
    this.update({ state: 'streaming', suggestion: '', errorMessage: null })

    const onDelta = (text: string): void => {
      if (myId !== this.streamCounter) return
      this.update({ suggestion: this.snap.suggestion + text })
    }
    const onDone = (final: string): void => {
      if (myId !== this.streamCounter) return
      const cleaned = (final || this.snap.suggestion).trim()
      this.update({ state: 'ready', suggestion: cleaned })
    }
    const onError = (err: Error): void => {
      if (myId !== this.streamCounter) return
      this.update({ state: 'error', errorMessage: err.message || 'stream failed' })
    }

    void this.llm.streamCommand({
      prompt,
      context: this.contextProvider(),
      onDelta, onDone, onError,
    }).then((h) => {
      // Late handle — stream may already have completed.
      if (myId === this.streamCounter) this.streamHandle = h
    }).catch((e: Error) => onError(e))
  }

  private cancelInflight(): void {
    this.streamCounter++ // invalidate any in-flight callbacks
    try { this.streamHandle.cancel() } catch { /* */ }
    this.streamHandle = noopHandle
    if (this.debounceTimer !== null) {
      this.cancelScheduled(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private update(patch: Partial<CmdKSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) { try { l(this.snap) } catch { /* */ } }
  }
}

// ─── React hook ────────────────────────────────────────────────────

export function useCmdK(controller: CmdKController): CmdKSnapshot {
  const [snap, setSnap] = React.useState<CmdKSnapshot>(controller.snapshot())
  React.useEffect(() => controller.on(setSnap), [controller])
  return snap
}

// ─── component ────────────────────────────────────────────────────

export interface CmdKPopoverProps {
  controller: CmdKController
  className?: string
  placeholder?: string
}

export function CmdKPopover(props: CmdKPopoverProps): React.ReactElement | null {
  const snap = useCmdK(props.controller)
  if (snap.state === 'idle') return null

  const handleKey = (ev: React.KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Escape') { ev.preventDefault(); props.controller.close() }
    else if (ev.key === 'Enter') {
      ev.preventDefault()
      if (snap.state === 'ready') props.controller.submit()
    }
  }

  const statusLine = snap.state === 'streaming'
    ? 'Thinking…'
    : snap.state === 'error'
      ? `Error: ${snap.errorMessage ?? ''}`
      : snap.state === 'ready' && snap.suggestion
        ? '⏎ to send · Esc to cancel'
        : 'Describe what you want to do…'

  return React.createElement(
    'div',
    {
      role: 'dialog',
      'aria-modal': 'true',
      'data-testid': 'shogo-cmdk-popover',
      'data-cmdk-state': snap.state,
      className: props.className,
      style: {
        position: 'absolute',
        left: '50%', bottom: 24,
        transform: 'translateX(-50%)',
        width: 520,
        zIndex: 30,
        background: 'rgba(20,20,24,0.96)',
        border: '1px solid #4a90e2',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        padding: '10px 12px',
        color: '#eee',
        font: '13px / 1.5 system-ui',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
    },
    React.createElement('input', {
      'data-testid': 'shogo-cmdk-input',
      autoFocus: true,
      value: snap.prompt,
      placeholder: props.placeholder ?? 'Describe what to run (⌘K)…',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.controller.setPrompt(e.target.value),
      onKeyDown: handleKey,
      style: { background: 'transparent', color: '#eee', border: 'none', outline: 'none', font: 'inherit' },
    }),
    snap.suggestion
      ? React.createElement('pre', {
          'data-testid': 'shogo-cmdk-suggestion',
          style: { margin: 0, fontFamily: 'monospace', whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.05)', padding: '4px 6px', borderRadius: 4 },
        }, snap.suggestion)
      : null,
    React.createElement('div', { style: { opacity: 0.6, fontSize: 11 }, 'data-testid': 'shogo-cmdk-status' }, statusLine),
  )
}
