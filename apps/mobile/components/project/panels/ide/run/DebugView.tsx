// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * DebugView — the inspector-mode UI surface.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ● paused (breakpoint)         ⏵  ⤓  ↷  ↶   ✕                    │
 *   │ ─────────────────────────────────────────────────────────────── │
 *   │ Call Stack                                                       │
 *   │   ▸ main      file:///a.js:6                                     │
 *   │   ▸ <anon>    file:///a.js:14                                    │
 *   │ ─────────────────────────────────────────────────────────────── │
 *   │ Breakpoints                                                      │
 *   │   ✓ file:///a.js:5         [x]                                   │
 *   │ ─────────────────────────────────────────────────────────────── │
 *   │ Console                                                          │
 *   │   [log]    hello                                                 │
 *   │   [error]  TypeError: x is not a function                        │
 *   │   > _    (REPL input)                                            │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Pure presentational — owned state lives in `useDebugSession`.
 */
import * as React from 'react'
import type { UseDebugSessionApi } from './useDebugSession'

interface Props {
  api: UseDebugSessionApi
  /** Defaults to file:/// for the workspace root. */
  defaultBreakpointUrl?: string
}

export function DebugView({ api, defaultBreakpointUrl }: Props): React.ReactElement {
  const { state } = api
  const isRunning = state.state === 'running'
  const isPaused  = state.state === 'paused'
  const isLive    = isRunning || isPaused

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <DebugHeader api={api} />

      <div className="flex-shrink-0 border-b border-[color:var(--ide-border)]">
        <Section title={`Call Stack${isPaused ? ` (${state.pausedReason})` : ''}`}>
          {state.callFrames.length === 0 ? (
            <Empty hint={isPaused ? 'no frames' : isRunning ? 'running — pause to see frames' : 'not running'} />
          ) : (
            state.callFrames.map((f, i) => (
              <div key={f.callFrameId} className="flex gap-2 px-3 py-0.5">
                <span className="font-mono text-[10px] text-[color:var(--ide-muted)]">{i === 0 ? '▸' : ' '}</span>
                <span className="font-mono text-[11px] text-[color:var(--ide-text-strong)]">{f.functionName}</span>
                <span className="ml-auto truncate font-mono text-[10px] text-[color:var(--ide-muted)]" title={f.url}>
                  {shortenUrl(f.url)}:{f.lineNumber + 1}
                </span>
              </div>
            ))
          )}
        </Section>

        <Section title="Breakpoints">
          {state.breakpoints.length === 0 ? (
            <Empty hint={isLive ? 'click + to add' : 'start debugging to add'} action={
              isLive ? (
                <AddBpButton onAdd={async (url, line) => { await api.addBreakpoint({ url, lineNumber: line }) }}
                             defaultUrl={defaultBreakpointUrl} />
              ) : null
            } />
          ) : (
            <>
              {state.breakpoints.map((bp) => (
                <div key={bp.id} className="group flex items-center gap-2 px-3 py-0.5">
                  <span className="text-rose-500">●</span>
                  <span className="truncate font-mono text-[10px] text-[color:var(--ide-text-strong)]" title={bp.url}>
                    {shortenUrl(bp.url)}:{bp.lineNumber + 1}
                  </span>
                  <button
                    onClick={() => { void api.removeBreakpoint(bp.id) }}
                    className="ml-auto rounded px-1 text-[9px] text-[color:var(--ide-muted)] opacity-0 hover:bg-[color:var(--ide-panel-2)] hover:text-rose-400 group-hover:opacity-100"
                    title="Remove breakpoint"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <div className="px-3 py-1">
                <AddBpButton onAdd={async (url, line) => { await api.addBreakpoint({ url, lineNumber: line }) }}
                             defaultUrl={defaultBreakpointUrl} />
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <Section title="Debug Console" right={
          state.console.length > 0 ? (
            <button
              onClick={api.clearConsole}
              className="text-[10px] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
            >Clear</button>
          ) : null
        }>
          <ConsoleLines lines={state.console} />
        </Section>
        <Repl api={api} disabled={!isLive} />
      </div>
    </div>
  )
}

function DebugHeader({ api }: { api: UseDebugSessionApi }) {
  const { state } = api
  const indicator = stateIndicator(state.state)
  const isLive = state.state === 'running' || state.state === 'paused'
  return (
    <div
      className="flex items-center justify-between border-b border-[color:var(--ide-border)] bg-[color:var(--ide-panel-2)] px-3 py-1.5"
      data-testid="debug-header"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${indicator.color}`} />
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--ide-text-strong)]">{indicator.label}</span>
        {state.error && (
          <span className="ml-2 truncate text-[10px] text-rose-400" title={state.error}>
            {state.error}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <IconBtn label="Continue (F5)"  onClick={() => api.resume()}    disabled={state.state !== 'paused'}>▶</IconBtn>
        <IconBtn label="Pause"          onClick={() => api.pause()}     disabled={state.state !== 'running'}>‖</IconBtn>
        <IconBtn label="Step over (F10)" onClick={() => api.stepOver()} disabled={state.state !== 'paused'}>⤓</IconBtn>
        <IconBtn label="Step into (F11)" onClick={() => api.stepInto()} disabled={state.state !== 'paused'}>↷</IconBtn>
        <IconBtn label="Step out (⇧F11)" onClick={() => api.stepOut()}  disabled={state.state !== 'paused'}>↶</IconBtn>
        <IconBtn label="Stop (⇧F5)"     onClick={() => api.stop()}      disabled={!isLive}>■</IconBtn>
      </div>
    </div>
  )
}

function IconBtn({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-5 w-5 items-center justify-center rounded text-[11px] transition-colors ${
        disabled ? 'text-[color:var(--ide-muted)] opacity-40' : 'text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-panel-bg)]'
      }`}
    >
      {children}
    </button>
  )
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] bg-[color:var(--ide-panel-bg,#0f0f10)] px-3 py-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--ide-muted)]">{title}</span>
        {right}
      </div>
      <div className="max-h-40 overflow-auto">{children}</div>
    </div>
  )
}

function Empty({ hint, action }: { hint: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-[color:var(--ide-muted)]">
      <span>{hint}</span>
      {action}
    </div>
  )
}

function AddBpButton({ onAdd, defaultUrl }: { onAdd: (url: string, line: number) => Promise<void>; defaultUrl?: string }) {
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState(defaultUrl ?? 'file:///')
  const [line, setLine] = React.useState('1')
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-panel-2)] hover:text-[color:var(--ide-text-strong)]"
      >
        + Add breakpoint
      </button>
    )
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        const n = Number(line)
        if (!Number.isInteger(n) || n < 1) return
        await onAdd(url, n - 1)
        setOpen(false)
      }}
      className="flex items-center gap-1"
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="file:///path/to/script.js"
        spellCheck={false}
        className="flex-1 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ide-text-strong)] outline-none"
      />
      <input
        value={line}
        onChange={(e) => setLine(e.target.value)}
        placeholder="line"
        className="w-12 rounded border border-[color:var(--ide-border)] bg-[color:var(--ide-panel-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ide-text-strong)] outline-none"
      />
      <button type="submit" className="rounded bg-emerald-600/80 px-1.5 py-0.5 text-[10px] text-white hover:bg-emerald-500">add</button>
      <button type="button" onClick={() => setOpen(false)} className="rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]">×</button>
    </form>
  )
}

function ConsoleLines({ lines }: { lines: ReadonlyArray<{ level: string; text: string; source?: string }> }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length])
  if (lines.length === 0) {
    return <div className="px-3 py-1.5 text-[10px] text-[color:var(--ide-muted)]">No output yet.</div>
  }
  return (
    <div ref={ref} className="flex max-h-48 flex-col overflow-auto px-3 py-1 font-mono text-[10px] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2">
          <span className={`shrink-0 ${levelColor(l.level)}`}>[{l.level}]</span>
          <span className="flex-1 whitespace-pre-wrap break-words text-[color:var(--ide-text-strong)]">{l.text}</span>
          {l.source && <span className="shrink-0 text-[color:var(--ide-muted)]">{shortenUrl(l.source)}</span>}
        </div>
      ))}
    </div>
  )
}

function Repl({ api, disabled }: { api: UseDebugSessionApi; disabled: boolean }) {
  const [input, setInput] = React.useState('')
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null)
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        if (!input.trim()) return
        const r = await api.evaluate(input)
        setResult(r)
        setInput('')
      }}
      className="flex items-center gap-2 border-t border-[color:var(--ide-border)] bg-[color:var(--ide-panel-bg,#0f0f10)] px-3 py-1.5"
    >
      <span className="select-none text-[color:var(--ide-muted)]">{'>'}</span>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={disabled}
        placeholder={disabled ? 'start debugging to evaluate' : 'evaluate expression in current frame…'}
        spellCheck={false}
        autoComplete="off"
        className="flex-1 bg-transparent font-mono text-[11px] text-[color:var(--ide-text-strong)] outline-none placeholder:text-[color:var(--ide-muted)]"
        data-testid="debug-repl-input"
      />
      {result && (
        <span
          className={`truncate font-mono text-[10px] ${result.ok ? 'text-emerald-400' : 'text-rose-400'}`}
          title={result.text}
        >
          ⇒ {result.text}
        </span>
      )}
    </form>
  )
}

function stateIndicator(s: string): { color: string; label: string } {
  switch (s) {
    case 'idle':         return { color: 'bg-zinc-500', label: 'idle' }
    case 'starting':     return { color: 'bg-amber-400 animate-pulse', label: 'starting' }
    case 'awaiting-ws':  return { color: 'bg-amber-400 animate-pulse', label: 'awaiting inspector' }
    case 'attaching':    return { color: 'bg-amber-400 animate-pulse', label: 'attaching' }
    case 'running':      return { color: 'bg-emerald-500', label: 'running' }
    case 'paused':       return { color: 'bg-blue-400', label: 'paused' }
    case 'detached':     return { color: 'bg-zinc-500', label: 'detached' }
    case 'failed':       return { color: 'bg-rose-500', label: 'failed' }
    default:             return { color: 'bg-zinc-500', label: s }
  }
}

function levelColor(level: string): string {
  switch (level) {
    case 'error': return 'text-rose-400'
    case 'warn':  return 'text-amber-400'
    case 'info':  return 'text-sky-400'
    case 'debug': return 'text-[color:var(--ide-muted)]'
    default:      return 'text-[color:var(--ide-text-strong)]'
  }
}

function shortenUrl(u: string): string {
  if (!u) return ''
  try {
    if (u.startsWith('file://')) return u.replace(/^file:\/\/[^/]*/, '')
    return u
  } catch { return u }
}
