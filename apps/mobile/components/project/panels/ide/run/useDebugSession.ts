// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useDebugSession — renderer-side state machine for a Chrome DevTools
 * Protocol debug session.
 *
 * Flow (driven by RunDebugPanel):
 *
 *   1. Caller `start(script)` triggers `run.start(..., { debug: true })`.
 *   2. We subscribe to `run.onInspector(runId, ...)` and wait for v8's
 *      ws URL.
 *   3. Once we have a wsUrl, call `debug.start(wsUrl)` → sessionId.
 *   4. Subscribe to `debug.onEvent(sessionId, ...)` and translate each
 *      event into state we expose to React (state, paused, output, …).
 *   5. UI binds buttons to `resume / stepOver / stepInto / stepOut / evaluate`.
 *
 * Exported helpers are intentionally narrow and side-effect-isolated so
 * the hook can be unit-tested by handing it a fake bridge.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'

type Pm = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface DebugBridge {
  start(wsUrl: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>
  setBreakpoint(
    sessionId: string,
    args: { url: string; lineNumber: number; columnNumber?: number; condition?: string },
  ): Promise<{ ok: boolean; bp?: { id: string; url: string; lineNumber: number }; error?: string }>
  removeBreakpoint(sessionId: string, id: string): Promise<{ ok: boolean; error?: string }>
  resume(sessionId: string): Promise<{ ok: boolean; error?: string }>
  pause(sessionId: string): Promise<{ ok: boolean; error?: string }>
  stepOver(sessionId: string): Promise<{ ok: boolean; error?: string }>
  stepInto(sessionId: string): Promise<{ ok: boolean; error?: string }>
  stepOut(sessionId: string): Promise<{ ok: boolean; error?: string }>
  evaluate(
    sessionId: string,
    expression: string,
  ): Promise<{ ok: boolean; result?: { ok: boolean; text: string; data?: unknown }; error?: string }>
  detach(sessionId: string): Promise<{ ok: boolean }>
  onEvent(sessionId: string, cb: (ev: { type: string; payload: unknown }) => void): () => void
}

export interface RunBridgeForDebug {
  start(
    root: string,
    script: string,
    pm?: Pm,
    options?: { debug?: boolean },
  ): Promise<{ ok: boolean; runId?: string; inspectorWsUrl?: string; error?: string }>
  stop(runId: string): Promise<{ ok: boolean; error?: string }>
  onOutput(runId: string, cb: (d: { stream: 'stdout' | 'stderr'; data: string }) => void): () => void
  onExit(runId: string, cb: (info: { code: number | null; signal: string | null }) => void): () => void
  onInspector(runId: string, cb: (info: { runId: string; wsUrl: string }) => void): () => void
}

interface BridgePair { run: RunBridgeForDebug; debug: DebugBridge }

export function getDebugBridges(): BridgePair | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  const run = w?.shogoDesktop?.run as RunBridgeForDebug | undefined
  const debug = w?.shogoDesktop?.debug as DebugBridge | undefined
  if (!run || !debug) return null
  if (typeof run.onInspector !== 'function') return null
  return { run, debug }
}

export type DebugUiState =
  | 'idle'           // nothing running
  | 'starting'       // run.start pending
  | 'awaiting-ws'    // child spawned, waiting for "Debugger listening on …"
  | 'attaching'      // CDP socket connecting
  | 'running'        // attached, target executing
  | 'paused'         // hit a breakpoint or step landed
  | 'detached'       // session closed
  | 'failed'         // start error

export interface CallFrame {
  callFrameId: string
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}

export interface ConsoleEvent {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug'
  text: string
  source?: string
  ts: number
}

interface State {
  state: DebugUiState
  runId: string | null
  sessionId: string | null
  wsUrl: string | null
  script: string | null
  error: string | null
  callFrames: CallFrame[]
  pausedReason: string | null
  console: ConsoleEvent[]
  breakpoints: Array<{ id: string; url: string; lineNumber: number }>
}

type Action =
  | { type: 'reset' }
  | { type: 'starting'; script: string }
  | { type: 'failed'; error: string }
  | { type: 'await-ws'; runId: string }
  | { type: 'have-ws'; wsUrl: string }
  | { type: 'session-id'; sessionId: string }
  | { type: 'attached' }
  | { type: 'paused'; reason: string; frames: CallFrame[] }
  | { type: 'resumed' }
  | { type: 'console'; ev: ConsoleEvent }
  | { type: 'detached'; reason: string }
  | { type: 'add-bp'; bp: { id: string; url: string; lineNumber: number } }
  | { type: 'remove-bp'; id: string }
  | { type: 'clear-console' }

const initialState: State = {
  state: 'idle',
  runId: null,
  sessionId: null,
  wsUrl: null,
  script: null,
  error: null,
  callFrames: [],
  pausedReason: null,
  console: [],
  breakpoints: [],
}

const MAX_CONSOLE_LINES = 1000

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'reset':       return { ...initialState }
    case 'starting':    return { ...initialState, state: 'starting', script: a.script }
    case 'failed':      return { ...s, state: 'failed', error: a.error }
    case 'await-ws':    return { ...s, state: 'awaiting-ws', runId: a.runId }
    case 'have-ws':     return { ...s, state: 'attaching', wsUrl: a.wsUrl }
    case 'session-id':  return { ...s, sessionId: a.sessionId }
    case 'attached':    return { ...s, state: 'running' }
    case 'paused':      return { ...s, state: 'paused', pausedReason: a.reason, callFrames: a.frames }
    case 'resumed':     return { ...s, state: 'running', pausedReason: null, callFrames: [] }
    case 'console': {
      const next = s.console.length >= MAX_CONSOLE_LINES
        ? s.console.slice(s.console.length - MAX_CONSOLE_LINES + 1)
        : s.console
      return { ...s, console: [...next, a.ev] }
    }
    case 'detached':    return { ...s, state: 'detached', error: a.reason }
    case 'add-bp':      return { ...s, breakpoints: [...s.breakpoints, a.bp] }
    case 'remove-bp':   return { ...s, breakpoints: s.breakpoints.filter((b) => b.id !== a.id) }
    case 'clear-console': return { ...s, console: [] }
    default:            return s
  }
}

export interface UseDebugSessionApi {
  state: State
  start(scriptName: string, pm?: Pm): Promise<void>
  stop(): Promise<void>
  resume(): Promise<void>
  pause(): Promise<void>
  stepOver(): Promise<void>
  stepInto(): Promise<void>
  stepOut(): Promise<void>
  evaluate(expression: string): Promise<{ ok: boolean; text: string }>
  addBreakpoint(args: { url: string; lineNumber: number; condition?: string }): Promise<void>
  removeBreakpoint(id: string): Promise<void>
  clearConsole(): void
}

/**
 * Hook. Pass `bridges` explicitly for tests; otherwise it picks them up from
 * `window.shogoDesktop`.
 */
export function useDebugSession(workspaceRoot: string, bridgesOverride?: BridgePair): UseDebugSessionApi {
  const [state, dispatch] = useReducer(reducer, initialState)
  const bridges = bridgesOverride ?? getDebugBridges()
  const unsubsRef = useRef<Array<() => void>>([])
  const sessionIdRef = useRef<string | null>(null)

  // Sync ref with reducer.sessionId so async callbacks see the latest id.
  useEffect(() => { sessionIdRef.current = state.sessionId }, [state.sessionId])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      for (const u of unsubsRef.current) u()
      unsubsRef.current = []
    }
  }, [])

  const start = useCallback(async (scriptName: string, pm?: Pm) => {
    if (!bridges) { dispatch({ type: 'failed', error: 'Debugger requires the Shogo desktop app' }); return }
    // Tear down anything that's still hanging around.
    for (const u of unsubsRef.current) u()
    unsubsRef.current = []
    if (sessionIdRef.current) {
      await bridges.debug.detach(sessionIdRef.current).catch(() => undefined)
      sessionIdRef.current = null
    }

    dispatch({ type: 'starting', script: scriptName })

    const startRes = await bridges.run.start(workspaceRoot, scriptName, pm, { debug: true })
    if (!startRes.ok || !startRes.runId) {
      dispatch({ type: 'failed', error: startRes.error ?? 'run.start failed' })
      return
    }
    const runId = startRes.runId
    dispatch({ type: 'await-ws', runId })

    // Race: inspector URL might already be in startRes (rare), or arrive via event.
    let wsUrl: string | null = startRes.inspectorWsUrl ?? null

    // Always subscribe — even if startRes carried the URL, exit/output still useful.
    unsubsRef.current.push(
      bridges.run.onOutput(runId, () => undefined /* handled via debug.onEvent */),
      bridges.run.onExit(runId, (info) => {
        dispatch({ type: 'detached', reason: info.code === 0 ? 'process exited' : `process exited (${info.code ?? info.signal})` })
      }),
    )

    // attachToWsUrl is invoked once we have a ws URL — either eagerly
    // (when run.start carried one) or reactively when run.onInspector fires.
    const attachToWsUrl = async (wsUrl: string): Promise<void> => {
      dispatch({ type: 'have-ws', wsUrl })
      const dbg = await bridges.debug.start(wsUrl)
      if (!dbg.ok || !dbg.sessionId) {
        dispatch({ type: 'failed', error: dbg.error ?? 'debug.start failed' })
        return
      }
      const sessionId = dbg.sessionId
      sessionIdRef.current = sessionId
      dispatch({ type: 'session-id', sessionId })
      dispatch({ type: 'attached' })
      const off = bridges.debug.onEvent(sessionId, (ev) => {
        switch (ev.type) {
          case 'state': break
          case 'paused': {
            const p = ev.payload as { reason: string; callFrames: CallFrame[] }
            dispatch({ type: 'paused', reason: p.reason, frames: p.callFrames ?? [] })
            break
          }
          case 'resumed': dispatch({ type: 'resumed' }); break
          case 'console': {
            const p = ev.payload as { level: ConsoleEvent['level']; text: string; source?: string }
            dispatch({ type: 'console', ev: { ...p, ts: Date.now() } })
            break
          }
          case 'exception': {
            const p = ev.payload as { text: string }
            dispatch({ type: 'console', ev: { level: 'error', text: p.text, ts: Date.now() } })
            break
          }
          case 'detached': {
            const p = ev.payload as { reason: string }
            dispatch({ type: 'detached', reason: p.reason })
            break
          }
        }
      })
      unsubsRef.current.push(off)
    }

    if (wsUrl) {
      await attachToWsUrl(wsUrl)
    } else {
      // Reactive path — register the inspector listener and let it drive the
      // rest of the flow when v8 prints "Debugger listening on …".
      const offInspector = bridges.run.onInspector(runId, (ev) => {
        offInspector()
        void attachToWsUrl(ev.wsUrl)
      })
      unsubsRef.current.push(offInspector)
    }
  }, [bridges, workspaceRoot])

  const stop = useCallback(async () => {
    if (!bridges) return
    const sid = sessionIdRef.current
    if (sid) { await bridges.debug.detach(sid).catch(() => undefined); sessionIdRef.current = null }
    if (state.runId) { await bridges.run.stop(state.runId).catch(() => undefined) }
    dispatch({ type: 'reset' })
  }, [bridges, state.runId])

  const callSimple = useCallback(
    async (action: 'resume' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut') => {
      if (!bridges) return
      const sid = sessionIdRef.current
      if (!sid) return
      await bridges.debug[action](sid).catch(() => undefined)
    },
    [bridges],
  )

  const evaluate = useCallback(async (expression: string): Promise<{ ok: boolean; text: string }> => {
    if (!bridges) return { ok: false, text: 'no debugger bridge' }
    const sid = sessionIdRef.current
    if (!sid) return { ok: false, text: 'no active session' }
    const r = await bridges.debug.evaluate(sid, expression)
    if (!r.ok || !r.result) return { ok: false, text: r.error ?? 'evaluation failed' }
    return { ok: r.result.ok, text: r.result.text }
  }, [bridges])

  const addBreakpoint = useCallback(async (args: { url: string; lineNumber: number; condition?: string }) => {
    if (!bridges) return
    const sid = sessionIdRef.current
    if (!sid) return
    const r = await bridges.debug.setBreakpoint(sid, args)
    if (r.ok && r.bp) {
      dispatch({ type: 'add-bp', bp: { id: r.bp.id, url: r.bp.url, lineNumber: r.bp.lineNumber } })
    }
  }, [bridges])

  const removeBreakpoint = useCallback(async (id: string) => {
    if (!bridges) return
    const sid = sessionIdRef.current
    if (!sid) return
    const r = await bridges.debug.removeBreakpoint(sid, id)
    if (r.ok) dispatch({ type: 'remove-bp', id })
  }, [bridges])

  const clearConsole = useCallback(() => dispatch({ type: 'clear-console' }), [])

  return {
    state,
    start, stop,
    resume:   () => callSimple('resume'),
    pause:    () => callSimple('pause'),
    stepOver: () => callSimple('stepOver'),
    stepInto: () => callSimple('stepInto'),
    stepOut:  () => callSimple('stepOut'),
    evaluate,
    addBreakpoint,
    removeBreakpoint,
    clearConsole,
  }
}
