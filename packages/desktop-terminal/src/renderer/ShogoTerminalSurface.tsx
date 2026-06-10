// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import * as React from 'react'
import type { Terminal as XTerminal } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'
import { OscDecoder } from '@shogo/pty-core'
import { Osc633Tracker, type Command } from './osc633-tracker'
import { collectPromptAnchors, findPrevPromptLine, findNextPromptLine } from './command-navigation'
import { StickyScroll } from './sticky-scroll'
import { WriteBatcher } from './write-batcher'
import { GpuRenderer } from './gpu-renderer'
import { SearchController } from './search-popover'
import { CmdKController, CmdKPopover, type LlmClient } from './cmd-k-popover'
import { CommandHistorySource, trackerAdapter, type HistoryReader } from './history/history-sources'
import { RecentCommandPicker, useCommandPicker } from './pickers/recent-pickers'
import { getDesktopBridge } from './desktop-features'
import { MatcherEngine } from './problem-matchers'
import { TerminalContextMenu, buildVsCodeMenuGroups } from './context-menu'
import { ApprovalStore, workspaceHashOf, type ApprovalDecision } from './approval-store'
import { AgentTerminalBridge, type CommandResult, type BackgroundTask } from './agent-terminal-bridge'
import { terminalContextStore } from './terminal-context-store'
import { TerminalPersistence } from './terminal-persistence'
import { AddToChatButton, dispatchAddToChat } from './add-to-chat-button'
import { captureTerminalText, formatTerminalContextForChat } from './terminal-selection'
import { extractCommandText } from './terminal-command-text'

/**
 * Reliable clipboard write that works in Electron and web.
 * Uses Electron's native clipboard module via IPC when available,
 * falls back to navigator.clipboard API.
 */
function copyToClipboard(text: string): void {
  const bridge = (globalThis as any).shogoDesktop
  if (bridge?.clipboardWriteText) {
    // Electron: use native clipboard via IPC (always works, no permission issues)
    void bridge.clipboardWriteText(text)
    return
  }
  // Web fallback
  try {
    void navigator.clipboard?.writeText(text)
  } catch (_e) { /* noop */ }
}
import { serializeTerminalCommands } from './context-aggregator'
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
  /** Send a command and wait for it to complete (agent terminal API). */
  sendCommand?(command: string): Promise<CommandResult>
  /** Send a command without waiting for completion. */
  sendCommandBackground?(command: string): BackgroundTask
  /** Interrupt the currently running command (sends SIGINT). */
  interruptCommand?(): CommandResult | null
  /** Get recent commands from the tracker. */
  getRecentCommands?(limit?: number): Array<{ command: string }>
  /** Scroll to the prompt line of the previous command (VS Code ⌘↑). */
  scrollToPrevCommand?(): void
  /** Scroll to the prompt line of the next command (VS Code ⌘↓). */
  scrollToNextCommand?(): void
  /** Get navigation state for disabled-styling in the overflow menu. */
  getNavState?(): { commandCount: number; activeIndex: number | null; canPrev: boolean; canNext: boolean }
}

export interface ShogoTerminalSurfaceProps {
  client: SurfacePtyClient
  hidden?: boolean
  autoFocus?: boolean
  fontSize?: number
  fontFamily?: string
  enableGpu?: boolean
  fontLigatures?: boolean
  llm?: LlmClient
  projectId?: string | null
  apiBase?: string
  /** Emits shell cwd changes from OSC 633 so host chrome can show location. */
  onCwdChange?(cwd: string): void
  /**
   * Optional callbacks for context-menu items that need parent state.
   * Items without a callback render as enabled rows that no-op; pass
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
  /** Live PTY session id — used for persistence + main-process context bridge. */
  ptySessionId?: string | null
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
    fontLigatures = true,
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
    ptySessionId,
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
    /** Terminal persistence — saves command history to disk. */
    const persistenceRef = React.useRef<TerminalPersistence | null>(null)

    /** Agent terminal bridge — Promise-based sendCommand for the agent loop. */
    const bridgeRef = React.useRef<AgentTerminalBridge | null>(null)
    if (!bridgeRef.current) {
      bridgeRef.current = new AgentTerminalBridge({
        tracker,
        send: (data) => client.send(data),
        signal: (sig) => client.signal(sig),
      })
    }
    // Keep the bridge's send reference current across re-renders
    // (e.g. after terminal reconnect, the client prop changes).
    bridgeRef.current.setSend((data) => client.send(data))
    const [state, setState] = React.useState(client.state)
    const [searchController, setSearchController] = React.useState<SearchController | null>(null)
    const [searchOpen, setSearchOpen] = React.useState(false)
    const [searchQuery, setSearchQuery] = React.useState('')
    const [hostUnresponsive, setHostUnresponsive] = React.useState(false)
    const [menuPos, setMenuPos] = React.useState<{ x: number; y: number } | null>(null)
    const [hasClipboard, setHasClipboard] = React.useState(false)
    /** Phase 6: gutter-glyph click → 4-item action popover. */
    const [cmdMenu, setCmdMenu] = React.useState<{ x: number; y: number; command: Command } | null>(null)
    const [hasTerminalSelection, setHasTerminalSelection] = React.useState(false)
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
    const ptySessionIdRef = React.useRef(ptySessionId)
    ptySessionIdRef.current = ptySessionId

    const publishContextToMain = React.useCallback(() => {
      const sid = ptySessionIdRef.current
      if (!sid) return
      try {
        const snap = trackerRef.current.snapshot()
        const recent = snap.commands.filter((c) => (c.commandLine ?? '').trim().length > 0).slice(-12)
        const content = serializeTerminalCommands(recent)
        if (!content) return
        void getDesktopBridge().publishTerminalContext?.({
          sessionId: sid,
          cwd: snap.cwd,
          content,
        })
      } catch (_e) { /* non-desktop / bridge unavailable */ }
    }, [])
    const publishContextToMainRef = React.useRef(publishContextToMain)
    publishContextToMainRef.current = publishContextToMain

    const addSelectionToChat = React.useCallback(() => {
      const term = termRef.current
      if (!term) return
      const captured = captureTerminalText(term, {
        cwd: trackerRef.current.snapshot().cwd ?? null,
        maxLines: 80,
      })
      if (!captured.text.trim()) return
      dispatchAddToChat(formatTerminalContextForChat(captured))
    }, [])
    const addSelectionToChatRef = React.useRef(addSelectionToChat)
    addSelectionToChatRef.current = addSelectionToChat

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

    /**
     * runWithApproval — single chokepoint for every "run a command on
     * behalf of the user" call site (⌘K Tab/Enter, gutter Re-run, Quick
     * Fix run-action). Routes through ApprovalStore:
     *   • verdict 'allow' → fire-and-forget client.send
     *   • verdict 'deny'  → log + drop (rule explains why)
     *   • verdict 'ask'   → render modal, resume on user click
     */
    const runWithApprovalRef = React.useRef<(command: string) => void>(() => undefined)
    // Keyboard-intercepted command history (current session only, newest first)
    const keyboardHistoryRef = React.useRef<string[]>([])

    const updateNavIndicatorRef = React.useRef<(term: import('@xterm/xterm').Terminal) => void>(() => {})

    interface CommandBlock {
      id: number
      command: string
      promptLine: number
      endLine: number
      exitCode: number | null
    }
    let blockIdSeq = 0
    const commandBlocksRef = React.useRef<CommandBlock[]>([])
    const activeNavIndexRef = React.useRef<number | null>(null)
    const clearGutterRef = React.useRef<(() => void) | null>(null)
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
        try { return getDesktopBridge().llm ?? noopLlm } catch (_e) { return noopLlm }
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
    const [commandHistorySource] = React.useState(() => {
      let reader: HistoryReader | undefined
      try {
        const bridge = getDesktopBridge()
        if (bridge.readShellHistory) {
          reader = {
            readZsh:  async () => (await bridge.readShellHistory!()).zsh,
            readBash: async () => (await bridge.readShellHistory!()).bash,
            readFish: async () => (await bridge.readShellHistory!()).fish,
          }
        }
      } catch { /* non-desktop — no reader */ }
      return new CommandHistorySource({ tracker: trackerAdapter(tracker), reader })
    })
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
      } catch (_e) {
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
          fontLigatures,
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

        // ── Gutter overlay ──────────────────────────────────────────────
        // A fixed-width strip to the LEFT of the xterm canvas that holds
        // the command-state dots.  We deliberately avoid xterm's
        // registerDecoration for the visible dot because that API anchors
        // to cell coordinates — it overlaps terminal text when the WebGL
        // renderer is active (WebGL canvas ignores CSS padding on .xterm-rows).
        const GUTTER_W = 16  // px – one cell-width-ish gutter
        const xtermEl = term.element!  // the .xterm root element
        xtermEl.style.marginLeft = `${GUTTER_W}px`
        // Refit so cols are recalculated against the narrower available width
        requestAnimationFrame(() => { try { fit.fit() } catch {} })

        // The gutterEl is absolutely positioned over the left strip of the
        // container so it appears to the left of the shifted xterm canvas.
        container.style.position = container.style.position || 'relative'
        const gutterEl = document.createElement('div')
        Object.assign(gutterEl.style, {
          position: 'absolute',
          left: '6px',    // container padding-left
          top:  '4px',    // container padding-top
          width: `${GUTTER_W}px`,
          bottom: '4px',
          zIndex: '30',
          pointerEvents: 'none',
          overflow: 'hidden',
        } as CSSStyleDeclaration)
        container.appendChild(gutterEl)
        container.addEventListener('contextmenu', (ev: MouseEvent) => {
          const rect = container.getBoundingClientRect()
          const relX = ev.clientX - rect.left
          if (relX > GUTTER_W + 12) return
          ev.preventDefault()
          ev.stopPropagation()
          const blocks = commandBlocksRef.current
          if (blocks.length === 0) return
          const term = termRef.current
          if (!term) return
          const cellH = getCellHeight()
          const viewportY = term.buffer.active.viewportY
          const clickY = ev.clientY - rect.top
          let bestIdx = 0
          let bestDist = Infinity
          for (let i = 0; i < blocks.length; i++) {
            const relRow = blocks[i].promptLine - viewportY
            const dotCenterY = relRow * cellH + cellH / 2
            const dist = Math.abs(clickY - dotCenterY)
            if (dist < bestDist) {
              bestDist = dist
              bestIdx = i
            }
          }
          const snap = tracker.snapshot()
          if (bestIdx < snap.commands.length) {
            setCmdMenu({ x: ev.clientX, y: ev.clientY, command: snap.commands[bestIdx] })
          }
        })

        // ── Dot helpers ─────────────────────────────────────────────────
        // Returns the rendered cell height in CSS pixels (robust across
        // both WebGL and DOM renderers and different device pixel ratios).
        function getCellHeight(): number {
          try {
            const dims = (term as any)._core?._renderService?.dimensions
            const h = dims?.css?.cell?.height ?? dims?.device?.cell?.height
            if (h && h > 4) return h
          } catch { /* ignore */ }
          // Fallback: divide available container height by row count
          const available = (container?.clientHeight ?? 0) - 8
          return available > 0 && term.rows > 0 ? available / term.rows : (term.options.fontSize ?? 13) * 1.2
        }

        function makeDotSvg(running: boolean, success: boolean | null): string {
          if (running || success === null) {
            // Running → small gray circle
            return `<svg viewBox="0 0 8 8" width="8" height="8" style="display:block">
              <circle cx="4" cy="4" r="3.5" fill="#4fc3f7" opacity="0.85"/>
            </svg>`
          }
          if (success) {
            // Success → VS Code blue circle
            return `<svg viewBox="0 0 8 8" width="8" height="8" style="display:block">
              <circle cx="4" cy="4" r="3.5" fill="#007acc" opacity="0.9"/>
            </svg>`
          }
          // Error → red circle with ✕
          return `<svg viewBox="0 0 10 10" width="10" height="10" style="display:block">
            <circle cx="5" cy="5" r="4.5" fill="#f14c4c"/>
            <line x1="3" y1="3" x2="7" y2="7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="7" y1="3" x2="3" y2="7" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
          </svg>`
        }

        interface GutterDot {
          dotEl:  HTMLDivElement
          marker: { line: number; isDisposed: boolean }
          rulerDec: { options: object; onRender?: (fn: (el: HTMLElement) => void) => void } | null
        }
        const gutterDots: GutterDot[] = []

        // Wire clearGutterRef so the imperative clear() handle can
        // remove all gutter dots when the user hits the Clear button
        // or runs `clear` in the shell.
        clearGutterRef.current = () => {
          for (const dot of gutterDots) {
            try { gutterEl.removeChild(dot.dotEl) } catch {}
            if (dot.rulerDec && typeof (dot.rulerDec as any).dispose === 'function') {
              try { (dot.rulerDec as any).dispose() } catch {}
            }
          }
          gutterDots.length = 0
          commandBlocksRef.current = []
          activeNavIndexRef.current = null
        }

        function positionDot(dot: GutterDot): void {
          if (dot.marker.isDisposed) { dot.dotEl.style.display = 'none'; return }
          const cellH = getCellHeight()
          const viewportY = term.buffer.active.viewportY
          const relRow = dot.marker.line - viewportY
          const visible = relRow >= 0 && relRow < term.rows
          dot.dotEl.style.display = visible ? 'flex' : 'none'
          if (visible) {
            // Vertically centre the dot at the middle of its terminal row
            dot.dotEl.style.top = `${relRow * cellH + cellH * 0.5}px`
          }
        }

        function repositionAll(): void {
          for (let i = gutterDots.length - 1; i >= 0; i--) {
            const dot = gutterDots[i]
            if (dot.marker.isDisposed) {
              try { gutterEl.removeChild(dot.dotEl) } catch {}
              gutterDots.splice(i, 1)
            } else {
              positionDot(dot)
            }
          }
          updateNavIndicator(term)
        }

        const navIndicatorEl = document.createElement('div') as HTMLDivElement
        Object.assign(navIndicatorEl.style, {
          position: 'absolute',
          left: '3px',
          width: '3px',
          height: '0',
          background: '#007acc',
          borderRadius: '1px',
          transition: 'top 120ms ease-out, opacity 120ms ease-out',
          opacity: '0',
          pointerEvents: 'none',
          zIndex: '31',
        } as CSSStyleDeclaration)
        gutterEl.appendChild(navIndicatorEl)

        function updateNavIndicator(term: XTerminal): void { updateNavIndicatorRef.current(term) }
        function updateNavIndicatorInner(term: XTerminal): void {
          const navIdx = activeNavIndexRef.current
          const blocks = commandBlocksRef.current
          if (navIdx === null || navIdx < 0 || navIdx >= blocks.length) {
            navIndicatorEl.style.opacity = '0'
            return
          }
          const block = blocks[navIdx]
          const cellH = getCellHeight()
          const viewportY = term.buffer.active.viewportY
          const relRow = block.promptLine - viewportY
          const visible = relRow >= 0 && relRow < term.rows
          if (!visible) {
            navIndicatorEl.style.opacity = '0'
            return
          }
          navIndicatorEl.style.top = `${relRow * cellH}px`
          navIndicatorEl.style.height = `${cellH}px`
          navIndicatorEl.style.opacity = '1'
        }

        updateNavIndicatorRef.current = updateNavIndicatorInner
        term.onScroll(() => repositionAll())
        term.onResize(() => requestAnimationFrame(repositionAll))

        term.onSelectionChange(() => {
          setHasTerminalSelection((term.getSelection() ?? '').trim().length > 0)
        })

        term.attachCustomKeyEventHandler((ev) => {
          const isMac = navigator.platform.toLowerCase().includes('mac')
          const mod = isMac ? ev.metaKey : ev.ctrlKey
          if (mod && ev.key.toLowerCase() === 'l' && !ev.shiftKey && !ev.altKey) {
            ev.preventDefault()
            addSelectionToChatRef.current()
            return false
          }
          return true
        })

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

        // ── command decorations ──────────────────────────────────────────
        // Track pending decorations: commandId → { decoration, element }
        // so we can swap in the correct color once the exit code arrives.
        interface PendingDecoration {
          decoration: ReturnType<typeof term.registerDecoration> & object
          el: HTMLElement | null
        }
        const pendingDecorations = new Map<number, PendingDecoration>()



        const offTracker = tracker.on((ev) => {
          if (ev.kind === 'command-started') {
            activeCommandRef.current = ev.command.id
            commandOutputRef.current.set(ev.command.id, [])

            // ── Gutter dot (visible left-strip marker) ─────────────────
            const rawMarker =
              (ev.command.promptMarker as any) ??
              (ev.command.startMarker as any) ??
              term.registerMarker(0)
            if (rawMarker) {
              const dotEl = document.createElement('div') as HTMLDivElement
              Object.assign(dotEl.style, {
                position: 'absolute',
                left: '0',
                width: '100%',
                transform: 'translateY(-50%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'opacity 150ms',
              } as CSSStyleDeclaration)
              dotEl.innerHTML = makeDotSvg(true, null)
              gutterEl.appendChild(dotEl)
              const dot: GutterDot = { dotEl, marker: rawMarker, rulerDec: null }
              gutterDots.push(dot)
              positionDot(dot)
              dotEl.style.cursor = 'pointer'
              dotEl.style.pointerEvents = 'auto'
              dotEl.addEventListener('click', (clickEv: MouseEvent) => {
                clickEv.stopPropagation()
                setCmdMenu({ x: clickEv.clientX, y: clickEv.clientY, command: ev.command })
              })
              dotEl.addEventListener('contextmenu', (clickEv: MouseEvent) => {
                clickEv.preventDefault()
                clickEv.stopPropagation()
                setCmdMenu({ x: clickEv.clientX, y: clickEv.clientY, command: ev.command })
              })
              // Overview-ruler indicator in the scrollbar (width:0 → no visible cell overlay)
              try {
                const dec = term.registerDecoration({
                  marker: rawMarker,
                  width: 0,
                  overviewRulerOptions: { color: '#4fc3f7cc', position: 'left' },
                })
                if (dec) dot.rulerDec = dec as any
              } catch { /* allowProposedApi not enabled */ }
              pendingDecorations.set(ev.command.id, { decoration: dot.rulerDec as any, el: dotEl })
            }
          }
          if (ev.kind === 'cwd-changed') {
            onCwdChangeRef.current?.(ev.cwd)
          }
          if (ev.kind === 'command-finished') {
            const blocks = commandBlocksRef.current
            if (blocks.length > 0) {
              blocks[blocks.length - 1].exitCode = ev.command.exitCode ?? 0
            }
            const output = commandOutputRef.current.get(ev.command.id)?.join('') ?? ''
            activeCommandRef.current = null

            // Update gutter dot color when command finishes
            const pending = pendingDecorations.get(ev.command.id)
            if (pending) {
              const dotEl = pending.el as HTMLDivElement | null
              const exitCode = ev.command.exitCode
              const success = exitCode === null || exitCode === 0
              if (dotEl) dotEl.innerHTML = makeDotSvg(false, success)
              // Update overview ruler color
              try {
                const rulerColor = success ? '#007acccc' : '#f14c4ccc'
                ;(pending.decoration as any)?.options &&
                  ((pending.decoration as any).options = {
                    ...(pending.decoration as any).options,
                    overviewRulerOptions: { color: rulerColor, position: 'left' },
                  })
              } catch { /* immutable in some xterm builds */ }
              pendingDecorations.delete(ev.command.id)
            }

            void publishTerminalDiagnostics(projectId, apiBase, ev.command.id, ev.command.exitCode, output, matcherRef.current)
            // Persistence: every finished command is a good time to
            // checkpoint scrollback + cwd to the snapshot store.
            scheduleSnapshotSave()
            publishContextToMainRef.current()
            // Persist to disk for agent terminal_read tool
            persistenceRef.current?.persistSnapshot(tracker.snapshot().commands, tracker.snapshot().cwd ?? null).catch(() => {})
          }
        })
        publishContextToMainRef.current()
        // Terminal persistence — saves command history to disk for agent read-back
        const persistenceId = ptySessionIdRef.current ?? `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        persistenceRef.current = new TerminalPersistence({
          terminalId: persistenceId,
          dir: '.shogo/terminals',
          flushIntervalMs: 0, // Manual flush only — on command finish + terminal close
        })

        // Track commands typed by the user via keyboard intercept.
        // This gives current-session history even without OSC 633;E shell
        // integration (which is the only source for tracker.commandLine).
        let kbBuffer = ''
        const MAX_KB_HISTORY = 500

        term.onData((data) => {
          if (data === '\r') {
            const cmd = kbBuffer.trim()
            if (cmd) {
              const hist = keyboardHistoryRef.current
              const idx = hist.indexOf(cmd)
              if (idx !== -1) hist.splice(idx, 1)
              hist.unshift(cmd)
              if (hist.length > MAX_KB_HISTORY) hist.length = MAX_KB_HISTORY
            }
            kbBuffer = ''
            const buf = term.buffer.active
            const currentLine = buf.cursorY + buf.viewportY
            const blocks = commandBlocksRef.current
            if (blocks.length > 0) {
              const last = blocks[blocks.length - 1]
              if (last.endLine === last.promptLine) {
                last.endLine = currentLine
              }
            }
            blocks.push({
              id: ++blockIdSeq,
              command: cmd,
              promptLine: currentLine,
              endLine: currentLine,
              exitCode: null,
            })
            activeNavIndexRef.current = null
            updateNavIndicator(term)
          } else if (data === '\x7f' || data === '\x08') {
            kbBuffer = kbBuffer.slice(0, -1)
          } else if (data.length === 1 && data >= ' ') {
            kbBuffer += data
          }
          client.send(data)
        })
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
          // Feed raw output to the bridge for streaming (ANSI-stripped internally)
          if (decoded.passthrough.byteLength > 0) {
            bridgeRef.current?.feedOutput(new TextDecoder().decode(decoded.passthrough))
          }
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
        // First-terminal stagger fix: the bottom panel may still be
        // animating when Terminal 1 opens, causing fit.fit() to measure
        // a slightly-too-narrow column count. Schedule a confirmatory
        // refit one animation frame later — by then the layout has
        // settled and the shell receives the correct SIGWINCH column
        // count, eliminating the truncated-username wrap artifact.
        requestAnimationFrame(() => { fitRef.current?.fit() })
        if (autoFocus && !hidden) term.focus()

        // Publish terminal context to the module-level store so the chat
        // panel can auto-inject terminal context into messages.
        terminalContextStore.publish({
            tracker,
            bridge: bridgeRef.current ?? undefined,
            cwd: tracker.snapshot().cwd ?? null,
            publishedAt: Date.now(),
          })

        // Teardown: remove the gutter overlay and its children
        const removeGutter = () => {
          try { container.removeChild(gutterEl) } catch {}
          gutterDots.length = 0
          commandBlocksRef.current = []
          activeNavIndexRef.current = null
        }

        cleanup = () => {
          removeGutter()
          // Phase 10: flush one last snapshot before tearing down the
          // terminal — captures any post-last-command typing/output.
          flushSnapshot()
          offData(); offExit(); offTrunc(); offError()
          offTracker()
          pendingDecorations.clear()
          ro.disconnect()
          batcher.dispose()
          gpu.dispose()
          search.dispose?.()
          bridgeRef.current?.dispose()
          // Persist final snapshot before teardown
          void persistenceRef.current?.dispose(tracker.snapshot().commands, tracker.snapshot().cwd ?? null)
          persistenceRef.current = null
          term.dispose()
          termRef.current = null
          fitRef.current = null
          setSearchController(null)
          terminalContextStore.withdraw()
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
      const term = termRef.current
      if (!term) return
      try {
        ;(term.options as Record<string, unknown>).fontLigatures = fontLigatures
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[shogo-term] fontLigatures update failed:', e)
      }
    }, [fontLigatures])

    // Search / ⌘K shortcuts on the host wrapper; ⌘L is handled via
    // xterm.attachCustomKeyEventHandler so it fires while the xterm
    // textarea has focus (the common case).
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
      clear: () => { clearGutterRef.current?.(); termRef.current?.clear() },
      focus: () => termRef.current?.focus(),
      refit: () => fitRef.current?.fit(),
      openFind: () => {
        setSearchOpen(true)
      },
      openRecent: () => recentCommandPicker.open(),
      sendCommand: (command: string) => { const b = bridgeRef.current; if (!b) throw new Error("terminal disposed"); return b.sendCommand(command) },
      sendCommandBackground: (command: string) => { const b = bridgeRef.current; if (!b) throw new Error("terminal disposed"); return b.sendCommandBackground(command) },
      interruptCommand: () => { const b = bridgeRef.current; if (!b) throw new Error("terminal disposed"); b.interruptCommand() },
      getRecentCommands: (limit = 500) => {
        // Keyboard-tracked (current session, always accurate) come first,
        // then fall back to CommandHistorySource for older/disk commands.
        const fromSource = bridgeRef.current?.getRecentCommands(limit) ?? []
        const merged: Array<{ command: string }> = []
        const seen = new Set<string>()
        for (const cmd of keyboardHistoryRef.current) {
          if (seen.has(cmd)) continue
          seen.add(cmd)
          merged.push({ command: cmd })
        }
        for (const e of fromSource) {
          const cmdText = (e as any).commandLine ?? (e as any).command ?? ''
          if (!cmdText || seen.has(cmdText)) continue
          seen.add(cmdText)
          merged.push({ command: cmdText })
        }
        return merged.slice(0, limit)
      },
      getNavState: () => {
        const blocks = commandBlocksRef.current
        const idx = activeNavIndexRef.current
        return {
          commandCount: blocks.length,
          activeIndex: idx,
          canPrev: blocks.length > 1,
          canNext: blocks.length > 1,
        }
      },
      scrollToPrevCommand: () => {
        const term = termRef.current
        if (!term) return
        const blocks = commandBlocksRef.current
        if (blocks.length === 0) return
        const viewportY = term.buffer.active.viewportY
        const currentIdx = activeNavIndexRef.current
        let targetIdx: number
        if (currentIdx === null) {
          targetIdx = -1
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].promptLine < viewportY) { targetIdx = i; break }
          }
          if (targetIdx === -1) targetIdx = Math.max(0, blocks.length - 2)
        } else {
          targetIdx = currentIdx - 1
          if (targetIdx < 0) targetIdx = 0
        }
        activeNavIndexRef.current = targetIdx
        term.scrollToLine(blocks[targetIdx].promptLine)
        term.focus()
        updateNavIndicatorRef.current(term)
      },
      scrollToNextCommand: () => {
        const term = termRef.current
        if (!term) return
        const blocks = commandBlocksRef.current
        if (blocks.length === 0) return
        const currentIdx = activeNavIndexRef.current
        if (currentIdx === null) return
        let targetIdx = currentIdx + 1
        if (targetIdx >= blocks.length) targetIdx = blocks.length - 1
        activeNavIndexRef.current = targetIdx
        term.scrollToLine(blocks[targetIdx].promptLine)
        term.focus()
        updateNavIndicatorRef.current(term)
      },
    }), [recentCommandPicker, tracker])

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
      } catch (_e) {
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
            copyToClipboard(selection)
          } catch (_e) { /* noop */ }
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
          } catch (_e) {
            copyToClipboard(selection)
          }
        },
        onPaste: async () => {
          try {
            const t = await navigator.clipboard?.readText()
            if (t) client.send(t)
          } catch (_e) { /* noop */ }
        },
        onSelectAll: () => term?.selectAll(),
        onFind: () => setSearchOpen(true),
        onKill: () => client.signal('KILL'),
        onRename: () => onRename?.(),
        onConfigure: () => onConfigure?.(),
        onSplit: () => onSplit?.(),
        onClear: () => { clearGutterRef.current?.(); term?.clear() },
      })
    }, [menuPos, hasClipboard, state, tracker, client, contextColors, contextIcons, onChangeColor, onChangeIcon, onRename, onConfigure, onSplit])

    return React.createElement('div', {
      'data-shogo-terminal-surface': 'true',
      'data-shogo-terminal-container': 'true',
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
        [data-shogo-terminal-surface] .xterm-rows {
          padding-right: 6px;
        }
        [data-shogo-terminal-surface] .xterm-decoration-container {
          overflow: visible !important;
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
      cmdMenu
        ? React.createElement(TerminalContextMenu, {
            groups: (() => {
              const cmd = cmdMenu.command
              const cmdText = extractCommandText(cmd, termRef.current)
              const hasOutput = !!(cmd.startMarker && cmd.endMarker)
              const exitCode = cmd.exitCode
              const success = exitCode === null || exitCode === 0
              const statusLabel = exitCode == null ? '' : success ? ' (✓ success)' : ` (✗ exit ${exitCode})`
              return [
                [
                  {
                    label: 'Attach To Chat',
                    disabled: !cmdText,
                    onSelect: () => {
                      const term = termRef.current
                      if (!term || !cmdText) return
                      let output = ''
                      if (hasOutput && cmd.startMarker && cmd.endMarker) {
                        const base = term.buffer.active.baseY
                        const rows: string[] = []
                        for (let line = cmd.startMarker.line; line <= cmd.endMarker.line; line += 1) {
                          rows.push(term.buffer.active.getLine(line - base)?.translateToString(true) ?? '')
                        }
                        output = rows.join('\n').trimEnd()
                      }
                      const context = [
                        '[CONTEXT — auto-generated, do not cite directly]',
                        '## Terminal Command',
                        `**Command:** ${cmdText}`,
                        `**Exit Code:** ${exitCode ?? 'unknown'}`,
                        output ? `\n**Output:**\n\`\`\`\n${output}\n\`\`\`` : '',
                        '[END CONTEXT]',
                      ].filter(Boolean).join('\n')
                      dispatchAddToChat(context)
                    },
                  },
                ],
                [
                  {
                    label: 'Rerun Command',
                    disabled: !cmdText,
                    onSelect: () => {
                      if (!cmdText) return
                      const t = termRef.current
                      if (t) {
                        t.focus()
                        t.paste(cmdText + '\r')
                      }
                    },
                  },
                  {
                    label: 'Copy Command',
                    shortcut: '⌘C',
                    disabled: !cmdText,
                    onSelect: () => {
                      if (!cmdText) return
                      copyToClipboard(cmdText)
                    },
                  },
                ],
                [
                  {
                    label: 'Run Recent Command',
                    shortcut: '⌃⌥R',
                    onSelect: () => { window.dispatchEvent(new CustomEvent('shogo:terminal:run-recent-command')) },
                  },
                  {
                    label: 'Go To Recent Directory',
                    shortcut: '⌘G',
                    onSelect: () => { window.dispatchEvent(new CustomEvent('shogo:terminal:go-recent-directory')) },
                  },
                ],
              ]
            })(),
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
      React.createElement(AddToChatButton, {
        hasContent: hasTerminalSelection,
        onAddToChat: addSelectionToChat,
      }),
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

