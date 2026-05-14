// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Theme + default config for the IDE's xterm.js instances.
 *
 * Colors mirror VS Code's "Dark+" defaults so output that depends on the
 * 16-color ANSI palette (e.g. `git status`, `bun install`'s ✔ marks,
 * `tsc`'s reds) looks the way users expect.
 *
 * Font/cursor/scrollback are tuned for the IDE's bottom panel — small
 * but readable, plenty of history, no blink so it doesn't yank focus.
 */

export interface XtermTheme {
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const DARK_PLUS_THEME: XtermTheme = {
  foreground: '#cccccc',
  background: '#1e1e1e',
  cursor: '#aeafad',
  cursorAccent: '#1e1e1e',
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

export const TERMINAL_DEFAULTS = {
  fontFamily:
    'Menlo, "DejaVu Sans Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  // 10k lines is generous but not absurd; matches VS Code's default and
  // keeps memory bounded even with `cat huge.log`.
  scrollback: 10_000,
  cursorBlink: false,
  // Convert lone CR (\r without \n) into CRLF. Most terminal apps emit
  // a bare CR for in-place updates (progress bars, spinners), but xterm
  // by default leaves the cursor at column 0 mid-line, which makes the
  // user-visible result match the original PTY output exactly.
  convertEol: false,
  allowProposedApi: false,
  // Disable transparent background so the theme bg actually paints.
  allowTransparency: false,
}
