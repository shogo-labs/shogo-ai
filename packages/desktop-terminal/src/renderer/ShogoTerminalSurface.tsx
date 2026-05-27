// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import type { Terminal as XTerminal } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'
import { OscDecoder } from '@shogo/pty-core'
import { Osc633Tracker, type Command } from './osc633-tracker'
import { CommandDecorations } from './command-decorations'
import { StickyScroll } from './sticky-scroll'
import { WriteBatcher } from './write-batcher'
import { GpuRenderer } from './gpu-renderer'
import { SearchController } from './search-popover'
import { QuickFixManager } from './quick-fix'
import { CmdKController, CmdKPopover, type LlmClient } from './cmd-k-popover'
import { getDesktopBridge } from './desktop-features'
import { MatcherEngine } from './problem-matchers'

export interface SurfacePtyClient {
  readonly state: 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'
  connect(): void
  send(bytes: string | Uint8Array): void
  resize(cols: number, rows: number): void
  signal(sig: 'INT' | 'TERM' | 'KILL'): void
  onState(cb: (s: SurfacePtyClient['state']) => void): () => void
  onData(cb: (b: Uint8Array) => void): () => void
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): () => void
  onError(cb: (err: Error) => void): () => void
  onTruncated(cb: () => void): () => void
}

export interface ShogoTerminalSurfaceHandle {
  clear(): void
  focus(): void
  refit(): void
}

export interface ShogoTerminalSurfaceProps {
  client: SurfacePtyClient
  hidden?: boolean
  autoFocus?: boolean
  fontSize?: number
  fontFamily?: string
  enableGpu?: boolean
  llm?: LlmClient
  projectId?: string | null
  apiBase?: string
}

const DARK_PLUS_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#ffffff',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
}

const noopLlm: LlmClient = {
  async streamCommand(opts) {
    opts.onError(new Error('Terminal AI is not wired yet.'))
    return { cancel() {} }
  },
}

export const ShogoTerminalSurface = React.forwardRef<ShogoTerminalSurfaceHandle, ShogoTerminalSurfaceProps>(
  function ShogoTerminalSurface({
    client,
    hidden = false,
    autoFocus = true,
    fontSize = 13,
    fontFamily = 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    enableGpu = true,
    llm,
    projectId,
    apiBase,
  }, ref) {
    const hostRef = React.useRef<HTMLDivElement | null>(null)
    const termRef = React.useRef<XTerminal | null>(null)
    const fitRef = React.useRef<XFitAddon | null>(null)
    const trackerRef = React.useRef(new Osc633Tracker())
    const [tracker] = React.useState(() => trackerRef.current)
    const [state, setState] = React.useState(client.state)
    const [searchController, setSearchController] = React.useState<SearchController | null>(null)
    const [searchOpen, setSearchOpen] = React.useState(false)
    const [searchQuery, setSearchQuery] = React.useState('')
    const [hostUnresponsive, setHostUnresponsive] = React.useState(false)
    const matcherRef = React.useRef(new MatcherEngine())
    const commandOutputRef = React.useRef(new Map<number, string[]>())
    const activeCommandRef = React.useRef<number | null>(null)
    const [cmdK] = React.useState(() => new CmdKController({
      llm: llm ?? (() => {
        try { return getDesktopBridge().llm ?? noopLlm } catch { return noopLlm }
      })(),
      contextProvider: () => ({
        cwd: tracker.snapshot().cwd,
        shell: null,
        os: platformName(),
        recentCommands: tracker.snapshot().commands.slice(-5).map((c) => c.commandLine).filter(Boolean),
      }),
      onSubmit: (command) => client.send(`${command}\r`),
    }))

    React.useEffect(() => {
      setState(client.state)
      return client.onState((s) => setState(s))
    }, [client])

    React.useEffect(() => {
      try {
        return getDesktopBridge().onEvent((ev) => {
          if (ev.kind === 'host:unresponsive') setHostUnresponsive(true)
          if (ev.kind === 'host:ready' || ev.kind === 'host:beat') setHostUnresponsive(false)
        })
      } catch {
        return undefined
      }
    }, [])

    React.useEffect(() => {
      const container = hostRef.current
      if (!container) return
      let disposed = false
      let cleanup = () => undefined as void

      void (async () => {
        const [xtermMod, fitMod, linksMod, searchMod, webglMod] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-webgl').catch(() => null),
        ])
        if (disposed) return

        const term = new xtermMod.Terminal({
          convertEol: true,
          cursorBlink: true,
          fontFamily,
          fontSize,
          scrollback: 10_000,
          theme: DARK_PLUS_THEME,
          allowProposedApi: true,
        })
        const fit = new fitMod.FitAddon()
        const links = new linksMod.WebLinksAddon()
        const search = new searchMod.SearchAddon()
        term.loadAddon(fit)
        term.loadAddon(links)
        term.loadAddon(search)
        term.open(container)
        fit.fit()
        termRef.current = term
        fitRef.current = fit

        const decoder = new OscDecoder()
        const batcher = new WriteBatcher({ sink: term.write.bind(term) })
        tracker.setMarkerFactory({ registerMarker: () => term.registerMarker(0) ?? undefined })
        const decorations = new CommandDecorations({ host: term, tracker })
        const quickFix = new QuickFixManager({
          host: term,
          tracker,
          buffer: {
            readRows(startLine, endLine) {
              const rows: string[] = []
              const base = term.buffer.active.baseY
              for (let line = startLine; line < endLine; line += 1) {
                rows.push(term.buffer.active.getLine(line - base)?.translateToString(true) ?? '')
              }
              return rows
            },
          },
          onSuggestion(ev) {
            if (ev.suggestion.action.kind === 'run') {
              client.send(`${ev.suggestion.action.payload}\r`)
            }
          },
        })
        const gpu = new GpuRenderer({
          term,
          enabled: enableGpu && !!webglMod,
          createWebglAddon: () => {
            if (!webglMod) throw new Error('WebGL addon unavailable')
            const addon = new webglMod.WebglAddon() as any
            if (!addon.onContextLost && addon.onContextLoss) addon.onContextLost = addon.onContextLoss.bind(addon)
            if (!addon.onContextLost) addon.onContextLost = () => ({ dispose() {} })
            return addon
          },
        })

        setSearchController(new SearchController({ addon: search }))
        const offTracker = tracker.on((ev) => {
          if (ev.kind === 'command-started') {
            activeCommandRef.current = ev.command.id
            commandOutputRef.current.set(ev.command.id, [])
          }
          if (ev.kind === 'command-finished') {
            const output = commandOutputRef.current.get(ev.command.id)?.join('') ?? ''
            activeCommandRef.current = null
            void publishTerminalDiagnostics(projectId, apiBase, ev.command.id, ev.command.exitCode, output, matcherRef.current)
          }
        })
        term.onData((data) => client.send(data))
        term.onResize(({ cols, rows }) => client.resize(cols, rows))
        const offData = client.onData((bytes) => {
          const decoded = decoder.feed(bytes)
          if (decoded.events.length > 0) tracker.feedAll(decoded.events)
          const activeCommand = activeCommandRef.current
          if (activeCommand !== null && decoded.passthrough.byteLength > 0) {
            commandOutputRef.current.get(activeCommand)?.push(new TextDecoder().decode(decoded.passthrough))
          }
          batcher.write(decoded.passthrough)
        })
        const offExit = client.onExit((info) => {
          const tag = info.signal ? ` (signal ${info.signal})` : ''
          batcher.write(`\r\n\x1b[2;90m[shell exited with code ${info.code ?? '?'}${tag}]\x1b[0m\r\n`)
        })
        const offTrunc = client.onTruncated(() => {
          batcher.write('\x1b[2;90m[scrollback truncated - older output dropped]\x1b[0m\r\n')
        })
        const offError = client.onError((err) => {
          batcher.write(`\r\n\x1b[31m[terminal error] ${err.message}\x1b[0m\r\n`)
        })
        const ro = new ResizeObserver(() => fit.fit())
        ro.observe(container)
        client.resize(term.cols, term.rows)
        if (autoFocus && !hidden) term.focus()

        cleanup = () => {
          offData(); offExit(); offTrunc(); offError()
          offTracker()
          ro.disconnect()
          batcher.dispose()
          decorations.dispose()
          quickFix.dispose()
          gpu.dispose()
          search.dispose?.()
          term.dispose()
          termRef.current = null
          fitRef.current = null
          setSearchController(null)
        }
      })()

      return () => {
        disposed = true
        cleanup()
      }
    }, [client, autoFocus, hidden, fontFamily, fontSize, enableGpu, tracker])

    React.useEffect(() => {
      if (!hidden && autoFocus) termRef.current?.focus()
    }, [hidden, autoFocus])

    React.useEffect(() => {
      const onKey = (ev: KeyboardEvent) => {
        const isMac = navigator.platform.toLowerCase().includes('mac')
        if ((isMac ? ev.metaKey : ev.ctrlKey) && ev.key.toLowerCase() === 'f') {
          ev.preventDefault()
          setSearchOpen(true)
        }
        if ((isMac ? ev.metaKey : ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
          ev.preventDefault()
          cmdK.open()
        }
      }
      const el = hostRef.current
      el?.addEventListener('keydown', onKey)
      return () => el?.removeEventListener('keydown', onKey)
    }, [cmdK, searchController])

    React.useImperativeHandle(ref, () => ({
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
      refit: () => fitRef.current?.fit(),
    }), [])

    return React.createElement('div', {
      'data-shogo-terminal-surface': 'true',
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        display: hidden ? 'none' : 'block',
        background: '#1e1e1e',
      },
    },
      React.createElement('div', {
        ref: hostRef,
        style: { width: '100%', height: '100%', padding: '4px 6px' },
      }),
      React.createElement(StickyScroll as React.ComponentType<any>, {
        tracker,
        onClick: (command: Command) => {
          const marker = command.promptMarker ?? command.startMarker
          if (marker) termRef.current?.scrollToLine(marker.line)
        },
      }),
      searchController && searchOpen
        ? React.createElement(SearchBox, {
            query: searchQuery,
            onQuery(query) {
              setSearchQuery(query)
              searchController.setQuery(query)
            },
            onNext: () => searchController.findNext(),
            onPrev: () => searchController.findPrev(),
            onClose() {
              searchController.clear()
              setSearchQuery('')
              setSearchOpen(false)
              termRef.current?.focus()
            },
          })
        : null,
      React.createElement(CmdKPopover, { controller: cmdK }),
      hostUnresponsive
        ? React.createElement('button', {
            type: 'button',
            onClick: () => void getDesktopBridge().restartHost?.().catch(() => undefined),
            style: {
              position: 'absolute',
              top: 8,
              left: 12,
              zIndex: 40,
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #f5c542',
              background: '#3a3000',
              color: '#f5c542',
              font: '12px system-ui, -apple-system, sans-serif',
            },
          }, 'Pty host unresponsive - restart')
        : null,
      state !== 'open' && state !== 'idle'
        ? React.createElement('div', {
            style: {
              position: 'absolute',
              top: 8,
              right: 12,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(0,0,0,0.6)',
              color: '#cccccc',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontSize: 11,
              pointerEvents: 'none',
            },
          }, state === 'connecting' ? 'Reconnecting...' : state === 'closed' ? 'Disconnected' : 'Closed')
        : null,
    )
  },
)

function platformName(): 'mac' | 'linux' | 'win' | 'unknown' {
  const p = navigator.platform.toLowerCase()
  if (p.includes('mac')) return 'mac'
  if (p.includes('win')) return 'win'
  if (p.includes('linux')) return 'linux'
  return 'unknown'
}

async function publishTerminalDiagnostics(
  projectId: string | null | undefined,
  apiBase: string | undefined,
  commandId: number,
  exitCode: number | null,
  output: string,
  engine: MatcherEngine,
): Promise<void> {
  if (!projectId) return
  const base = apiBase ?? ((globalThis as any).shogoDesktop?.apiUrl as string | undefined)
  if (!base) return
  const diagnostics = exitCode === 0 ? [] : engine.run(commandId, output)
  await fetch(`${base}/api/projects/${projectId}/diagnostics/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diagnostics, clear: exitCode === 0 }),
  }).catch(() => undefined)
}

function SearchBox(props: {
  query: string
  onQuery(query: string): void
  onNext(): boolean
  onPrev(): boolean
  onClose(): void
}): React.ReactElement {
  return React.createElement('div', {
    role: 'search',
    style: {
      position: 'absolute',
      top: 8,
      right: 12,
      zIndex: 25,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 6px',
      borderRadius: 6,
      border: '1px solid #3c3c3c',
      background: '#252526',
      color: '#cccccc',
      font: '12px system-ui, -apple-system, sans-serif',
    },
  },
    React.createElement('input', {
      autoFocus: true,
      value: props.query,
      placeholder: 'Find',
      onChange: (ev: React.ChangeEvent<HTMLInputElement>) => props.onQuery(ev.target.value),
      onKeyDown: (ev: React.KeyboardEvent<HTMLInputElement>) => {
        if (ev.key === 'Escape') { ev.preventDefault(); props.onClose() }
        if (ev.key === 'Enter') { ev.preventDefault(); ev.shiftKey ? props.onPrev() : props.onNext() }
      },
      style: {
        width: 180,
        background: '#1e1e1e',
        color: '#cccccc',
        border: '1px solid #3c3c3c',
        borderRadius: 4,
        outline: 'none',
        padding: '3px 6px',
      },
    }),
    React.createElement('button', { type: 'button', onClick: props.onPrev }, '↑'),
    React.createElement('button', { type: 'button', onClick: props.onNext }, '↓'),
    React.createElement('button', { type: 'button', onClick: props.onClose, 'aria-label': 'Close search' }, '×'),
  )
}
