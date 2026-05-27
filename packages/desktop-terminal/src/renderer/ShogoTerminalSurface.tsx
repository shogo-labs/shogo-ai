// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ShogoTerminalSurface — minimal VS Code-style xterm.js wrapper for the
 * Shogo Desktop renderer.
 *
 *   PtyClient.onData  →  term.write()
 *   term.onData       →  PtyClient.send()
 *   term.onResize     →  PtyClient.resize()
 *
 * Mounts xterm with the FitAddon (fills the container) and the
 * WebLinksAddon (URLs in the buffer become clickable). The WebGL
 * renderer is loaded opportunistically; on context loss we silently
 * fall back to the canvas renderer.
 *
 * Theming, padding, font size, and scrollback are tuned to match
 * VS Code's default Dark+ terminal so the panel feels native.
 */
import * as React from 'react'
import type { Terminal as XTerminal } from '@xterm/xterm'
import type { FitAddon as XFitAddon } from '@xterm/addon-fit'

const XTERM_STYLE_ID = 'shogo-xterm-css'
const XTERM_CSS = `
/**
 * Copyright (c) 2014 The xterm.js authors. All rights reserved.
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * https://github.com/chjj/term.js
 * @license MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 *   The original design remains. The terminal itself
 *   has been extended to include xterm CSI codes, among
 *   other features.
 */

/**
 *  Default styles for xterm.js
 */

.xterm {
    cursor: text;
    position: relative;
    user-select: none;
    -ms-user-select: none;
    -webkit-user-select: none;
}

.xterm.focus,
.xterm:focus {
    outline: none;
}

.xterm .xterm-helpers {
    position: absolute;
    top: 0;
    /**
     * The z-index of the helpers must be higher than the canvases in order for
     * IMEs to appear on top.
     */
    z-index: 5;
}

.xterm .xterm-helper-textarea {
    padding: 0;
    border: 0;
    margin: 0;
    /* Move textarea out of the screen to the far left, so that the cursor is not visible */
    position: absolute;
    opacity: 0;
    left: -9999em;
    top: 0;
    width: 0;
    height: 0;
    z-index: -5;
    /** Prevent wrapping so the IME appears against the textarea at the correct position */
    white-space: nowrap;
    overflow: hidden;
    resize: none;
}

.xterm .composition-view {
    /* TODO: Composition position got messed up somewhere */
    background: #000;
    color: #FFF;
    display: none;
    position: absolute;
    white-space: nowrap;
    z-index: 1;
}

.xterm .composition-view.active {
    display: block;
}

.xterm .xterm-viewport {
    /* On OS X this is required in order for the scroll bar to appear fully opaque */
    background-color: #000;
    overflow-y: scroll;
    cursor: default;
    position: absolute;
    right: 0;
    left: 0;
    top: 0;
    bottom: 0;
}

.xterm .xterm-screen {
    position: relative;
}

.xterm .xterm-screen canvas {
    position: absolute;
    left: 0;
    top: 0;
}

.xterm-char-measure-element {
    display: inline-block;
    visibility: hidden;
    position: absolute;
    top: 0;
    left: -9999em;
    line-height: normal;
}

.xterm.enable-mouse-events {
    /* When mouse events are enabled (eg. tmux), revert to the standard pointer cursor */
    cursor: default;
}

.xterm.xterm-cursor-pointer,
.xterm .xterm-cursor-pointer {
    cursor: pointer;
}

.xterm.column-select.focus {
    /* Column selection mode */
    cursor: crosshair;
}

.xterm .xterm-accessibility:not(.debug),
.xterm .xterm-message {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 10;
    color: transparent;
    pointer-events: none;
}

.xterm .xterm-accessibility-tree:not(.debug) *::selection {
  color: transparent;
}

.xterm .xterm-accessibility-tree {
  font-family: monospace;
  user-select: text;
  white-space: pre;
}

.xterm .xterm-accessibility-tree > div {
  transform-origin: left;
  width: fit-content;
}

.xterm .live-region {
    position: absolute;
    left: -9999px;
    width: 1px;
    height: 1px;
    overflow: hidden;
}

.xterm-dim {
    /* Dim should not apply to background, so the opacity of the foreground color is applied
     * explicitly in the generated class and reset to 1 here */
    opacity: 1 !important;
}

.xterm-underline-1 { text-decoration: underline; }
.xterm-underline-2 { text-decoration: double underline; }
.xterm-underline-3 { text-decoration: wavy underline; }
.xterm-underline-4 { text-decoration: dotted underline; }
.xterm-underline-5 { text-decoration: dashed underline; }

.xterm-overline {
    text-decoration: overline;
}

.xterm-overline.xterm-underline-1 { text-decoration: overline underline; }
.xterm-overline.xterm-underline-2 { text-decoration: overline double underline; }
.xterm-overline.xterm-underline-3 { text-decoration: overline wavy underline; }
.xterm-overline.xterm-underline-4 { text-decoration: overline dotted underline; }
.xterm-overline.xterm-underline-5 { text-decoration: overline dashed underline; }

.xterm-strikethrough {
    text-decoration: line-through;
}

.xterm-screen .xterm-decoration-container .xterm-decoration {
	z-index: 6;
	position: absolute;
}

.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer {
	z-index: 7;
}

.xterm-decoration-overview-ruler {
    z-index: 8;
    position: absolute;
    top: 0;
    right: 0;
    pointer-events: none;
}

.xterm-decoration-top {
    z-index: 2;
    position: relative;
}



/* Derived from vs/base/browser/ui/scrollbar/media/scrollbar.css */

/* xterm.js customization: Override xterm's cursor style */
.xterm .xterm-scrollable-element > .scrollbar {
    cursor: default;
}

/* Arrows */
.xterm .xterm-scrollable-element > .scrollbar > .scra {
	cursor: pointer;
	font-size: 11px !important;
}

.xterm .xterm-scrollable-element > .visible {
	opacity: 1;

	/* Background rule added for IE9 - to allow clicks on dom node */
	background:rgba(0,0,0,0);

	transition: opacity 100ms linear;
	/* In front of peek view */
	z-index: 11;
}
.xterm .xterm-scrollable-element > .invisible {
	opacity: 0;
	pointer-events: none;
}
.xterm .xterm-scrollable-element > .invisible.fade {
	transition: opacity 800ms linear;
}

/* Scrollable Content Inset Shadow */
.xterm .xterm-scrollable-element > .shadow {
	position: absolute;
	display: none;
}
.xterm .xterm-scrollable-element > .shadow.top {
	display: block;
	top: 0;
	left: 3px;
	height: 3px;
	width: 100%;
	box-shadow: var(--vscode-scrollbar-shadow, #000) 0 6px 6px -6px inset;
}
.xterm .xterm-scrollable-element > .shadow.left {
	display: block;
	top: 3px;
	left: 0;
	height: 100%;
	width: 3px;
	box-shadow: var(--vscode-scrollbar-shadow, #000) 6px 0 6px -6px inset;
}
.xterm .xterm-scrollable-element > .shadow.top-left-corner {
	display: block;
	top: 0;
	left: 0;
	height: 3px;
	width: 3px;
}
.xterm .xterm-scrollable-element > .shadow.top.left {
	box-shadow: var(--vscode-scrollbar-shadow, #000) 6px 0 6px -6px inset;
}
`

function ensureXtermStylesheet(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(XTERM_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = XTERM_STYLE_ID
  style.textContent = XTERM_CSS
  document.head.appendChild(style)
}

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
}

const DARK_PLUS_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f7880',
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

const DEFAULT_FONT_FAMILY =
  'Menlo, Monaco, "Courier New", monospace'

export const ShogoTerminalSurface = React.forwardRef<
  ShogoTerminalSurfaceHandle,
  ShogoTerminalSurfaceProps
>(function ShogoTerminalSurface(
  { client, hidden = false, autoFocus = true, fontSize = 12, fontFamily = DEFAULT_FONT_FAMILY },
  ref,
) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<XTerminal | null>(null)
  const fitRef = React.useRef<XFitAddon | null>(null)
  const [state, setState] = React.useState(client.state)

  React.useEffect(() => {
    setState(client.state)
    return client.onState(setState)
  }, [client])

  React.useEffect(() => {
    const container = hostRef.current
    if (!container) return
    let disposed = false
    let cleanup = (): void => undefined
    let initialFitHandle: number | null = null

    void (async () => {
      ensureXtermStylesheet()
      const [xtermMod, fitMod, linksMod, webglMod] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-webgl').catch(() => null),
      ])
      if (disposed) return

      const term = new xtermMod.Terminal({
        convertEol: true,
        cursorBlink: false,
        cursorStyle: 'block',
        cursorWidth: 1,
        fastScrollSensitivity: 5,
        fontFamily,
        fontSize,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        letterSpacing: 0,
        lineHeight: 1,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
        scrollback: 1_000,
        theme: DARK_PLUS_THEME,
        allowProposedApi: true,
      })
      const fit = new fitMod.FitAddon()
      const links = new linksMod.WebLinksAddon()
      term.loadAddon(fit)
      term.loadAddon(links)
      term.open(container)

      // Best-effort GPU renderer. Falls back silently on context loss.
      if (webglMod) {
        try {
          const webgl = new webglMod.WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          /* canvas renderer is fine */
        }
      }

      termRef.current = term
      fitRef.current = fit

      const offData = client.onData((bytes) => term.write(bytes))
      const offExit = client.onExit((info) => {
        const tag = info.signal ? ` (signal ${info.signal})` : ''
        term.write(`\r\n\x1b[2;90m[shell exited with code ${info.code ?? '?'}${tag}]\x1b[0m\r\n`)
      })
      const offTrunc = client.onTruncated(() => {
        term.write('\x1b[2;90m[scrollback truncated — older output dropped]\x1b[0m\r\n')
      })
      const offError = client.onError((err) => {
        term.write(`\r\n\x1b[31m[terminal error] ${err.message}\x1b[0m\r\n`)
      })

      term.onData((data) => client.send(data))
      term.onResize(({ cols, rows }) => client.resize(cols, rows))

      const ro = new ResizeObserver(() => {
        try { fit.fit() } catch { /* container detached */ }
      })
      ro.observe(container)

      // Push the initial size so the shell prompt doesn't wrap on first
      // keystroke. node-pty was spawned with our estimate; this corrects it.
      initialFitHandle = requestAnimationFrame(() => {
        initialFitHandle = null
        try { fit.fit() } catch { /* container detached */ }
        client.resize(term.cols, term.rows)
      })
      if (autoFocus && !hidden) term.focus()

      cleanup = () => {
        if (initialFitHandle !== null) {
          cancelAnimationFrame(initialFitHandle)
          initialFitHandle = null
        }
        offData()
        offExit()
        offTrunc()
        offError()
        ro.disconnect()
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    })()

    return () => {
      disposed = true
      cleanup()
    }
    // We deliberately don't depend on font/hidden/autoFocus — the
    // session lives across re-renders. Font changes after mount aren't
    // currently supported (would need a teardown + remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  React.useEffect(() => {
    if (!hidden && autoFocus) termRef.current?.focus()
  }, [hidden, autoFocus])

  React.useImperativeHandle(
    ref,
    () => ({
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
      refit: () => {
        try { fitRef.current?.fit() } catch { /* container detached */ }
      },
    }),
    [],
  )

  return (
    <div
      data-shogo-terminal-surface="true"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: hidden ? 'none' : 'block',
        background: DARK_PLUS_THEME.background,
      }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%', padding: '4px 0' }} />
      {state !== 'open' && state !== 'idle' ? (
        <div
          style={{
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
          }}
        >
          {state === 'connecting' ? 'Reconnecting…' : state === 'closed' ? 'Disconnected' : 'Closed'}
        </div>
      ) : null}
    </div>
  )
})
