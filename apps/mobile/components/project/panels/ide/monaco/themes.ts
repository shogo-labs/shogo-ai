// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-only theme catalog + JSON loader for Monaco.
 *
 * Why desktop-only:
 *   The web/mobile shell is intentionally frozen at two themes
 *   (shogo-dark / shogo-light). Anything richer ships through the Electron
 *   shell, which is the surface this module is wired into via
 *   `isDesktopRuntime()` in CodeEditor.tsx.
 *
 * What this module owns:
 *   - `BUILTIN_DESKTOP_THEMES` — 4 curated themes registered once per
 *     Monaco instance.
 *   - `registerDesktopThemes(monaco)` — idempotent registration of the
 *     curated set.
 *   - `parseThemeJson(text)` — strict validator for user-supplied JSON
 *     theme blobs (Monaco IStandaloneThemeData shape). Returns a discriminated
 *     union so callers can show a precise error.
 *   - `registerCustomTheme(monaco, parsed)` — stores in localStorage and
 *     registers on the live Monaco instance. Returns the assigned id.
 *   - `loadCustomThemes(monaco)` — replays every custom theme persisted in
 *     localStorage onto a freshly mounted Monaco. Safe to call multiple times.
 *   - `listAvailableThemes()` — combined list of curated + custom for the
 *     Settings picker.
 *
 * This module never imports from `monaco-editor` at the top level: Monaco
 * is only available inside Electron's renderer process at runtime. Instead
 * the public functions accept the `MonacoNs` namespace passed in from the
 * editor mount callback. That keeps this file unit-testable in `bun:test`
 * without pulling in the Monaco bundle.
 */

// Minimal structural subtype of Monaco's editor namespace.
export interface MonacoLike {
  editor: {
    defineTheme: (name: string, data: IStandaloneThemeData) => void
  }
}

// Re-declared locally so this file has no `monaco-editor` import. Matches
// `monaco.editor.IStandaloneThemeData` 1:1.
export interface IStandaloneThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: ITokenThemeRule[]
  colors: Record<string, string>
}

export interface ITokenThemeRule {
  token: string
  foreground?: string
  background?: string
  fontStyle?: string
}

export interface ThemeDescriptor {
  /** Monaco theme id, e.g. `"shogo-tokyo-night"`. Used by `editor.setTheme`. */
  id: string
  /** Human label for the Settings picker. */
  label: string
  /** Resolved app-side theme mode this Monaco theme is intended for. */
  mode: 'dark' | 'light'
  /** Source so the picker can show "built-in" / "custom". */
  origin: 'builtin' | 'custom'
  /** Monaco theme definition. */
  definition: IStandaloneThemeData
}

// ─── 4 curated themes ──────────────────────────────────────────────────────

const TOKYO_NIGHT: IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '',                foreground: 'a9b1d6' },
    { token: 'comment',         foreground: '565f89', fontStyle: 'italic' },
    { token: 'string',          foreground: '9ece6a' },
    { token: 'number',          foreground: 'ff9e64' },
    { token: 'keyword',         foreground: 'bb9af7' },
    { token: 'type',            foreground: '2ac3de' },
    { token: 'type.identifier', foreground: '2ac3de' },
    { token: 'identifier',      foreground: 'c0caf5' },
    { token: 'function',        foreground: '7aa2f7' },
    { token: 'variable',        foreground: 'c0caf5' },
    { token: 'tag',             foreground: 'f7768e' },
    { token: 'attribute.name',  foreground: 'e0af68' },
    { token: 'delimiter',       foreground: '89ddff' },
  ],
  colors: {
    'editor.background':              '#1a1b26',
    'editor.foreground':              '#a9b1d6',
    'editor.lineHighlightBackground': '#1f2335',
    'editorGutter.background':        '#1a1b26',
    'editorLineNumber.foreground':    '#3b4261',
    'editorCursor.foreground':        '#c0caf5',
    'editor.selectionBackground':     '#283457',
    'editorIndentGuide.background':   '#2a2f4a',
  },
}

const CATPPUCCIN_MOCHA: IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '',                foreground: 'cdd6f4' },
    { token: 'comment',         foreground: '6c7086', fontStyle: 'italic' },
    { token: 'string',          foreground: 'a6e3a1' },
    { token: 'number',          foreground: 'fab387' },
    { token: 'keyword',         foreground: 'cba6f7' },
    { token: 'type',            foreground: 'f9e2af' },
    { token: 'type.identifier', foreground: 'f9e2af' },
    { token: 'identifier',      foreground: 'cdd6f4' },
    { token: 'function',        foreground: '89b4fa' },
    { token: 'variable',        foreground: 'cdd6f4' },
    { token: 'tag',             foreground: 'f38ba8' },
    { token: 'attribute.name',  foreground: 'f9e2af' },
    { token: 'delimiter',       foreground: '94e2d5' },
  ],
  colors: {
    'editor.background':              '#1e1e2e',
    'editor.foreground':              '#cdd6f4',
    'editor.lineHighlightBackground': '#292c3c',
    'editorGutter.background':        '#1e1e2e',
    'editorLineNumber.foreground':    '#45475a',
    'editorCursor.foreground':        '#f5e0dc',
    'editor.selectionBackground':     '#414559',
    'editorIndentGuide.background':   '#313244',
  },
}

const SOLARIZED_DARK: IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '',                foreground: '93a1a1' },
    { token: 'comment',         foreground: '586e75', fontStyle: 'italic' },
    { token: 'string',          foreground: '2aa198' },
    { token: 'number',          foreground: 'd33682' },
    { token: 'keyword',         foreground: '859900' },
    { token: 'type',            foreground: 'b58900' },
    { token: 'type.identifier', foreground: 'b58900' },
    { token: 'identifier',      foreground: '93a1a1' },
    { token: 'function',        foreground: '268bd2' },
    { token: 'variable',        foreground: 'cb4b16' },
    { token: 'tag',             foreground: '268bd2' },
    { token: 'attribute.name',  foreground: '93a1a1' },
    { token: 'delimiter',       foreground: '6c71c4' },
  ],
  colors: {
    'editor.background':              '#002b36',
    'editor.foreground':              '#93a1a1',
    'editor.lineHighlightBackground': '#073642',
    'editorGutter.background':        '#002b36',
    'editorLineNumber.foreground':    '#586e75',
    'editorCursor.foreground':        '#93a1a1',
    'editor.selectionBackground':     '#073642',
    'editorIndentGuide.background':   '#073642',
  },
}

const GITHUB_DARK: IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '',                foreground: 'c9d1d9' },
    { token: 'comment',         foreground: '8b949e', fontStyle: 'italic' },
    { token: 'string',          foreground: 'a5d6ff' },
    { token: 'number',          foreground: '79c0ff' },
    { token: 'keyword',         foreground: 'ff7b72' },
    { token: 'type',            foreground: 'ffa657' },
    { token: 'type.identifier', foreground: 'ffa657' },
    { token: 'identifier',      foreground: 'c9d1d9' },
    { token: 'function',        foreground: 'd2a8ff' },
    { token: 'variable',        foreground: 'ffa657' },
    { token: 'tag',             foreground: '7ee787' },
    { token: 'attribute.name',  foreground: '79c0ff' },
    { token: 'delimiter',       foreground: 'c9d1d9' },
  ],
  colors: {
    'editor.background':              '#0d1117',
    'editor.foreground':              '#c9d1d9',
    'editor.lineHighlightBackground': '#161b22',
    'editorGutter.background':        '#0d1117',
    'editorLineNumber.foreground':    '#484f58',
    'editorCursor.foreground':        '#c9d1d9',
    'editor.selectionBackground':     '#264f78',
    'editorIndentGuide.background':   '#21262d',
  },
}

export const BUILTIN_DESKTOP_THEMES: ThemeDescriptor[] = [
  { id: 'shogo-tokyo-night',  label: 'Tokyo Night',      mode: 'dark', origin: 'builtin', definition: TOKYO_NIGHT },
  { id: 'shogo-catppuccin',   label: 'Catppuccin Mocha', mode: 'dark', origin: 'builtin', definition: CATPPUCCIN_MOCHA },
  { id: 'shogo-solarized',    label: 'Solarized Dark',   mode: 'dark', origin: 'builtin', definition: SOLARIZED_DARK },
  { id: 'shogo-github-dark',  label: 'GitHub Dark',      mode: 'dark', origin: 'builtin', definition: GITHUB_DARK },
]

// ─── Registration ──────────────────────────────────────────────────────────

const BUILTIN_REGISTERED = new WeakSet<MonacoLike>()

/**
 * Registers every curated theme on the given Monaco instance.
 * Idempotent per-Monaco: subsequent calls are a no-op so splitting the
 * editor or remounting CodeEditor doesn't re-pay the cost.
 */
export function registerDesktopThemes(monaco: MonacoLike): void {
  if (BUILTIN_REGISTERED.has(monaco)) return
  for (const t of BUILTIN_DESKTOP_THEMES) {
    monaco.editor.defineTheme(t.id, t.definition)
  }
  BUILTIN_REGISTERED.add(monaco)
}

/** Test-only: drop a Monaco instance from the idempotency cache. */
export function _resetThemeRegistryForTests(monaco: MonacoLike): void {
  BUILTIN_REGISTERED.delete(monaco)
}

// ─── JSON loader ───────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true;  theme: ThemeDescriptor }
  | { ok: false; error: string }

const VALID_BASES = new Set(['vs', 'vs-dark', 'hc-black', 'hc-light'])
const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * Strict validator + normalizer for a user-supplied theme JSON blob.
 *
 * Accepts a Monaco `IStandaloneThemeData` object with optional `name` /
 * `label` keys at the top level.
 *
 * Required: `base`, `colors`. `rules` defaults to []. `inherit` defaults to true.
 *
 * Slugifies the supplied name into a Monaco-safe id (`shogo-user-<slug>`)
 * so it can never collide with a built-in (every built-in id is
 * `shogo-<known-suffix>`, never `shogo-user-…`).
 */
export function parseThemeJson(input: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'theme must be a JSON object' }
  }
  const o = raw as Record<string, unknown>

  const base = o.base
  if (typeof base !== 'string' || !VALID_BASES.has(base)) {
    return { ok: false, error: '"base" must be one of vs, vs-dark, hc-black, hc-light' }
  }

  if (!o.colors || typeof o.colors !== 'object' || Array.isArray(o.colors)) {
    return { ok: false, error: '"colors" must be an object' }
  }
  const colorEntries = Object.entries(o.colors as Record<string, unknown>)
  for (const [k, v] of colorEntries) {
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      return { ok: false, error: `colors.${k} must be a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA)` }
    }
  }

  const rules: ITokenThemeRule[] = []
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules)) {
      return { ok: false, error: '"rules" must be an array' }
    }
    for (const [i, r] of (o.rules as unknown[]).entries()) {
      if (!r || typeof r !== 'object') {
        return { ok: false, error: `rules[${i}] must be an object` }
      }
      const rr = r as Record<string, unknown>
      if (typeof rr.token !== 'string') {
        return { ok: false, error: `rules[${i}].token must be a string` }
      }
      const rule: ITokenThemeRule = { token: rr.token }
      for (const k of ['foreground', 'background', 'fontStyle'] as const) {
        if (rr[k] !== undefined) {
          if (typeof rr[k] !== 'string') {
            return { ok: false, error: `rules[${i}].${k} must be a string` }
          }
          let v = rr[k] as string
          // Monaco token rules expect hex without `#`. Strip it so a rule
          // copied verbatim from a VS Code theme.json actually applies.
          if ((k === 'foreground' || k === 'background') && v.startsWith('#')) {
            v = v.slice(1)
          }
          rule[k] = v
        }
      }
      rules.push(rule)
    }
  }

  const labelRaw =
    (typeof o.name === 'string' && o.name.trim()) ||
    (typeof o.label === 'string' && o.label.trim()) ||
    'Custom Theme'
  const label = labelRaw as string
  const id = `shogo-user-${slugify(label)}`
  const mode: 'dark' | 'light' = base === 'vs' || base === 'hc-light' ? 'light' : 'dark'

  // Normalize colors: prepend # when missing.
  const colors: Record<string, string> = {}
  for (const [k, v] of colorEntries) {
    const s = v as string
    colors[k] = s.startsWith('#') ? s : `#${s}`
  }

  return {
    ok: true,
    theme: {
      id,
      label,
      mode,
      origin: 'custom',
      definition: { base: base as IStandaloneThemeData['base'], inherit: o.inherit !== false, rules, colors },
    },
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'theme'
}

// ─── Persistence ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'shogo.ide.customThemes'

/** Storage adapter — defaults to `window.localStorage` but injectable for tests. */
export interface ThemeStorage {
  read():  ThemeDescriptor[]
  write(themes: ThemeDescriptor[]): void
}

export function defaultStorage(): ThemeStorage {
  const ls: Storage | undefined = (globalThis as { localStorage?: Storage }).localStorage
  return {
    read() {
      if (!ls) return []
      try {
        const raw = ls.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as ThemeDescriptor[]) : []
      } catch {
        return []
      }
    },
    write(themes) {
      if (!ls) return
      try {
        ls.setItem(STORAGE_KEY, JSON.stringify(themes))
      } catch {
        // Quota / private mode — swallow; theme just won't survive a reload.
      }
    },
  }
}

/**
 * Registers a parsed custom theme on Monaco and persists it.
 * If a theme with the same id already exists in storage, it is replaced
 * (Monaco's defineTheme overwrites in place too, so callers always see
 * the latest definition).
 */
export function registerCustomTheme(
  monaco: MonacoLike,
  parsed: ThemeDescriptor,
  storage: ThemeStorage = defaultStorage(),
): string {
  monaco.editor.defineTheme(parsed.id, parsed.definition)
  const existing = storage.read().filter(t => t.id !== parsed.id)
  storage.write([...existing, parsed])
  return parsed.id
}

/**
 * Replays every persisted custom theme onto a freshly mounted Monaco.
 *
 * Resilient: each theme is registered inside its own try/catch so a single
 * malformed entry (older format, partial write, manually edited
 * localStorage) cannot crash configureMonaco at editor mount. Returns the
 * subset of themes that actually registered, so callers / the picker only
 * surface working themes.
 */
export function loadCustomThemes(
  monaco: MonacoLike,
  storage: ThemeStorage = defaultStorage(),
): ThemeDescriptor[] {
  const themes = storage.read()
  const ok: ThemeDescriptor[] = []
  for (const t of themes) {
    if (!isWellFormedDescriptor(t)) continue
    try {
      monaco.editor.defineTheme(t.id, t.definition)
      ok.push(t)
    } catch (e) {
      // Surface to devtools but never bubble — startup must succeed.
      // eslint-disable-next-line no-console
      console.warn(`[shogo-ide/themes] failed to register custom theme "${t.id}":`, e)
    }
  }
  return ok
}

/**
 * Structural sanity check for a ThemeDescriptor read out of storage.
 * Defends against an older version of the descriptor format ever shipping
 * partially-written data, or a user hand-editing localStorage.
 */
function isWellFormedDescriptor(t: unknown): t is ThemeDescriptor {
  if (!t || typeof t !== 'object') return false
  const r = t as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return false
  if (typeof r.label !== 'string') return false
  if (r.mode !== 'dark' && r.mode !== 'light') return false
  if (r.origin !== 'builtin' && r.origin !== 'custom') return false
  const d = r.definition as Record<string, unknown> | undefined
  if (!d || typeof d !== 'object') return false
  if (typeof d.base !== 'string' || !VALID_BASES.has(d.base as string)) return false
  if (!d.colors || typeof d.colors !== 'object' || Array.isArray(d.colors)) return false
  if (d.rules !== undefined && !Array.isArray(d.rules)) return false
  return true
}

/** Combined list for the Settings picker. */
export function listAvailableThemes(
  storage: ThemeStorage = defaultStorage(),
): ThemeDescriptor[] {
  return [...BUILTIN_DESKTOP_THEMES, ...storage.read()]
}
