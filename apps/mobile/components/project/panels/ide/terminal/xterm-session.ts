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
import { DARK_PLUS_THEME, TERMINAL_DEFAULTS } from './xterm-theme'
// xterm.js relies on this stylesheet to (a) size the row container and (b)
// clip-hide the input proxy `<textarea>`. Without it, the textarea renders
// unstyled at 0,0 and the rows have no height — the panel looks blank
// except for a stray white input box. Side-effect import only.
import '@xterm/xterm/css/xterm.css'

// We import the runtime types lazily; these `type`-only imports cost nothing
// at runtime. Web-only — xterm.js bundles a Canvas/WebGL renderer.
type XTerminal = import('@xterm/xterm').Terminal
type XFitAddon = import('@xterm/addon-fit').FitAddon
type IMarker  = import('@xterm/xterm').IMarker

export interface XtermSessionOptions {
  fontFamily?: string
  fontSize?: number
  fontLigatures?: boolean
}

export class XtermSession {
  private term: XTerminal | null = null
  private fitAddon: XFitAddon | null = null
  private container: HTMLElement | null = null
  private unsubData: (() => void) | null = null
  private unsubExit: (() => void) | null = null
  private unsubTrunc: (() => void) | null = null
  private unsubResize: (() => void) | null = null
  private disposed = false
  private banneredExit = false
  private commandMarkers: IMarker[] = []
  private sentLines: string[] = []
  private currentInputBuffer = ''
  private static readonly MAX_HISTORY = 500

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
    const [xtermMod, fitMod, linksMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
    ])
    if (this.disposed) return

    const term: XTerminal = new xtermMod.Terminal({
      ...TERMINAL_DEFAULTS,
      fontFamily: this.opts.fontFamily ?? TERMINAL_DEFAULTS.fontFamily,
      fontSize: this.opts.fontSize ?? TERMINAL_DEFAULTS.fontSize,
      fontLigatures: this.opts.fontLigatures ?? TERMINAL_DEFAULTS.fontLigatures,
      theme: DARK_PLUS_THEME,
    } as unknown as ConstructorParameters<typeof xtermMod.Terminal>[0])
    this.term = term

    const fitAddon: XFitAddon = new fitMod.FitAddon()
    term.loadAddon(fitAddon)
    this.fitAddon = fitAddon

    const linksAddon = new linksMod.WebLinksAddon()
    term.loadAddon(linksAddon)

    term.open(container)
    fitAddon.fit()

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.disposed) return
        const prevCols = term.cols
        const prevRows = term.rows
        try { this.fitAddon?.fit() } catch {}
        if (term.cols !== prevCols || term.rows !== prevRows) {
          this.client.resize(term.cols, term.rows)
        }
      })
    })
  }

  /** Re-fit on container resize. No-op before attach. */
  fit(): void {
    if (this.disposed) return
    try { this.fitAddon?.fit() } catch {}
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

  /** Scroll to the nearest command marker above the current viewport top. */
  scrollToPrevCommand(): void {
    const term = this.term
    if (!term) return
    const viewportTop = term.buffer.active.viewportY
    const live = this.commandMarkers.filter((m) => !m.isDisposed)
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i].line < viewportTop) {
        term.scrollToLine(live[i].line)
        return
      }
    }
    if (live.length > 0) term.scrollToLine(live[0].line)
  }

  /** Scroll to the nearest command marker below the current viewport top. */
  scrollToNextCommand(): void {
    const term = this.term
    if (!term) return
    const viewportTop = term.buffer.active.viewportY
    const live = this.commandMarkers.filter((m) => !m.isDisposed)
    for (const m of live) {
      if (m.line > viewportTop) {
        term.scrollToLine(m.line)
        return
      }
    }
    if (live.length > 0) term.scrollToLine(live[live.length - 1].line)
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
    try { this.term?.dispose() } catch {}
    this.term = null
    this.fitAddon = null
    this.container = null
  }

}
