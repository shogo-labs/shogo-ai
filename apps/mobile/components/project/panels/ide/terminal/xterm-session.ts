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

// We import the runtime types lazily; these `type`-only imports cost nothing
// at runtime. Web-only — xterm.js bundles a Canvas/WebGL renderer.
type XTerminal = import('@xterm/xterm').Terminal
type XFitAddon = import('@xterm/addon-fit').FitAddon

export interface XtermSessionOptions {
  fontFamily?: string
  fontSize?: number
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

    // Wire xterm → PTY
    term.onData((data: string) => this.client.send(data))
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
  }

  /** Re-fit on container resize. No-op before attach. */
  fit(): void {
    if (this.disposed) return
    try { this.fitAddon?.fit() } catch {}
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

  /** Tear down everything. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.unsubData?.() } catch {}
    try { this.unsubExit?.() } catch {}
    try { this.unsubTrunc?.() } catch {}
    try { this.unsubResize?.() } catch {}
    this.unsubData = this.unsubExit = this.unsubTrunc = this.unsubResize = null
    try { this.term?.dispose() } catch {}
    this.term = null
    this.fitAddon = null
    this.container = null
  }

}
