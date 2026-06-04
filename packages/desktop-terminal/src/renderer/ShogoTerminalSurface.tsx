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
import { CommandHistorySource, trackerAdapter } from './history/history-sources'
import { RecentCommandPicker, useCommandPicker } from './pickers/recent-pickers'
import { getDesktopBridge } from './desktop-features'
import { MatcherEngine } from './problem-matchers'
import { TerminalContextMenu, buildVsCodeMenuGroups } from './context-menu'
import { ApprovalStore, workspaceHashOf, type ApprovalDecision } from './approval-store'
import { buildDebugContext, serialiseDebugContext, type DebugContext } from './debug-with-ai'
import { useShogoTheme, type ThemeSource, type XtermThemeColors } from './use-shogo-theme'
import { SnapshotStore, captureScrollback, restoreScrollback } from './persistence/snapshot-store'
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
  openFind?(): void
  openRecent?(): void
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
  /** Emits shell cwd changes from OSC 633 so host chrome can show location. */
  onCwdChange?(cwd: string): void
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
  /**
   * Phase 10 — terminal persistence.
   *
   * When both `sessionId` AND `snapshotStore` are provided, the surface
   * will look up a saved snapshot on mount (scrollback, cwd, last
   * command label), restore it into xterm *before* attaching the PTY,
   * and then persist the live scrollback to the store on every command
   * boundary + on unmount.
   *
   * Either prop on its own is a no-op — persistence is strictly opt-in
   * at the host layer.
   */
  sessionId?: string
  snapshotStore?: SnapshotStore
  /**
   * Phase 10 — theme sync. When provided, the surface drives its xterm
   * theme off this source AND subscribes to live changes (e.g. an
   * Electron `nativeTheme` listener) so flipping system dark/light
   * propagates without a reload.
   *
   * Defaults to `prefers-color-scheme` via `useShogoTheme`.
   */
  themeSource?: ThemeSource
  /** Hard override — when set, ignores themeSource and uses this verbatim. */
  themeOverride?: XtermThemeColors
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

// DARK_PLUS_THEME used to live here as a frozen constant — moved into
// use-shogo-theme.ts so the canonical VS Code palettes (Dark+ and the
// new Light+ added in Phase 10) live in one place and stay in sync with
// the theme hook's defaults.

/**
 * Escape a literal command string for safe use as an `ApprovalStore`
 * regex pattern when the user clicks "Always allow / deny". The store
 * compiles patterns with `new RegExp(pattern)` so any unescaped meta
 * character would either fail to match or silently broaden the rule.
 */
function escapeForRegex(s: string): string {
  return `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
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
    onCwdChange,
    onRename,
    onConfigure,
    onSplit,
    onChangeColor,
    onChangeIcon,
    contextColors = DEFAULT_CONTEXT_COLORS,
    contextIcons,
    sessionId,
    snapshotStore,
    themeSource,
    themeOverride,
  }, ref) {
    const hostRef = React.useRef<HTMLDivElement | null>(null)
    const termRef = React.useRef<XTerminal | null>(null)
    /**
     * Phase 10 — live theme. When `themeOverride` is set we honor it
     * verbatim; otherwise the hook drives the palette and re-renders
     * the surface on system dark/light toggles (~50ms in Chromium).
     */
    const { theme: hookedTheme } = useShogoTheme({ source: themeSource })
    const theme = themeOverride ?? hookedTheme
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
    // Hold the latest onCwdChange in a ref so the main mount effect does
    // NOT re-run (and tear down the xterm instance) every time the parent
    // passes a fresh inline callback. Without this, `patchSession` inside
    // the parent's `onCwdChange` flips React state on every cwd event,
    // re-renders the parent, hands us a new function reference, and
    // remounts the terminal — leaving the user staring at a blank,
    // unfocused xterm that swallows every keystroke.
    const onCwdChangeRef = React.useRef<typeof onCwdChange>(onCwdChange)
    onCwdChangeRef.current = onCwdChange

    /**
     * Phase 8 — ApprovalStore singleton.
     *
     * Keyed by the project ID (when host supplies one) so each workspace
     * gets its own allow/deny rule table that survives reloads. Falls
     * back to a stable "default" hash for the unscoped case.
     *
     * Seeded with the SAFE_DEFAULTS + DESTRUCTIVE_DENIES baked into the
     * approval-store module so that `rm -rf /`, `curl … | sh`, etc., are
     * gated before the user has had a chance to configure anything.
     */
    const [approvalStore] = React.useState(() => new ApprovalStore({
      workspaceHash: workspaceHashOf(projectId ?? 'default'),
    }))
    const [approvalAsk, setApprovalAsk] = React.useState<{ decision: ApprovalDecision; onResolve(ok: boolean, remember: boolean): void } | null>(null)
    const [debugPanel, setDebugPanel] = React.useState<DebugContext | null>(null)

    /**
     * runWithApproval — single chokepoint for every "run a command on
     * behalf of the user" call site (⌘K Tab/Enter, gutter Re-run, Quick
     * Fix run-action). Routes through ApprovalStore:
     *   • verdict 'allow' → fire-and-forget client.send
     *   • verdict 'deny'  → log + drop (rule explains why)
     *   • verdict 'ask'   → render modal, resume on user click
     */
    const runWithApprovalRef = React.useRef<(command: string) => void>(() => undefined)
    runWithApprovalRef.current = (command: string) => {
      const cmd = command.trim()
      if (!cmd) return
      const decision = approvalStore.evaluate(cmd)
      if (decision.verdict === 'allow') {
        client.send(`${cmd}\r`)
        return
      }
      if (decision.verdict === 'deny') {
        // eslint-disable-next-line no-console
        console.warn('[shogo-term] command denied by approval rule:', decision.rule?.pattern, '→', cmd)
        return
      }
      setApprovalAsk({
        decision,
        onResolve(ok, remember) {
          setApprovalAsk(null)
          if (remember) {
            approvalStore.addRule(ok ? 'allow' : 'deny', escapeForRegex(cmd), 'user choice')
          }
          if (ok) client.send(`${cmd}\r`)
        },
      })
    }

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
      // Phase 8: route every ⌘K submission through the approval gate so
      // destructive AI-suggested commands surface a confirm dialog before
      // they hit the PTY. Indirection via ref keeps this stable across
      // controller construction without re-binding.
      onSubmit: (command) => runWithApprovalRef.current(command),
    }))
    const [commandHistorySource] = React.useState(() => new CommandHistorySource({ tracker: trackerAdapter(tracker) }))
    const recentCommandPicker = useCommandPicker({
      source: commandHistorySource,
      onAccept: (entry) => runWithApprovalRef.current(entry.command),
    })

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
          theme,
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

        // Phase 10 — restore scrollback from a prior snapshot (if both
        // `sessionId` and `snapshotStore` are configured). Must happen
        // before any client.onData listener can write live bytes, so
        // restored rows always scroll *above* whatever the new PTY
        // prints first.
        if (sessionId && snapshotStore) {
          try {
            const snap = snapshotStore.load(sessionId)
            if (snap) {
              restoreScrollback(term, snap)
              // eslint-disable-next-line no-console
              console.info(
                '[shogo-term] restored snapshot — %d rows from %s',
                snap.lines.length,
                new Date(snap.savedAt).toISOString(),
              )
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[shogo-term] snapshot restore failed:', e)
          }
        }

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
            // Phase 8: gate Quick-Fix run-actions through the approval
            // store. Insert-only suggestions still flow straight to the
            // PTY (they're typed at the prompt, not executed).
            if (ev.suggestion.action.kind === 'run') {
              runWithApprovalRef.current(ev.suggestion.action.payload)
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

        // Phase 10 — debounced snapshot saver. Captures on every
        // command boundary (a natural quiescent point) and on unmount.
        // Debounced via a 500ms trailing timer so a burst of commands
        // doesn't hammer SQLite.
        const persistEnabled = !!(sessionId && snapshotStore)
        let saveTimer: ReturnType<typeof setTimeout> | null = null
        const flushSnapshot = () => {
          if (!persistEnabled) return
          if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null }
          try {
            const snap = tracker.snapshot()
            const activeCmd = activeCommandRef.current != null
              ? snap.commands.find((c) => c.id === activeCommandRef.current)?.commandLine ?? null
              : null
            snapshotStore!.save({
              sessionId: sessionId!,
              cwd: snap.cwd ?? null,
              activeCommand: activeCmd,
              lines: captureScrollback(term, 5000),
            })
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[shogo-term] snapshot save failed:', e)
          }
        }
        const scheduleSnapshotSave = () => {
          if (!persistEnabled) return
          if (saveTimer != null) clearTimeout(saveTimer)
          saveTimer = setTimeout(flushSnapshot, 500)
        }

        const offTracker = tracker.on((ev) => {
          if (ev.kind === 'command-started') {
            activeCommandRef.current = ev.command.id
            commandOutputRef.current.set(ev.command.id, [])
          }
          if (ev.kind === 'cwd-changed') {
            onCwdChangeRef.current?.(ev.cwd)
          }
          if (ev.kind === 'command-finished') {
            const output = commandOutputRef.current.get(ev.command.id)?.join('') ?? ''
            activeCommandRef.current = null
            void publishTerminalDiagnostics(projectId, apiBase, ev.command.id, ev.command.exitCode, output, matcherRef.current)
            // Persistence: every finished command is a good time to
            // checkpoint scrollback + cwd to the snapshot store.
            scheduleSnapshotSave()
          }
        })
        term.onData((data) => client.send(data))
        term.onResize(({ cols, rows }) => client.resize(cols, rows))

        const offData = client.onData((bytes) => {
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
          // Phase 10: flush one last snapshot before tearing down the
          // terminal — captures any post-last-command typing/output.
          flushSnapshot()
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
      // Deliberately omit `onCwdChange` from deps — see `onCwdChangeRef`
      // above. Including it caused the entire xterm instance to be torn
      // down and rebuilt on every parent render (root cause of the
      // "blank terminal that won't accept keystrokes" bug).
    }, [client, fontFamily, fontSize, enableGpu, tracker])

    React.useEffect(() => {
      if (!hidden && autoFocus) termRef.current?.focus()
    }, [hidden, autoFocus])

    /**
     * Phase 10 — push live theme changes into xterm. We don't recreate
     * the terminal on theme flip; `options.theme = …` is enough and
     * xterm repaints on the next frame. Skip the first render (when
     * the terminal hasn't mounted yet) since the initial `theme` was
     * already passed to the constructor.
     */
    React.useEffect(() => {
      const term = termRef.current
      if (!term) return
      try {
        term.options.theme = theme
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[shogo-term] theme update failed:', e)
      }
    }, [theme])

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
      openFind: () => {
        setSearchOpen(true)
      },
      openRecent: () => recentCommandPicker.open(),
    }), [recentCommandPicker])

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

    /**
     * Click-to-focus.
     *
     * xterm.js owns its own hidden `<textarea>` for keystroke capture. The
     * ONLY thing we need from this wrapper div is to forward clicks on the
     * surrounding padding (where xterm's internal mousedown listener can't
     * see them) into `term.focus()`.
     *
     * Important: this div MUST NOT carry `tabIndex` (and therefore must NOT
     * have a competing onKeyDown handler). An earlier version added
     * `tabIndex={0}` + an ad-hoc `sendKeyboardFallback`, which caused the
     * wrapper to steal focus from xterm's textarea on every padding-click —
     * resulting in a blinking-but-unfocused cursor where most keystrokes
     * silently disappeared (the fallback only knew about a handful of
     * keys; meta-combos, IME, dead keys, paste, etc. all dropped).
     */
    const focusTerminal = React.useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
      // Don't steal focus from popovers (search box, ⌘K palette, etc.)
      // that legitimately host their own inputs above the surface.
      const target = ev.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'button' ||
          target?.isContentEditable ||
          target?.closest?.('[role="dialog"], [role="menu"], [role="search"]')) {
        return
      }
      termRef.current?.focus()
    }, [])

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
      // mousedown fires before the browser commits focus, so calling
      // term.focus() here wins the race against any default focus rule.
      onMouseDown: focusTerminal,
      // No `tabIndex` here — see `focusTerminal` comment. A focusable
      // wrapper would steal focus from xterm's textarea and silently
      // swallow keystrokes.
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        display: hidden ? 'none' : 'block',
        background: '#1e1e1e',
      },
    },
      React.createElement('style', null, `
        [data-shogo-terminal-surface] .xterm-viewport {
          overflow-y: auto !important;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
        }
        [data-shogo-terminal-surface] .xterm-viewport::-webkit-scrollbar {
          width: 10px;
        }
        [data-shogo-terminal-surface] .xterm-viewport::-webkit-scrollbar-thumb {
          background: #424242;
          border-radius: 999px;
          border: 2px solid #1e1e1e;
        }
        [data-shogo-terminal-surface] .xterm-viewport::-webkit-scrollbar-track {
          background: #1e1e1e;
        }
      `),
      React.createElement('div', {
        ref: hostRef,
        style: { width: '100%', height: '100%', padding: '4px 6px', overflow: 'hidden' },
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
                // Phase 8: gate Re-run through the approval store so a
                // remembered "deny" rule (e.g. `rm -rf …`) actually
                // blocks the second attempt, not just the first.
                onSelect: () => runWithApprovalRef.current(cmdMenu.command.commandLine),
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
                // Phase 8: real Debug-with-AI flow. Bundle the failing
                // command + its tail output + cwd + exit code into a
                // DebugContext and open the side panel. The panel shows
                // a markdown report and offers an "Apply Fix" action
                // that re-routes through runWithApproval.
                label: cmdMenu.command.exitCode && cmdMenu.command.exitCode !== 0
                  ? 'Debug with AI'
                  : 'Explain this command',
                disabled: !cmdMenu.command.commandLine,
                onSelect: () => {
                  const term = termRef.current
                  if (!term) return
                  // BufferReader contract (see debug-with-ai.ts):
                  // readRows(startLine, endLine) returns the inclusive
                  // range of rendered terminal rows. We reuse the same
                  // base-offset translation as the Copy-Output handler.
                  const ctx = buildDebugContext({
                    command: cmdMenu.command,
                    shell: null,
                    tailRows: 200,
                    buffer: {
                      readRows(startLine: number, endLine: number) {
                        const base = term.buffer.active.baseY
                        const out: string[] = []
                        for (let line = startLine; line <= endLine; line += 1) {
                          out.push(term.buffer.active.getLine(line - base)?.translateToString(true) ?? '')
                        }
                        return out
                      },
                    },
                  })
                  setDebugPanel(ctx)
                  // Also push the context to the IDE's chat panel so
                  // the user can continue debugging in a conversational
                  // flow. Best-effort: if the bridge is unavailable
                  // (e.g. web/mobile) the local side panel still works.
                  try {
                    const md = serialiseDebugContext(ctx)
                    void getDesktopBridge().llm?.openChatWithContext?.(md)
                  } catch { /* bridge unavailable */ }
                },
              },
            ]],
            x: cmdMenu.x,
            y: cmdMenu.y,
            onDismiss: () => setCmdMenu(null),
          })
        : null,
      // Phase 8: approval modal — only mounted while a verdict='ask'
      // decision is pending. Standalone (no portal) so it composes with
      // the existing positioning context.
      approvalAsk
        ? React.createElement(ApprovalAskModal, { ask: approvalAsk })
        : null,
      // Phase 8: Debug-with-AI side panel — shows the serialised
      // DebugContext markdown report. "Apply Fix" routes through the
      // approval gate. Close dismisses without sending anything.
      debugPanel
        ? React.createElement(DebugWithAiPanel, {
            context: debugPanel,
            onClose: () => setDebugPanel(null),
            onApply: (fix: string) => {
              setDebugPanel(null)
              runWithApprovalRef.current(fix)
            },
            onAskMore: () => {
              setDebugPanel(null)
              cmdK.open()
            },
          })
        : null,
      React.createElement(StickyScroll as React.ComponentType<any>, {
        tracker,
        // Phase 7: VS Code hides the sticky bar once the user has
        // scrolled back to the live prompt (viewport already shows the
        // running command). We approximate that with xterm's buffer
        // state: when `viewportY === baseY` we're pinned to the bottom.
        isAtBottom: () => {
          const term = termRef.current
          if (!term) return false
          const buf = term.buffer.active
          return buf.viewportY >= buf.baseY
        },
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
      React.createElement(RecentCommandPicker, {
        handle: recentCommandPicker,
        className: 'shogo-recent-command-picker',
      }),
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

/**
 * Phase 8 — approval confirm modal. Renders for verdict='ask' decisions.
 *
 * Four buttons:
 *   • Allow once     — run, don't remember
 *   • Always allow   — run, persist allow rule
 *   • Deny once      — drop, don't remember
 *   • Always deny    — drop, persist deny rule
 *
 * Esc dismisses (equivalent to Deny once).
 */
function ApprovalAskModal(props: {
  ask: { decision: ApprovalDecision; onResolve(ok: boolean, remember: boolean): void }
}): React.ReactElement {
  const { ask } = props
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ask.onResolve(false, false) }
      if (ev.key === 'Enter') { ev.preventDefault(); ask.onResolve(true, false) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ask])

  const btn = (label: string, primary: boolean, onClick: () => void) =>
    React.createElement('button', {
      type: 'button',
      onClick,
      style: {
        padding: '4px 12px',
        borderRadius: 4,
        border: '1px solid #3c3c3c',
        background: primary ? '#0e639c' : '#2d2d2d',
        color: '#ffffff',
        font: 'inherit',
        cursor: 'pointer',
      },
    }, label)

  return React.createElement('div', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Confirm command',
    'data-testid': 'shogo-approval-ask',
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
      font: '13px system-ui, -apple-system, sans-serif',
      color: '#cccccc',
    },
  },
    React.createElement('div', {
      style: {
        minWidth: 420,
        maxWidth: 560,
        background: '#252526',
        border: '1px solid #3c3c3c',
        borderRadius: 8,
        padding: 16,
        boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
      },
    },
      React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } },
        'Run this command?'),
      React.createElement('pre', {
        'data-testid': 'shogo-approval-ask-command',
        style: {
          background: '#1e1e1e',
          border: '1px solid #3c3c3c',
          borderRadius: 4,
          padding: '6px 10px',
          margin: '0 0 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          font: '12px ui-monospace, "SF Mono", monospace',
          color: '#dcdcaa',
        },
      }, ask.decision.command),
      React.createElement('div', {
        style: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
      },
        btn('Deny once',    false, () => ask.onResolve(false, false)),
        btn('Always deny',  false, () => ask.onResolve(false, true)),
        btn('Always allow', false, () => ask.onResolve(true, true)),
        btn('Allow once',   true,  () => ask.onResolve(true, false)),
      ),
    ),
  )
}

/**
 * Phase 8 — Debug-with-AI side panel.
 *
 * Renders the serialised `DebugContext` markdown as plain text (we don't
 * pull a markdown lib into this package — apps/desktop can swap this for
 * a fancier renderer later). Offers three actions: copy report to the
 * clipboard, ask the ⌘K palette for follow-up, close.
 */
function DebugWithAiPanel(props: {
  context: DebugContext
  onClose(): void
  onApply(fix: string): void
  onAskMore(): void
}): React.ReactElement {
  const md = React.useMemo(() => serialiseDebugContext(props.context), [props.context])

  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); props.onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [props])

  return React.createElement('aside', {
    role: 'complementary',
    'aria-label': 'Debug with AI',
    'data-testid': 'shogo-debug-with-ai',
    style: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: 380,
      zIndex: 30,
      background: '#252526',
      borderLeft: '1px solid #3c3c3c',
      color: '#cccccc',
      font: '12px system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
    },
  },
    React.createElement('header', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: '1px solid #3c3c3c', fontWeight: 600,
      },
    },
      React.createElement('span', null,
        props.context.exitCode != null && props.context.exitCode !== 0
          ? `Debug failed command (exit ${props.context.exitCode})`
          : 'Explain command'),
      React.createElement('button', {
        type: 'button',
        onClick: props.onClose,
        'aria-label': 'Close debug panel',
        style: { background: 'transparent', color: '#cccccc', border: 'none', fontSize: 18, cursor: 'pointer' },
      }, '×'),
    ),
    React.createElement('pre', {
      'data-testid': 'shogo-debug-with-ai-body',
      style: {
        flex: 1, margin: 0, padding: 12, overflow: 'auto',
        font: '12px ui-monospace, "SF Mono", monospace',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
    }, md),
    React.createElement('footer', {
      style: {
        padding: 8, borderTop: '1px solid #3c3c3c',
        display: 'flex', gap: 6, justifyContent: 'flex-end',
      },
    },
      React.createElement('button', {
        type: 'button',
        onClick: () => {
          try { navigator.clipboard?.writeText(md).catch(() => undefined) } catch { /* */ }
        },
        style: btnStyle(false),
      }, 'Copy report'),
      React.createElement('button', {
        type: 'button',
        onClick: props.onAskMore,
        style: btnStyle(false),
      }, 'Ask ⌘K…'),
      props.context.commandLine
        ? React.createElement('button', {
            type: 'button',
            onClick: () => props.onApply(props.context.commandLine),
            style: btnStyle(true),
          }, 'Re-run')
        : null,
    ),
  )
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '3px 10px',
    borderRadius: 3,
    border: '1px solid #3c3c3c',
    background: primary ? '#0e639c' : 'transparent',
    color: '#ffffff',
    font: 'inherit',
    cursor: 'pointer',
  }
}
