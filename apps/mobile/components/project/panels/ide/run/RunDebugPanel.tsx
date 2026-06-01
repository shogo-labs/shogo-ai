// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Run and Debug viewlet content. Lives behind the activity-bar
 * "Run and Debug" entry (id: "debug"). Reads package.json scripts via
 * the desktop run-ipc surface and renders each as a Run/Stop row with
 * live streamed output.
 *
 * Web/mobile builds short-circuit to a single explanatory paragraph —
 * the IPC surface only exists in Electron desktop, so there's nothing
 * to wire up on those platforms today.
 */
import React, { useEffect, useState } from 'react'
import { isDesktopRuntime } from '../terminal/pty-factory'
import { useRunScripts, useRunSession } from './useRunSession'
import { useDebugSession } from './useDebugSession'
import { DebugView } from './DebugView'
import { AnsiText } from '../AnsiText'

interface Props {
  workspaceRoot: string | null
}

export function RunDebugPanel({ workspaceRoot }: Props) {
  if (!isDesktopRuntime()) {
    return (
      <div className="flex h-full flex-col gap-3 p-4 text-xs text-[color:var(--ide-muted)]">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--ide-text-strong)]">
          Run and Debug
        </div>
        <p className="leading-relaxed">
          Run and Debug requires the Shogo desktop app. Web and mobile
          builds do not bundle a process-spawn surface.
        </p>
      </div>
    )
  }
  if (!workspaceRoot) {
    return (
      <div className="flex h-full flex-col gap-3 p-4 text-xs text-[color:var(--ide-muted)]">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--ide-text-strong)]">
          Run and Debug
        </div>
        <p className="leading-relaxed">
          Open a project to see runnable scripts.
        </p>
      </div>
    )
  }
  return <RunDebugPanelInner workspaceRoot={workspaceRoot} />
}

function RunDebugPanelInner({ workspaceRoot }: { workspaceRoot: string }) {
  const { scripts, packageManager, loading, error, refresh } = useRunScripts(workspaceRoot)
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<'run' | 'debug'>('run')
  const session = useRunSession(workspaceRoot, selected, packageManager)
  const debugApi = useDebugSession(workspaceRoot)
  const debugActive =
    debugApi.state.state !== 'idle' && debugApi.state.state !== 'detached' && debugApi.state.state !== 'failed'

  // Auto-flip to the debug tab when a debug session is active.
  React.useEffect(() => {
    if (debugActive && mode !== 'debug') setMode('debug')
  }, [debugActive, mode])

  return (
    <div className="flex h-full flex-col text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--ide-text-strong)]">
            Run and Debug
          </span>
          {packageManager && (
            <span className="rounded bg-[color:var(--ide-panel-2)] px-1.5 py-[1px] font-mono text-[9px] uppercase text-[color:var(--ide-muted)]">
              {packageManager}
            </span>
          )}
          <ModeTabs
            mode={mode}
            onChange={setMode}
            debugIndicator={debugActive ? debugApi.state.state : null}
          />
        </div>
        <button
          onClick={refresh}
          className="rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-panel-2)] hover:text-[color:var(--ide-text-strong)]"
          title="Refresh scripts"
        >
          ↻
        </button>
      </div>

      {mode === 'debug' ? (
        <DebugView api={debugApi} defaultBreakpointUrl={`file://${workspaceRoot}/`} />
      ) : (
      <>
      {/* Scripts list */}
      <div className="flex-shrink-0 max-h-[40%] overflow-auto border-b border-[color:var(--ide-border)]">
        {loading && <div className="p-3 text-[color:var(--ide-muted)]">Reading package.json…</div>}
        {error && <div className="p-3 text-rose-400">{error}</div>}
        {!loading && !error && scripts.length === 0 && (
          <div className="p-3 text-[color:var(--ide-muted)]">
            No scripts in package.json.
          </div>
        )}
        {scripts.map((s) => {
          const isActive = session.runId !== null && session.script === s.name
          const isRunning = isActive && session.status === 'running'
          const isDebugTarget = debugApi.state.script === s.name && debugActive
          return (
            <div
              key={s.name}
              className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-[color:var(--ide-panel-2)] ${isActive || isDebugTarget ? 'bg-[color:var(--ide-panel-2)]' : ''}`}
            >
              <button
                onClick={() => {
                  if (isRunning) {
                    session.stop()
                  } else {
                    setSelected(s.name)
                    session.start(s.name)
                  }
                }}
                disabled={debugActive}
                className={`flex h-5 w-5 items-center justify-center rounded text-[10px] ${
                  isRunning
                    ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                    : debugActive
                    ? 'text-[color:var(--ide-muted)] opacity-40'
                    : 'text-emerald-400 hover:bg-emerald-500/20'
                }`}
                title={debugActive ? 'Stop the debug session first' : isRunning ? 'Stop' : 'Run'}
              >
                {isRunning ? '■' : '▶'}
              </button>
              <button
                onClick={() => {
                  if (isDebugTarget) { void debugApi.stop() }
                  else { void debugApi.start(s.name, packageManager ?? undefined) }
                }}
                disabled={isRunning || (debugActive && !isDebugTarget)}
                className={`flex h-5 w-5 items-center justify-center rounded text-[10px] ${
                  isDebugTarget
                    ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                    : isRunning || (debugActive && !isDebugTarget)
                    ? 'text-[color:var(--ide-muted)] opacity-40'
                    : 'text-amber-400 hover:bg-amber-500/20'
                }`}
                title={isDebugTarget ? 'Stop debugging' : 'Debug (--inspect-brk)'}
                aria-label={isDebugTarget ? 'Stop debugging' : 'Debug'}
                data-testid={`debug-btn-${s.name}`}
              >
                {isDebugTarget ? '■' : '🐞'}
              </button>
              <span className="font-mono text-[11px] text-[color:var(--ide-text-strong)]">{s.name}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-[color:var(--ide-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                {s.command}
              </span>
              {isActive && (
                <span className={`text-[9px] uppercase ${session.status === 'running' ? 'text-emerald-400' : session.status === 'exit-ok' ? 'text-zinc-400' : 'text-rose-400'}`}>
                  {session.status === 'running' ? '● running' : session.status === 'exit-ok' ? '✓ done' : session.status === 'exit-err' ? '✗ exit ' + session.exitCode : ''}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Output console */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[color:var(--ide-border)] px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[color:var(--ide-muted)]">
            Output {session.script && `· ${session.script}`}
          </span>
          {session.output.length > 0 && (
            <button
              onClick={session.clear}
              className="text-[10px] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
            >
              Clear
            </button>
          )}
        </div>
        <OutputView output={session.output} />
      </div>
      </>
      )}
    </div>
  )
}

function OutputView({ output }: { output: { stream: 'stdout' | 'stderr'; data: string }[] }) {
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [output.length])
  if (output.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-[10px] text-[color:var(--ide-muted)]">
        Click ▶ on a script to start.
      </div>
    )
  }
  return (
    <div ref={ref} className="flex-1 overflow-auto bg-[color:var(--ide-panel-bg,#0a0a0a)] p-2 font-mono text-[10px] leading-relaxed">
      {output.map((chunk, i) => (
        <pre
          key={i}
          className={chunk.stream === 'stderr' ? 'whitespace-pre-wrap text-rose-300' : 'whitespace-pre-wrap text-zinc-200'}
        >
          {/* BUG-013: render ANSI as theme-coloured spans instead of stripping. */}
          <AnsiText as="span" text={chunk.data} />
        </pre>
      ))}
    </div>
  )
}

/** Run / Debug mode tabs — small pill toggles tucked into the header. */
function ModeTabs({
  mode,
  onChange,
  debugIndicator,
}: {
  mode: 'run' | 'debug'
  onChange: (m: 'run' | 'debug') => void
  /** Non-null when a debug session is live — shows a status pill on the Debug tab. */
  debugIndicator: string | null
}) {
  return (
    <div className="ml-2 flex items-center gap-0.5 rounded bg-[color:var(--ide-panel-bg,#0f0f10)] p-0.5">
      {(['run', 'debug'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide transition-colors ${
            mode === m
              ? 'bg-[color:var(--ide-panel-2)] text-[color:var(--ide-text-strong)]'
              : 'text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]'
          }`}
          data-testid={`mode-tab-${m}`}
        >
          {m}
          {m === 'debug' && debugIndicator && (
            <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
          )}
        </button>
      ))}
    </div>
  )
}
