// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useShogoTheme — Phase 10 theme sync hook.
 *
 * Emits an xterm theme object that follows the OS / app preference for
 * dark vs light. The host (apps/desktop) re-exports this from its
 * top-level theme system; standalone consumers can use the hook
 * directly with the default media-query backend.
 *
 * Why this lives in the desktop-terminal package (rather than in the
 * embedder): the *xterm theme shape* and the canonical VS Code Dark+ /
 * Light+ palettes are stable across embedders, and forcing every
 * embedder to ship their own copy would let the colors drift.
 *
 * Backends:
 *
 *   • Default — `window.matchMedia('(prefers-color-scheme: dark)')`
 *     with a live subscription so flipping the OS theme propagates
 *     within one media-query event (~50ms in Chromium).
 *
 *   • Override — pass `{ subscribe }` to wire the hook into a custom
 *     source (e.g. an Electron `nativeTheme.on('updated', …)` channel
 *     or the host app's existing theme context).
 *
 * Returned `theme` is shaped to match xterm's
 * `ITerminalOptions['theme']` exactly so a caller can assign it
 * directly: `term.options.theme = theme`.
 */
import * as React from 'react'

export interface XtermThemeColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent?: string
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

/** VS Code "Dark+" defaults. Same palette the surface used before Phase 10. */
export const DARK_PLUS_THEME: XtermThemeColors = {
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

/**
 * VS Code "Light+" defaults — pulled from the published Code-OSS
 * defaults (extension `vscode.theme-defaults`). Hex values match
 * VS Code 1.95.
 */
export const LIGHT_PLUS_THEME: XtermThemeColors = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#000000',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
}

/**
 * Live source of "is the host currently dark?" + a way to subscribe.
 * Embedder hands one of these to `useShogoTheme` to wire it to a
 * non-default theme system (Electron `nativeTheme`, React context,
 * etc.).
 */
export interface ThemeSource {
  getIsDark(): boolean
  subscribe(listener: (isDark: boolean) => void): () => void
}

export interface UseShogoThemeOptions {
  /** Override the dark/light signal source. */
  source?: ThemeSource
  /** Override the dark palette. */
  darkTheme?: XtermThemeColors
  /** Override the light palette. */
  lightTheme?: XtermThemeColors
}

export interface UseShogoThemeResult {
  /** xterm-ready theme object. */
  theme: XtermThemeColors
  /** Current resolution. */
  isDark: boolean
}

/**
 * Default backend: `prefers-color-scheme` media query. Server-safe
 * (returns `dark=true` when `window` is undefined so SSR doesn't flash
 * a white terminal).
 */
function defaultThemeSource(): ThemeSource {
  return {
    getIsDark() {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    },
    subscribe(listener) {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (ev: MediaQueryListEvent) => listener(ev.matches)
      // `addEventListener` is the modern API; old Safari needs the deprecated form.
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
      }
      mq.addListener(onChange)
      return () => mq.removeListener(onChange)
    },
  }
}

export function useShogoTheme(opts: UseShogoThemeOptions = {}): UseShogoThemeResult {
  const source = opts.source ?? defaultThemeSource()
  const dark = opts.darkTheme ?? DARK_PLUS_THEME
  const light = opts.lightTheme ?? LIGHT_PLUS_THEME
  const [isDark, setIsDark] = React.useState<boolean>(() => source.getIsDark())
  React.useEffect(() => source.subscribe(setIsDark), [source])
  return {
    theme: isDark ? dark : light,
    isDark,
  }
}

/**
 * Non-React resolution — useful for the embedder when computing a
 * one-shot theme outside a hook (e.g. when restoring a snapshot before
 * the React tree has mounted).
 */
export function resolveShogoTheme(opts: UseShogoThemeOptions = {}): UseShogoThemeResult {
  const source = opts.source ?? defaultThemeSource()
  const isDark = source.getIsDark()
  return {
    theme: isDark ? (opts.darkTheme ?? DARK_PLUS_THEME) : (opts.lightTheme ?? LIGHT_PLUS_THEME),
    isDark,
  }
}
