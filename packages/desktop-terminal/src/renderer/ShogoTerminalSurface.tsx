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
import { TerminalContextMenu, buildVsCodeMenuGroups } from './context-menu'
// xterm.js depends on this stylesheet to size the row container and
// clip-hide the input proxy `<textarea>`. Missing it = blank panel with a
// stray white input box. Side-effect import (bundled by the consumer's
// web bundler).
import '@xterm/xterm/css/xterm.css'

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
  /**
   * Optional callbacks for context-menu items that need parent state.
   * Items without a callback render as enabled rows that no-op; pass
   * `disabled` flags via TODO if you want to grey them out per-host.
   */
  onRename?(): void
  onConfigure?(): void
  onSplit?(): void
  onChangeColor?(hex: string): void
  onChangeIcon?(iconId: string): void
  /** Color swatches for the "Change Color" submenu (defaults to VS Code's 8). */
  contextColors?: ReadonlyArray<{ label: string; hex: string }>
  /** Icon list for the "Change Icon" submenu (defaults to empty). */
  contextIcons?: ReadonlyArray<{ label: string; id: string }>
}

const DEFAULT_CONTEXT_COLORS = [
  { label: 'Default', hex: '#cccccc' },
  { label: 'Red', hex: '#cd3131' },
  { label: 'Orange', hex: '#d18616' },
  { label: 'Yellow', hex: '#e5e510' },
  { label: 'Green', hex: '#0dbc79' },
  { label: 'Cyan', hex: '#11a8cd' },
  { label: 'Blue', hex: '#2472c8' },
  { label: 'Magenta', hex: '#bc3fbc' },
] as const

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
    onRename,
    onConfigure,
    onSplit,
    onChangeColor,
    onChangeIcon,
    contextColors = DEFAULT_CONTEXT_COLORS,
    contextIcons,
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
    const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null)
    const [hasClipboard, setHasClipboard] = React.useState(false)
    /** Phase 6: gutter-glyph click → 4-item action popover. */
    const [cmdMenu, setCmdMenu] = React.useState<{ x: number; y: number; command: Command } | null>(null)
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
        const decorations = new CommandDecorations({
          host: term,
          tracker,
          onClick: ({ command, mouseEvent }) => {
            mouseEvent.preventDefault()
            mouseEvent.stopPropagation()
            setCmdMenu({ x: mouseEvent.clientX, y: mouseEvent.clientY, command })
          },
        })
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
        term.onData((data) => {
          // eslint-disable-next-line no-console
          console.debug('[shogo-term] keystroke →', data.length, 'bytes')
          client.send(data)
        })
        term.onResize(({ cols, rows }) => client.resize(cols, rows))

        // eslint-disable-next-line no-console
        console.info('[shogo-term] surface mounted — listeners attached, state =', client.state)
        let firstDataLogged = false
        const offData = client.onData((bytes) => {
          if (!firstDataLogged) {
            firstDataLogged = true
            const preview = Array.from(bytes.slice(0, 32))
              .map((b) => (b < 32 || b > 126 ? `\\x${b.toString(16).padStart(2, '0')}` : String.fromCharCode(b)))
              .join('')
            // eslint-disable-next-line no-console
            console.info('[shogo-term] first PTY bytes arrived ✓ — size:', bytes.byteLength, ', preview:', preview)
          }
          let decoded
          try {
            decoded = decoder.feed(bytes)
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[shogo-term] OSC decoder threw — raw-writing the chunk:', e)
            batcher.write(bytes)
            return
          }
          if (decoded.events.length > 0) tracker.feedAll(decoded.events)
          const activeCommand = activeCommandRef.current
          if (activeCommand !== null && decoded.passthrough.byteLength > 0) {
            commandOutputRef.current.get(activeCommand)?.push(new TextDecoder().decode(decoded.passthrough))
          }
          if (decoded.passthrough.byteLength === 0 && bytes.byteLength > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              '[shogo-term] decoder consumed', bytes.byteLength,
              'bytes with 0 passthrough — events:', decoded.events.length,
            )
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
        // F3 / Shift+F3 — VS Code parity. Only meaningful when search is
        // already open AND a query has been typed; otherwise we just open
        // the popover so the user can start typing.
        if (ev.key === 'F3') {
          ev.preventDefault()
          if (!searchOpen) {
            setSearchOpen(true)
            return
          }
          if (ev.shiftKey) searchController?.findPrev()
          else searchController?.findNext()
        }
      }
      const el = hostRef.current
      el?.addEventListener('keydown', onKey)
      return () => el?.removeEventListener('keydown', onKey)
    }, [cmdK, searchController, searchOpen])

    React.useImperativeHandle(ref, () => ({
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
      refit: () => fitRef.current?.fit(),
    }), [])

    const openContextMenu = (ev: React.MouseEvent) => {
      ev.preventDefault()
      // Probe clipboard text availability so 'Paste' renders correctly
      // disabled when nothing is pasteable. Wrapped in try because the
      // permission can throw in some Electron contexts.
      try {
        const cb = (navigator as Navigator & { clipboard?: Clipboard }).clipboard
        if (cb && typeof cb.readText === 'function') {
          cb.readText().then((t) => setHasClipboard(t.length > 0)).catch(() => setHasClipboard(false))
        } else {
          setHasClipboard(false)
        }
      } catch {
        setHasClipboard(false)
      }
      setMenuPos({ x: ev.clientX, y: ev.clientY })
    }

    const menuGroups = React.useMemo(() => {
      if (!menuPos) return null
      const term = termRef.current
      const selection = term?.getSelection() ?? ''
      const hasSelection = selection.length > 0
      const isEmpty = (term?.buffer.active.length ?? 0) === 0
      const hasProcess = state === 'open'
      const recent = tracker.snapshot().commands.slice(-10).reverse()
      return buildVsCodeMenuGroups({
        hasSelection,
        hasClipboard,
        hasProcess,
        isEmpty,
        recentCommands: recent
          .map((c) => c.commandLine?.trim())
          .filter((s): s is string => !!s && s.length > 0)
          .slice(0, 8)
          .map((label) => ({ label, onSelect: () => client.send(`${label}\r`) })),
        colors: contextColors.map((c) => ({ label: c.label, hex: c.hex, onSelect: () => onChangeColor?.(c.hex) })),
        icons: (contextIcons ?? []).map((i) => ({ label: i.label, onSelect: () => onChangeIcon?.(i.id) })),
        onCopy: () => {
          if (!selection) return
          try {
            navigator.clipboard?.writeText(selection).catch(() => undefined)
          } catch { /* noop */ }
        },
        onCopyAsHtml: () => {
          // xterm doesn't ship HTML selection out of the box — fall back
          // to a <pre>-wrapped escaped text dump so Slack/email recipients
          // get monospace fidelity at least.
          if (!selection) return
          const esc = selection.replace(/[&<>]/g, (c) => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')
          const html = `<pre style="font-family:monospace">${esc}</pre>`
          try {
            const item = new (globalThis as typeof globalThis & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem!({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([selection], { type: 'text/plain' }),
            })
            navigator.clipboard?.write([item]).catch(() => undefined)
          } catch {
            navigator.clipboard?.writeText(selection).catch(() => undefined)
          }
        },
        onPaste: () => {
          try {
            navigator.clipboard?.readText().then((t) => { if (t) client.send(t) }).catch(() => undefined)
          } catch { /* noop */ }
        },
        onSelectAll: () => term?.selectAll(),
        onFind: () => setSearchOpen(true),
        onKill: () => client.signal('KILL'),
        onRename: () => onRename?.(),
        onConfigure: () => onConfigure?.(),
        onSplit: () => onSplit?.(),
        onClear: () => term?.clear(),
      })
    }, [menuPos, hasClipboard, state, tracker, client, contextColors, contextIcons, onChangeColor, onChangeIcon, onRename, onConfigure, onSplit])

    return React.createElement('div', {
      'data-shogo-terminal-surface': 'true',
      onContextMenu: openContextMenu,
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
      menuPos && menuGroups
        ? React.createElement(TerminalContextMenu, {
            groups: menuGroups,
            x: menuPos.x,
            y: menuPos.y,
            onDismiss: () => setMenuPos(null),
          })
        : null,
      // Phase 6: gutter-glyph click → small action popover. We reuse the
      // same TerminalContextMenu primitive so visual style + dismissal
      // (Esc, outside click) match the right-click menu exactly.
      cmdMenu
        ? React.createElement(TerminalContextMenu, {
            groups: [[
              {
                label: 'Re-run command',
                disabled: !cmdMenu.command.commandLine,
                onSelect: () => client.send(`${cmdMenu.command.commandLine}\r`),
              },
              {
                label: 'Copy command',
                disabled: !cmdMenu.command.commandLine,
                onSelect: () => {
                  try { navigator.clipboard?.writeText(cmdMenu.command.commandLine).catch(() => undefined) } catch { /* */ }
                },
              },
              {
                label: 'Copy output',
                disabled: !cmdMenu.command.startMarker || !cmdMenu.command.endMarker,
                onSelect: () => {
                  const term = termRef.current
                  const startLine = cmdMenu.command.startMarker?.line
                  const endLine = cmdMenu.command.endMarker?.line
                  if (!term || startLine == null || endLine == null) return
                  const base = term.buffer.active.baseY
                  const rows: string[] = []
                  for (let line = startLine; line <= endLine; line += 1) {
                    rows.push(term.buffer.active.getLine(line - base)?.translateToString(true) ?? '')
                  }
                  try { navigator.clipboard?.writeText(rows.join('\n').trimEnd()).catch(() => undefined) } catch { /* */ }
                },
              },
              {
                label: 'How does this command work?',
                // Phase 8 owns the full AI flow (Debug-with-AI side panel).
                // For now we just open the ⌘K palette so the user can
                // paraphrase if they want — keeps the menu item present
                // and discoverable.
                disabled: !cmdMenu.command.commandLine,
                onSelect: () => cmdK.open(),
              },
            ]],
            x: cmdMenu.x,
            y: cmdMenu.y,
            onDismiss: () => setCmdMenu(null),
          })
        : null,
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
            controller: searchController,
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
  controller: SearchController
}): React.ReactElement {
  // Subscribe to the controller's hit count + options so the popover
  // updates "1 of 12" / "No results" in real time as the user types.
  const [hits, setHits] = React.useState(props.controller.getHits())
  const [options, setOptionsState] = React.useState(props.controller.getOptions())
  React.useEffect(() => {
    props.controller.setListener(setHits)
    return () => props.controller.setListener(undefined)
  }, [props.controller])

  const setOptions = (o: typeof options) => {
    setOptionsState(o)
    props.controller.setOptions(o)
  }

  const toggle = (label: string, on: boolean, onClick: () => void, title: string) =>
    React.createElement('button', {
      type: 'button',
      onClick,
      'aria-pressed': on,
      title,
      style: {
        background: on ? '#0e639c' : 'transparent',
        color: on ? '#ffffff' : '#cccccc',
        border: '1px solid #3c3c3c',
        borderRadius: 3,
        padding: '1px 6px',
        cursor: 'pointer',
        font: 'inherit',
        minWidth: 22,
      },
    }, label)

  const countLabel = props.query.length === 0
    ? ''
    : hits.total === 0
      ? 'No results'
      : `${hits.current} of ${hits.total}`

  return React.createElement('div', {
    role: 'search',
    'data-testid': 'shogo-find-popover',
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
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    },
  },
    React.createElement('input', {
      autoFocus: true,
      value: props.query,
      placeholder: 'Find',
      'data-testid': 'shogo-find-input',
      onChange: (ev: React.ChangeEvent<HTMLInputElement>) => props.onQuery(ev.target.value),
      onKeyDown: (ev: React.KeyboardEvent<HTMLInputElement>) => {
        if (ev.key === 'Escape') { ev.preventDefault(); props.onClose(); return }
        if (ev.key === 'Enter') { ev.preventDefault(); ev.shiftKey ? props.onPrev() : props.onNext(); return }
        // F3 / Shift+F3 also navigates, matching VS Code.
        if (ev.key === 'F3') { ev.preventDefault(); ev.shiftKey ? props.onPrev() : props.onNext() }
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
    React.createElement('span', {
      'data-testid': 'shogo-find-count',
      style: {
        minWidth: 64,
        textAlign: 'right',
        opacity: countLabel ? 0.75 : 0,
        fontVariantNumeric: 'tabular-nums',
      },
    }, countLabel || '\u00a0'),
    toggle('Aa', !!options.caseSensitive,
      () => setOptions({ ...options, caseSensitive: !options.caseSensitive }),
      'Match Case'),
    toggle('ab', !!options.wholeWord,
      () => setOptions({ ...options, wholeWord: !options.wholeWord }),
      'Match Whole Word'),
    toggle('.*', !!options.regex,
      () => setOptions({ ...options, regex: !options.regex }),
      'Use Regular Expression'),
    React.createElement('button', { type: 'button', onClick: props.onPrev, title: 'Previous Match (Shift+F3)' }, '↑'),
    React.createElement('button', { type: 'button', onClick: props.onNext, title: 'Next Match (F3)' }, '↓'),
    React.createElement('button', { type: 'button', onClick: props.onClose, 'aria-label': 'Close search', title: 'Close (Escape)' }, '×'),
  )
}
