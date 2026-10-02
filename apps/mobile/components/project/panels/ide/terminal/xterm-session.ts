// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * XtermSession — couples a single `@xterm/xterm` Terminal to a single
 * PtyClient.
 *
 *   xterm.onData (user keystrokes / paste) → ptyClient.send()
 *   xterm.onResize (FitAddon recompute)    → ptyClient.resize()
 *   ptyClient.onData                       → xterm.write()
 *   ptyClient.onTruncated                  → xterm.write(banner)
 *   ptyClient.onExit                       → xterm.write(banner)
 *
 * Lazy-imports xterm + addons so this module stays cheap to bundle for
 * non-IDE entry points (e.g. the marketing site uses the same `mobile`
 * package). Importers must call `await session.attach(div)` to actually
 * render anything.
 *
 * Lifecycle:
 *   new XtermSession(client)
 *   await session.attach(container) // renders, wires both directions
 *   session.fit()                   // re-runs FitAddon on resize
 *   session.dispose()               // tears down xterm + listeners
 */

import type { PtyClientLike } from './pty-factory'
import { findFileLinks, OPEN_FILE_EVENT, type OpenFileDetail } from './file-links'
import { DARK_PLUS_THEME, TERMINAL_DEFAULTS, type XtermTheme } from './xterm-theme'
// xterm.js relies on this stylesheet to (a) size the row container and (b)
// clip-hide the input proxy `<textarea>`. Without it, the textarea renders
// unstyled at 0,0 and the rows have no height — the panel looks blank
// except for a stray white input box. Side-effect import only.
import '@xterm/xterm/css/xterm.css'

// We import the runtime types lazily; these `type`-only imports cost nothing
// at runtime. Web-only — xterm.js bundles a Canvas/WebGL renderer.
type XTerminal = import('@xterm/xterm').Terminal
type XFitAddon = import('@xterm/addon-fit').FitAddon
type XSearchAddon = import('@xterm/addon-search').SearchAddon
type IMarker  = import('@xterm/xterm').IMarker

export interface XtermSessionOptions {
  fontFamily?: string
  fontSize?: number
  fontLigatures?: boolean
  theme?: XtermTheme
  /** ⌘/Ctrl+F inside the terminal — the host shows its find bar. */
  onFindRequest?: () => void
}

export class XtermSession {
  private term: XTerminal | null = null
  private fitAddon: XFitAddon | null = null
  private searchAddon: XSearchAddon | null = null
  private container: HTMLElement | null = null
  private unsubData: (() => void) | null = null
  private unsubExit: (() => void) | null = null
  private unsubTrunc: (() => void) | null = null
  private unsubResize: (() => void) | null = null
  private disposed = false
  private _clearedInitialStale = false
  private banneredExit = false
  private commandMarkers: IMarker[] = []
  private sentLines: string[] = []
  private currentInputBuffer = ''
  private static readonly MAX_HISTORY = 500
  private commandBlocks: Array<{ id: number; command: string; promptLine: number; endLine: number; exitCode: number | null }> = []
  private blockIdSeq = 0
  private activeNavIndex: number | null = null

  constructor(
    private readonly client: PtyClientLike,
    private readonly opts: XtermSessionOptions = {},
  ) {}

  /** Attach to a DOM container. Idempotent: re-attaching is a no-op. */
  async attach(container: HTMLElement): Promise<void> {
    if (this.disposed) return
    if (this.term) return
    this.container = container

    // Lazy-load to keep non-IDE bundles slim.
    const [xtermMod, fitMod, linksMod, searchMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-search'),
    ])
    if (this.disposed) return

    const term: XTerminal = new xtermMod.Terminal({
      ...TERMINAL_DEFAULTS,
      fontFamily: this.opts.fontFamily ?? TERMINAL_DEFAULTS.fontFamily,
      fontSize: this.opts.fontSize ?? TERMINAL_DEFAULTS.fontSize,
      fontLigatures: this.opts.fontLigatures ?? TERMINAL_DEFAULTS.fontLigatures,
      theme: this.opts.theme ?? DARK_PLUS_THEME,
    } as unknown as ConstructorParameters<typeof xtermMod.Terminal>[0])
    this.term = term

    const fitAddon: XFitAddon = new fitMod.FitAddon()
    term.loadAddon(fitAddon)
    this.fitAddon = fitAddon

    const linksAddon = new linksMod.WebLinksAddon()
    term.loadAddon(linksAddon)

    const searchAddon: XSearchAddon = new searchMod.SearchAddon()
    term.loadAddon(searchAddon)
    this.searchAddon = searchAddon
    // ⌘F (mac) / Ctrl+F: open the find bar instead of sending ^F to the shell.
    // Click `file.ts:12:5` in output to open the file at that position.
    term.registerLinkProvider({
      provideLinks: (y: number, cb: (links: any[] | undefined) => void) => {
        const buf = term.buffer.active.getLine(y - 1)
        if (!buf) return cb(undefined)
        const matches = findFileLinks(buf.translateToString(true))
        if (matches.length === 0) return cb(undefined)
        cb(matches.map((m) => ({
          text: m.text,
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m.length, y } },
          decorations: { underline: true, pointerCursor: true },
          activate: (e: MouseEvent) => {
            if (!(e.metaKey || e.ctrlKey)) return
            window.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, {
              detail: { path: m.path, line: m.line, column: m.column },
            }))
          },
        })))
      },
    })
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // ⌘K clears the terminal (macOS convention; also in the tab menu).
      if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        term.clear()
        return false
      }
      if (
        e.type === 'keydown' &&
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey &&
        (e.key === 'f' || e.key === 'F') &&
        this.opts.onFindRequest
      ) {
        e.preventDefault()
        this.opts.onFindRequest()
        return false
      }
      return true
    })

    term.open(container)
    try { fitAddon.fit() } catch { /* container may be zero-size at open */ }

    // Wire xterm → PTY. Record a command-boundary marker when the user
    // presses Enter so "Scroll to Previous/Next Command" has positions to jump to.
    term.onData((data: string) => {
      if (data === '\r') {
        const m = term.registerMarker(0)
        if (m) {
          m.onDispose(() => {
            this.commandMarkers = this.commandMarkers.filter((x) => x !== m)
          })
          this.commandMarkers.push(m)
        }
        // Record the command typed since last Enter (skip empty / whitespace-only)
        const cmd = this.currentInputBuffer.trim()
        if (cmd) {
          // Dedup: move to front if already present
          this.sentLines = [cmd, ...this.sentLines.filter((l) => l !== cmd)]
          if (this.sentLines.length > XtermSession.MAX_HISTORY) {
            this.sentLines.length = XtermSession.MAX_HISTORY
          }
          const buf = term.buffer.active
          const currentLine = buf.cursorY + buf.viewportY
          if (this.commandBlocks.length > 0) {
            const last = this.commandBlocks[this.commandBlocks.length - 1]
            if (last.endLine === last.promptLine) last.endLine = currentLine
          }
          this.commandBlocks.push({
            id: ++this.blockIdSeq,
            command: cmd,
            promptLine: currentLine,
            endLine: currentLine,
            exitCode: null,
          })
          this.activeNavIndex = null
        }
        this.currentInputBuffer = ''
      } else if (data === '\x7f' || data === '\x08') {
        // Backspace / DEL
        this.currentInputBuffer = this.currentInputBuffer.slice(0, -1)
      } else if (data.length === 1 && data >= ' ') {
        // Printable ASCII only — skip control / escape sequences
        this.currentInputBuffer += data
      }
      this.client.send(data)
    })
    term.onResize((dims: { cols: number; rows: number }) => {
      this.client.resize(dims.cols, dims.rows)
    })

    // Wire PTY → xterm. Set listeners AFTER the terminal is ready so we
    // don't drop bytes that arrive during xterm.open().
    this.unsubData = this.client.onData((b: Uint8Array) => term.write(b))
    this.unsubExit = this.client.onExit((info) => {
      // Only render the banner once even if onExit fires more than once
      // (e.g. transient reconnect oddity).
      if (this.banneredExit) return
      this.banneredExit = true
      const tag = info.signal != null ? ` (signal ${info.signal})` : ''
      const codeStr = info.code == null ? '?' : String(info.code)
      term.write(`\r\n\x1b[2;90m[shell exited with code ${codeStr}${tag}]\x1b[0m\r\n`)
    })
    this.unsubTrunc = this.client.onTruncated(() => {
      term.write(`\x1b[2;90m[scrollback truncated — older output dropped]\x1b[0m\r\n`)
    })

    // Sync initial size *after* fit() so the server matches the rendered grid.
    this.client.resize(term.cols, term.rows)

    // Deferred re-fit: correct any column count computed while the panel was
    // still mid open-animation. Two rAFs guarantees the browser has committed
    // the final layout dimensions before FitAddon reads clientWidth.
    //
    // If the container size changed, we clear the terminal buffer so the
    // shell's initial prompt (which was rendered at the wrong width and may
    // be wrapped/garbled) is removed. The subsequent resize causes the shell
    // to redraw its prompt at the correct dimensions on a clean screen.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.disposed) return
        // Mark initial sizing as complete — future resize events should
        // NOT auto-clear (the user may have meaningful content).
        this._clearedInitialStale = true
        const prevCols = term.cols
        const prevRows = term.rows
        try { this.fitAddon?.fit() } catch {}
        if (term.cols !== prevCols || term.rows !== prevRows) {
          // Send CR to PTY so zsh accepts the empty input line,
          // preventing PROMPT_EOL_MARK ("%") from appearing after the clear.
          this.client.send('\r')
          term.clear()
          this.client.resize(term.cols, term.rows)
        }
      })
    })
  }

  /** Re-fit on container resize. No-op before attach. */
  fit(): void {
    // A resize can fire before `attach()` has set `this.term` (attach is
    // async — it awaits the lazy xterm import), or after teardown. Bail so
    // `this.term.cols` can't throw "Cannot read properties of null".
    if (this.disposed || !this.term) return
    // FitAddon.proposeDimensions() returns null when the container is
    // detached or zero-size (collapsed panel / hidden split), and xterm then
    // throws reading `.cols`. Skip until the container is actually laid out.
    const el = this.container
    if (el && (!el.isConnected || el.clientWidth === 0 || el.clientHeight === 0)) return
    const prevCols = this.term.cols
    const prevRows = this.term.rows
    try { this.fitAddon?.fit() } catch {}
    // On the very first size correction (panel open animation settling),
    // clear stale prompt output that was rendered at the wrong width.
    if (!this._clearedInitialStale && (this.term.cols !== prevCols || this.term.rows !== prevRows)) {
      this._clearedInitialStale = true
      // Send CR to PTY so zsh accepts the empty input line,
      // preventing PROMPT_EOL_MARK ("%") from appearing after the clear.
      this.client.send('\r')
      this.term.clear()
    }
  }

  /**
   * BUG-012 — live update fontFamily / fontSize without tearing the
   * session down. xterm@5 exposes `term.options.fontFamily` as a live
   * setter that internally invalidates the glyph cache and re-renders
   * the buffer. We then re-fit so the cell grid matches the new metrics.
   *
   * Either argument can be undefined to leave it untouched. No-op if
   * disposed. If called PRE-attach we mutate `this.opts` so the next
   * `attach()` picks up the new value via the existing closure path —
   * the test `setFont before attach is honoured at attach()` pins this.
   */
  /** Swap the colour palette live (IDE light/dark toggle) — keeps scrollback. */
  setTheme(theme: XtermTheme): void {
    if (this.disposed) return
    this.opts.theme = theme
    if (!this.term) return
    try {
      ;(this.term.options as unknown as { theme: XtermTheme }).theme = { ...theme }
    } catch { /* terminal mid-dispose */ }
  }

  setFont(fontFamily?: string, fontSize?: number): void {
    if (this.disposed) return
    const opts = this.opts as XtermSessionOptions
    if (fontFamily !== undefined) opts.fontFamily = fontFamily
    if (fontSize !== undefined) opts.fontSize = fontSize
    const term = this.term
    if (!term) return
    try {
      // `term.options` is a Proxy in xterm@5 — assigning to a sub-key
      // triggers the same renderer invalidation as `term.setOption` did
      // in v4. Cast guarded against future xterm type tightening.
      if (fontFamily !== undefined) {
        ;(term.options as unknown as { fontFamily: string }).fontFamily = fontFamily
      }
      if (fontSize !== undefined) {
        ;(term.options as unknown as { fontSize: number }).fontSize = fontSize
      }
      this.fitAddon?.fit()
    } catch {
      // Unsupported runtime — keep old font on screen. A subsequent
      // remount picks up the new value via `this.opts`.
    }
  }

  /**
   * Live-update fontLigatures without tearing down the session.
   * If called before attach(), persists into opts so attach() picks it up.
   */
  setLigatures(enabled: boolean): void {
    if (this.disposed) return
    ;(this.opts as XtermSessionOptions).fontLigatures = enabled
    const term = this.term
    if (!term) return
    try {
      ;(term.options as unknown as { fontLigatures: boolean }).fontLigatures = enabled
    } catch {
      // Unsupported runtime — takes effect on next remount via this.opts.
    }
  }

  /** Find in the scrollback. Returns whether anything matched. */
  find(query: string, direction: 'next' | 'prev' = 'next', opts: { caseSensitive?: boolean; regex?: boolean } = {}): boolean {
    if (this.disposed || !this.searchAddon || !query) return false
    const o = { caseSensitive: !!opts.caseSensitive, regex: !!opts.regex, incremental: false }
    try {
      return direction === 'next' ? this.searchAddon.findNext(query, o) : this.searchAddon.findPrevious(query, o)
    } catch {
      return false
    }
  }

  clearFind(): void {
    try { this.searchAddon?.clearDecorations() } catch { /* ignore */ }
  }

  /** Programmatic clear (keeps the shell alive, just blanks the view). */
  clear(): void {
    if (this.disposed) return
    this.term?.clear()
  }

  /** Move keyboard focus into the terminal. */
  focus(): void {
    if (this.disposed) return
    this.term?.focus()
  }

  /** Returns the list of commands sent to the PTY in this session (newest first). */
  getSentLines(): string[] { return [...this.sentLines] }

  /** Navigation state for disabled-styling in the overflow menu. */
  getNavState(): { commandCount: number; activeIndex: number | null; canPrev: boolean; canNext: boolean } {
    return {
      commandCount: this.commandBlocks.length,
      activeIndex: this.activeNavIndex,
      canPrev: this.commandBlocks.length > 1,
      canNext: this.commandBlocks.length > 1,
    }
  }

  /** Scroll to the previous command (VS Code ⌘↑). */
  scrollToPrevCommand(): void {
    const term = this.term
    if (!term) return
    const blocks = this.commandBlocks
    if (blocks.length === 0) return
    const viewportY = term.buffer.active.viewportY
    const curIdx = this.activeNavIndex
    let targetIdx: number
    if (curIdx === null) {
      targetIdx = -1
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].promptLine < viewportY) { targetIdx = i; break }
      }
      if (targetIdx === -1) targetIdx = Math.max(0, blocks.length - 2)
    } else {
      targetIdx = Math.max(0, curIdx - 1)
    }
    this.activeNavIndex = targetIdx
    term.scrollToLine(blocks[targetIdx].promptLine)
  }

  /** Scroll to the next command (VS Code ⌘↓). */
  scrollToNextCommand(): void {
    const term = this.term
    if (!term) return
    const blocks = this.commandBlocks
    if (blocks.length === 0) return
    const curIdx = this.activeNavIndex
    if (curIdx === null) return
    const targetIdx = Math.min(blocks.length - 1, curIdx + 1)
    this.activeNavIndex = targetIdx
    term.scrollToLine(blocks[targetIdx].promptLine)
  }

  /** Tear down everything. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.unsubData?.() } catch {}
    try { this.unsubExit?.() } catch {}
    try { this.unsubTrunc?.() } catch {}
    try { this.unsubResize?.() } catch {}
    this.unsubData = this.unsubExit = this.unsubTrunc = this.unsubResize = null
    this.commandMarkers = []
    this.sentLines = []
    this.currentInputBuffer = ''
    this.commandBlocks = []
    this.activeNavIndex = null
    try { this.term?.dispose() } catch {}
    this.term = null
    this.fitAddon = null
    this.container = null
  }

}
