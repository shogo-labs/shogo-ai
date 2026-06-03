// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DebugSession — high-level wrapper around a CDP connection.
 *
 * Owns the state of one attached `node --inspect` target. Translates
 * raw CDP traffic into the events the renderer cares about:
 *
 *   • console.log / console.warn / console.error  (Runtime.consoleAPICalled)
 *   • runtime exceptions                          (Runtime.exceptionThrown)
 *   • breakpoint hits / pause                     (Debugger.paused → snapshot scopes)
 *   • resume                                      (Debugger.resumed)
 *   • detach                                      (socket closed)
 *
 * Exposes high-level commands the UI binds to:
 *
 *   • setBreakpoint(url, line, column?, condition?)
 *   • removeBreakpoint(id)
 *   • resume() / pause()
 *   • stepOver() / stepInto() / stepOut()
 *   • evaluate(expression)   — uses paused frame's callFrameId when paused,
 *                              otherwise falls back to top-level Runtime.evaluate
 *
 * State machine
 * ─────────────
 *      [created] ──attach()──► [attaching] ──ok──► [running] ◄──resume() ──┐
 *           │                                          │                   │
 *           │                                          ▼                   │
 *           │                                       [paused] ──────────────┘
 *           ▼
 *      [closed]
 *
 * `detach()` is terminal — re-attaching means constructing a new session.
 */

import type { CdpClient, CdpEvent } from './cdp-client'
import type { DebugSessionEmitter } from './session-emitter'

export type DebugSessionState =
  | 'created'
  | 'attaching'
  | 'running'
  | 'paused'
  | 'closed'

export interface Breakpoint {
  /** CDP-assigned id, returned by `Debugger.setBreakpointByUrl`. */
  id: string
  /** Source URL the breakpoint is bound to. */
  url: string
  /** Zero-based line number (CDP convention). */
  lineNumber: number
  /** Optional column. */
  columnNumber?: number
  /** Optional conditional expression. */
  condition?: string
  /** Locations CDP confirmed it could bind the bp to. */
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }>
}

export interface CallFrame {
  callFrameId: string
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
  scopeChain: Array<{ type: string; name?: string }>
}

export interface PausedEvent {
  reason: string
  hitBreakpoints: string[]
  callFrames: CallFrame[]
}

export interface DebugSessionEvents {
  onState?(state: DebugSessionState): void
  onPaused?(ev: PausedEvent): void
  onResumed?(): void
  onConsoleApi?(ev: { level: 'log' | 'warn' | 'error' | 'info' | 'debug'; text: string; data?: unknown; source?: string }): void
  onException?(ev: { text: string; data?: unknown }): void
  onDetached?(reason: string): void
}

export interface DebugSessionOptions {
  cdp: CdpClient
  /** Optional emitter to mirror events into. */
  emitter?: DebugSessionEmitter
  /** Optional listener bag. */
  on?: DebugSessionEvents
  /** Label used by emitter chrome ("Attached to <label>"). */
  label?: string
}

/**
 * Pretty-print a CDP RemoteObject for console / repl rendering.  Pure helper —
 * exported for tests.  Mirrors Chrome DevTools' compact `Array(3)`, `{a: …, b: …}` style.
 */
export function formatRemoteObject(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj)
  if (typeof obj !== 'object') return String(obj)
  const o = obj as Record<string, unknown>
  if (typeof o.unserializableValue === 'string') return o.unserializableValue
  if (o.type === 'string') return JSON.stringify(o.value)
  if (o.type === 'undefined') return 'undefined'
  if (o.type === 'number' || o.type === 'boolean' || o.type === 'bigint') return String(o.value)
  if (o.type === 'symbol') return typeof o.description === 'string' ? o.description : 'Symbol()'
  if (o.type === 'function') {
    return typeof o.description === 'string' ? o.description.split('\n')[0]! : 'function'
  }
  if (o.subtype === 'null') return 'null'
  if (o.subtype === 'array') {
    if (typeof o.description === 'string') return o.description
    return 'Array'
  }
  if (o.type === 'object') {
    return typeof o.description === 'string' ? o.description : 'Object'
  }
  return JSON.stringify(o)
}

interface CdpDebuggerPausedParams {
  reason: string
  hitBreakpoints?: string[]
  callFrames?: Array<{
    callFrameId: string
    functionName: string
    location: { scriptId: string; lineNumber: number; columnNumber?: number }
    url?: string
    scopeChain?: Array<{ type: string; name?: string }>
  }>
}

interface CdpRuntimeConsoleApiParams {
  type: string
  args?: Array<{
    type: string
    subtype?: string
    value?: unknown
    description?: string
    unserializableValue?: string
  }>
  stackTrace?: { callFrames?: Array<{ url: string; lineNumber: number }> }
}

interface CdpRuntimeExceptionParams {
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
    url?: string
    lineNumber?: number
  }
}

interface CdpSetBreakpointResult {
  breakpointId: string
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber?: number }>
}

interface CdpEvaluateResult {
  result?: { type: string; value?: unknown; description?: string; unserializableValue?: string; subtype?: string }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

export class DebugSession {
  private readonly cdp: CdpClient
  private readonly emitter: DebugSessionEmitter | null
  private readonly handlers: DebugSessionEvents
  private readonly label: string
  private readonly unsubscribers: Array<() => void> = []
  private readonly breakpoints = new Map<string, Breakpoint>()
  private _state: DebugSessionState = 'created'
  private currentPausedTopFrameId: string | null = null

  constructor(opts: DebugSessionOptions) {
    this.cdp = opts.cdp
    this.emitter = opts.emitter ?? null
    this.handlers = opts.on ?? {}
    this.label = opts.label ?? 'debug session'
  }

  get state(): DebugSessionState { return this._state }
  get listBreakpoints(): readonly Breakpoint[] { return [...this.breakpoints.values()] }

  /**
   * Open the CDP socket (if not already), enable Runtime + Debugger, wire
   * event listeners. After this resolves, the session is in `running` (or
   * `paused` if v8 was launched with `--inspect-brk`).
   */
  async attach(): Promise<void> {
    if (this._state !== 'created') {
      throw new Error(`attach() called in state ${this._state}`)
    }
    this.setState('attaching')

    try {
      await this.cdp.whenOpen()
    } catch (e) {
      this.setState('closed')
      throw e
    }

    // Wire events BEFORE enable so we never miss the first `Debugger.paused`
    // that comes in when launched with `--inspect-brk`.
    this.wireEvents()

    try {
      await this.cdp.send('Runtime.enable')
      await this.cdp.send('Debugger.enable')
      // Pretty-printing of `RemoteObject` previews — without this, large
      // objects come back as just `{}`. We enable lazily on demand instead
      // (cheaper) but expose the option here.
    } catch (e) {
      this.setState('closed')
      throw e
    }

    this.setState('running')
    this.emitter?.markAttached(this.label)
  }

  /** Detach + close the socket. Idempotent. */
  async detach(reason = 'user'): Promise<void> {
    if (this._state === 'closed') return
    for (const off of this.unsubscribers) {
      try { off() } catch { /* swallow */ }
    }
    this.unsubscribers.length = 0
    try { this.cdp.close(1000, reason) } catch { /* swallow */ }
    this.setState('closed')
    this.handlers.onDetached?.(reason)
    this.emitter?.markDetached(reason)
  }

  /** Set a breakpoint by source URL + line number (zero-based). */
  async setBreakpoint(args: {
    url: string
    lineNumber: number
    columnNumber?: number
    condition?: string
  }): Promise<Breakpoint> {
    this.ensureLive()
    const res = await this.cdp.send<CdpSetBreakpointResult>('Debugger.setBreakpointByUrl', {
      url: args.url,
      lineNumber: args.lineNumber,
      columnNumber: args.columnNumber,
      condition: args.condition,
    })
    const bp: Breakpoint = {
      id: res.breakpointId,
      url: args.url,
      lineNumber: args.lineNumber,
      columnNumber: args.columnNumber,
      condition: args.condition,
      locations: res.locations ?? [],
    }
    this.breakpoints.set(bp.id, bp)
    return bp
  }

  async removeBreakpoint(id: string): Promise<void> {
    this.ensureLive()
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: id })
    this.breakpoints.delete(id)
  }

  async resume(): Promise<void> { this.ensureLive(); await this.cdp.send('Debugger.resume') }
  async pause(): Promise<void> { this.ensureLive(); await this.cdp.send('Debugger.pause') }
  async stepOver(): Promise<void> { this.ensureLive(); await this.cdp.send('Debugger.stepOver') }
  async stepInto(): Promise<void> { this.ensureLive(); await this.cdp.send('Debugger.stepInto') }
  async stepOut(): Promise<void> { this.ensureLive(); await this.cdp.send('Debugger.stepOut') }

  /**
   * Evaluate an expression. If paused, evaluates in the top call frame so the
   * REPL sees locals; otherwise evaluates at the global scope.
   */
  async evaluate(expression: string): Promise<{ ok: boolean; text: string; data?: unknown }> {
    this.ensureLive()
    if (this.currentPausedTopFrameId) {
      const r = await this.cdp.send<CdpEvaluateResult>('Debugger.evaluateOnCallFrame', {
        callFrameId: this.currentPausedTopFrameId,
        expression,
        returnByValue: false,
        generatePreview: true,
      })
      return interpretEvaluate(r)
    }
    const r = await this.cdp.send<CdpEvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: false,
      generatePreview: true,
    })
    return interpretEvaluate(r)
  }

  // ─── internals ───────────────────────────────────────────────────

  private setState(s: DebugSessionState): void {
    if (this._state === s) return
    this._state = s
    this.handlers.onState?.(s)
  }

  private ensureLive(): void {
    if (this._state === 'closed') throw new Error('debug session is closed')
    if (this._state === 'created') throw new Error('attach() was not called')
  }

  private wireEvents(): void {
    this.unsubscribers.push(
      this.cdp.on<CdpDebuggerPausedParams>('Debugger.paused', (ev) => this.onPaused(ev)),
      this.cdp.on('Debugger.resumed', () => this.onResumed()),
      this.cdp.on<CdpRuntimeConsoleApiParams>('Runtime.consoleAPICalled', (ev) => this.onConsoleApi(ev)),
      this.cdp.on<CdpRuntimeExceptionParams>('Runtime.exceptionThrown', (ev) => this.onException(ev)),
    )

    // If the socket closes unexpectedly, transition to closed and emit detach.
    const unsubClose = this.cdp.onClose(() => {
      if (this._state !== 'closed') {
        this.setState('closed')
        this.handlers.onDetached?.('socket closed')
        this.emitter?.markDetached('socket closed')
      }
    })
    this.unsubscribers.push(unsubClose)
  }

  private onPaused(ev: CdpEvent<CdpDebuggerPausedParams>): void {
    const frames: CallFrame[] = (ev.params.callFrames ?? []).map((f) => ({
      callFrameId: f.callFrameId,
      functionName: f.functionName || '(anonymous)',
      url: f.url ?? '',
      lineNumber: f.location?.lineNumber ?? 0,
      columnNumber: f.location?.columnNumber ?? 0,
      scopeChain: (f.scopeChain ?? []).map((s) => ({ type: s.type, name: s.name })),
    }))
    this.currentPausedTopFrameId = frames[0]?.callFrameId ?? null
    this.setState('paused')
    const payload: PausedEvent = {
      reason: ev.params.reason,
      hitBreakpoints: ev.params.hitBreakpoints ?? [],
      callFrames: frames,
    }
    this.handlers.onPaused?.(payload)
    if (this.emitter) {
      const top = frames[0]
      const where = top ? `${top.functionName} ${top.url}:${top.lineNumber + 1}` : '(unknown frame)'
      this.emitter.emit({ kind: 'breakpoint', text: `Paused (${ev.params.reason}) at ${where}` })
    }
  }

  private onResumed(): void {
    this.currentPausedTopFrameId = null
    this.setState('running')
    this.handlers.onResumed?.()
  }

  private onConsoleApi(ev: CdpEvent<CdpRuntimeConsoleApiParams>): void {
    const level = mapConsoleLevel(ev.params.type)
    const text = (ev.params.args ?? []).map(formatRemoteObject).join(' ')
    const top = ev.params.stackTrace?.callFrames?.[0]
    const source = top ? `${top.url}:${top.lineNumber + 1}` : undefined
    const data = (ev.params.args ?? []).length === 1 ? ev.params.args![0] : ev.params.args
    this.handlers.onConsoleApi?.({ level, text, data, source })
    if (this.emitter) {
      switch (level) {
        case 'error':
          this.emitter.emit({ kind: 'console.error', text, data, source })
          break
        case 'warn':
          this.emitter.emit({ kind: 'console.warn', text, data, source })
          break
        default:
          this.emitter.consoleLog(text, data, source)
      }
    }
  }

  private onException(ev: CdpEvent<CdpRuntimeExceptionParams>): void {
    const details = ev.params.exceptionDetails
    const text =
      details?.exception?.description ??
      details?.text ??
      'Exception thrown'
    this.handlers.onException?.({ text, data: details })
    this.emitter?.emit({ kind: 'console.error', text, data: details })
  }
}

function mapConsoleLevel(type: string): 'log' | 'warn' | 'error' | 'info' | 'debug' {
  switch (type) {
    case 'error': return 'error'
    case 'warning': return 'warn'
    case 'info': return 'info'
    case 'debug': return 'debug'
    default: return 'log'
  }
}

function interpretEvaluate(r: CdpEvaluateResult): { ok: boolean; text: string; data?: unknown } {
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation error'
    return { ok: false, text, data: r.exceptionDetails }
  }
  if (!r.result) return { ok: true, text: 'undefined' }
  return { ok: true, text: formatRemoteObject(r.result), data: r.result }
}
