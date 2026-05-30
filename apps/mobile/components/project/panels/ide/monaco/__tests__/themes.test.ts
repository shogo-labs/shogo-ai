// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the desktop-only Monaco theme catalog + JSON loader.
 *
 * The module under test has no `monaco-editor` import: it accepts a
 * structural `MonacoLike` so we feed it a tiny in-memory stub here.
 *
 * Coverage:
 *   - BUILTIN_DESKTOP_THEMES shape (id prefix, mode, definition completeness)
 *   - registerDesktopThemes() registers every built-in once and is idempotent
 *   - parseThemeJson() — happy path + every failure branch
 *   - slugify() normalization
 *   - registerCustomTheme() — defines on monaco, persists to storage, replaces
 *     prior entry with the same id
 *   - loadCustomThemes() replays storage onto a fresh monaco
 *   - listAvailableThemes() = built-ins + custom in stable order
 *   - defaultStorage() tolerates missing localStorage / bad JSON
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  BUILTIN_DESKTOP_THEMES,
  registerDesktopThemes,
  _resetThemeRegistryForTests,
  parseThemeJson,
  slugify,
  registerCustomTheme,
  loadCustomThemes,
  listAvailableThemes,
  defaultStorage,
  type MonacoLike,
  type ThemeDescriptor,
  type ThemeStorage,
} from '../themes'

/* ───── helpers ──────────────────────────────────────────────────────────── */

function makeMonaco() {
  const calls: Array<{ name: string; data: unknown }> = []
  const monaco: MonacoLike = {
    editor: {
      defineTheme(name, data) {
        calls.push({ name, data })
      },
    },
  }
  return { monaco, calls }
}

function makeStorage(seed: ThemeDescriptor[] = []): ThemeStorage & { _data: ThemeDescriptor[] } {
  const ref: { _data: ThemeDescriptor[] } = { _data: [...seed] }
  return {
    ...ref,
    read() { return [...ref._data] },
    write(next) { ref._data = [...next] },
  }
}

const VALID_JSON = JSON.stringify({
  name: 'My Cool Theme',
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'comment', foreground: '888888', fontStyle: 'italic' }],
  colors: { 'editor.background': '#101010', 'editor.foreground': 'eeeeee' },
})

/* ───── BUILTIN_DESKTOP_THEMES ───────────────────────────────────────────── */

describe('BUILTIN_DESKTOP_THEMES', () => {
  it('ships exactly 4 curated themes', () => {
    expect(BUILTIN_DESKTOP_THEMES).toHaveLength(4)
  })

  it('every id is namespaced under shogo- but not under shogo-user- (collision-safe)', () => {
    for (const t of BUILTIN_DESKTOP_THEMES) {
      expect(t.id.startsWith('shogo-')).toBe(true)
      expect(t.id.startsWith('shogo-user-')).toBe(false)
    }
  })

  it('every theme declares mode, origin=builtin, valid base, and core editor colors', () => {
    for (const t of BUILTIN_DESKTOP_THEMES) {
      expect(t.origin).toBe('builtin')
      expect(['dark', 'light']).toContain(t.mode)
      expect(['vs', 'vs-dark', 'hc-black', 'hc-light']).toContain(t.definition.base)
      expect(t.definition.colors['editor.background']).toMatch(/^#[0-9a-fA-F]{6,8}$/)
      expect(t.definition.colors['editor.foreground']).toMatch(/^#[0-9a-fA-F]{6,8}$/)
      expect(Array.isArray(t.definition.rules)).toBe(true)
      expect(t.definition.rules.length).toBeGreaterThan(0)
    }
  })

  it('labels are unique (no two built-ins shadow each other in the picker)', () => {
    const labels = BUILTIN_DESKTOP_THEMES.map(t => t.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

/* ───── registerDesktopThemes ────────────────────────────────────────────── */

describe('registerDesktopThemes', () => {
  it('registers every built-in theme on the given monaco', () => {
    const { monaco, calls } = makeMonaco()
    _resetThemeRegistryForTests(monaco)
    registerDesktopThemes(monaco)
    expect(calls).toHaveLength(BUILTIN_DESKTOP_THEMES.length)
    expect(calls.map(c => c.name).sort()).toEqual(BUILTIN_DESKTOP_THEMES.map(t => t.id).sort())
  })

  it('is idempotent: a second call on the same monaco does not re-register', () => {
    const { monaco, calls } = makeMonaco()
    _resetThemeRegistryForTests(monaco)
    registerDesktopThemes(monaco)
    registerDesktopThemes(monaco)
    registerDesktopThemes(monaco)
    expect(calls).toHaveLength(BUILTIN_DESKTOP_THEMES.length)
  })

  it('treats distinct monaco instances independently (split editors)', () => {
    const a = makeMonaco()
    const b = makeMonaco()
    _resetThemeRegistryForTests(a.monaco)
    _resetThemeRegistryForTests(b.monaco)
    registerDesktopThemes(a.monaco)
    registerDesktopThemes(b.monaco)
    expect(a.calls).toHaveLength(BUILTIN_DESKTOP_THEMES.length)
    expect(b.calls).toHaveLength(BUILTIN_DESKTOP_THEMES.length)
  })
})

/* ───── parseThemeJson ───────────────────────────────────────────────────── */

describe('parseThemeJson', () => {
  it('accepts a valid blob and normalizes id, mode, colors', () => {
    const r = parseThemeJson(VALID_JSON)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.theme.id).toBe('shogo-user-my-cool-theme')
    expect(r.theme.label).toBe('My Cool Theme')
    expect(r.theme.mode).toBe('dark')
    expect(r.theme.origin).toBe('custom')
    expect(r.theme.definition.base).toBe('vs-dark')
    expect(r.theme.definition.inherit).toBe(true)
    // Hex normalization: caller wrote `eeeeee`, we should prepend #.
    expect(r.theme.definition.colors['editor.foreground']).toBe('#eeeeee')
    expect(r.theme.definition.colors['editor.background']).toBe('#101010')
  })

  it('defaults inherit to true when omitted', () => {
    const blob = JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#000000' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.definition.inherit).toBe(true)
  })

  it('honors inherit:false', () => {
    const blob = JSON.stringify({ base: 'vs-dark', inherit: false, colors: { 'editor.background': '#000000' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.definition.inherit).toBe(false)
  })

  it('falls back to "Custom Theme" when no name is provided', () => {
    const blob = JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#000000' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.theme.label).toBe('Custom Theme')
      expect(r.theme.id).toBe('shogo-user-custom-theme')
    }
  })

  it('prefers `name` over `label` when both are present', () => {
    const blob = JSON.stringify({ name: 'Alpha', label: 'Bravo', base: 'vs-dark', colors: { 'editor.background': '#000000' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.label).toBe('Alpha')
  })

  it('infers mode=light from base "vs"', () => {
    const blob = JSON.stringify({ base: 'vs', colors: { 'editor.background': '#ffffff' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.mode).toBe('light')
  })

  it('infers mode=light from base "hc-light"', () => {
    const blob = JSON.stringify({ base: 'hc-light', colors: { 'editor.background': '#ffffff' } })
    const r = parseThemeJson(blob)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.mode).toBe('light')
  })

  it('rejects invalid JSON', () => {
    const r = parseThemeJson('{ not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/i)
  })

  it('rejects non-object JSON (array)', () => {
    const r = parseThemeJson('[1,2,3]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/JSON object/i)
  })

  it('rejects non-object JSON (null)', () => {
    const r = parseThemeJson('null')
    expect(r.ok).toBe(false)
  })

  it('rejects unknown base', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'midnight', colors: {} }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/base/)
  })

  it('rejects missing colors', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/colors/)
  })

  it('rejects colors that are arrays (not plain objects)', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: ['#ff0000'] }))
    expect(r.ok).toBe(false)
  })

  it('rejects a color that is not a valid hex', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': 'red' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/hex/)
  })

  it('accepts 8-digit (RGBA) hex colors', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.selectionBackground': '#a1b2c3d4' } }))
    expect(r.ok).toBe(true)
  })

  it('accepts 3-digit (#RGB) hex colors — parity with CSS / VS Code themes', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.foreground': '#fff', 'editor.background': '000' } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.theme.definition.colors['editor.foreground']).toBe('#fff')
      expect(r.theme.definition.colors['editor.background']).toBe('#000')
    }
  })

  it('accepts 4-digit (#RGBA) hex colors', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.selectionBackground': '#fff8' } }))
    expect(r.ok).toBe(true)
  })

  it('rejects 5-digit hex (between shorthand and full)', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#fffff' } }))
    expect(r.ok).toBe(false)
  })

  it('strips leading # from rule foreground/background (Monaco rule format)', () => {
    const r = parseThemeJson(JSON.stringify({
      base: 'vs-dark',
      colors: { 'editor.background': '#000000' },
      rules: [{ token: 'comment', foreground: '#888888', background: '#111111', fontStyle: 'italic' }],
    }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const rule = r.theme.definition.rules[0]
      expect(rule.foreground).toBe('888888')
      expect(rule.background).toBe('111111')
      // fontStyle is NOT stripped — it's not a color value.
      expect(rule.fontStyle).toBe('italic')
    }
  })

  it('leaves rule foreground without # untouched', () => {
    const r = parseThemeJson(JSON.stringify({
      base: 'vs-dark',
      colors: { 'editor.background': '#000000' },
      rules: [{ token: 'keyword', foreground: 'bb9af7' }],
    }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theme.definition.rules[0].foreground).toBe('bb9af7')
  })

  it('rejects rules that are not an array', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#000000' }, rules: 'nope' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/rules/)
  })

  it('rejects a rule missing a token', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#000000' }, rules: [{ foreground: 'ffffff' }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/token/)
  })

  it('rejects a rule with non-string fontStyle', () => {
    const r = parseThemeJson(JSON.stringify({ base: 'vs-dark', colors: { 'editor.background': '#000000' }, rules: [{ token: 'comment', fontStyle: 7 }] }))
    expect(r.ok).toBe(false)
  })
})

/* ───── slugify ──────────────────────────────────────────────────────────── */

describe('slugify', () => {
  it('lowercases and replaces non-alphanumerics with single hyphens', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify('  Foo   Bar  ')).toBe('foo-bar')
    expect(slugify('A_B.C+D')).toBe('a-b-c-d')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---abc---')).toBe('abc')
  })

  it('truncates to 32 characters', () => {
    const long = 'x'.repeat(100)
    expect(slugify(long)).toHaveLength(32)
  })

  it('returns "theme" for inputs that slugify to empty', () => {
    expect(slugify('!!!')).toBe('theme')
    expect(slugify('')).toBe('theme')
  })
})

/* ───── registerCustomTheme + storage round-trips ────────────────────────── */

describe('registerCustomTheme', () => {
  it('defines the theme on monaco AND persists it', () => {
    const { monaco, calls } = makeMonaco()
    const storage = makeStorage()
    const parsed = parseThemeJson(VALID_JSON)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const id = registerCustomTheme(monaco, parsed.theme, storage)

    expect(id).toBe('shogo-user-my-cool-theme')
    expect(calls).toEqual([{ name: id, data: parsed.theme.definition }])
    expect(storage.read()).toHaveLength(1)
    expect(storage.read()[0].id).toBe(id)
  })

  it('replaces a prior theme with the same id (no duplicates)', () => {
    const { monaco } = makeMonaco()
    const storage = makeStorage()
    const first = parseThemeJson(VALID_JSON)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    registerCustomTheme(monaco, first.theme, storage)

    // Re-import same name, different background.
    const second = parseThemeJson(JSON.stringify({
      name: 'My Cool Theme',
      base: 'vs-dark',
      colors: { 'editor.background': '#abcdef' },
    }))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    registerCustomTheme(monaco, second.theme, storage)

    const stored = storage.read()
    expect(stored).toHaveLength(1)
    expect(stored[0].definition.colors['editor.background']).toBe('#abcdef')
  })
})

/* ───── loadCustomThemes ─────────────────────────────────────────────────── */

describe('loadCustomThemes', () => {
  it('replays every persisted theme onto a fresh monaco', () => {
    const seed: ThemeDescriptor[] = [
      { id: 'shogo-user-a', label: 'A', mode: 'dark',  origin: 'custom', definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#000000' } } },
      { id: 'shogo-user-b', label: 'B', mode: 'light', origin: 'custom', definition: { base: 'vs',      inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } } },
    ]
    const storage = makeStorage(seed)
    const { monaco, calls } = makeMonaco()

    const out = loadCustomThemes(monaco, storage)

    expect(out).toHaveLength(2)
    expect(calls.map(c => c.name)).toEqual(['shogo-user-a', 'shogo-user-b'])
  })

  it('is a no-op when storage is empty', () => {
    const { monaco, calls } = makeMonaco()
    const out = loadCustomThemes(monaco, makeStorage())
    expect(out).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('loadCustomThemes — resilience to bad data', () => {
  it('skips malformed descriptors (missing definition / wrong shape)', () => {
    // We bypass the public makeStorage helper because we want to plant
    // entries that are typed-correctly at the boundary but rotten inside.
    const bad = [
      { id: '', label: 'no-id',     mode: 'dark', origin: 'custom', definition: { base: 'vs-dark', inherit: true, rules: [], colors: {} } },
      { id: 'shogo-user-x', label: 'bad-base', mode: 'dark', origin: 'custom', definition: { base: 'midnight', inherit: true, rules: [], colors: {} } },
      { id: 'shogo-user-y', label: 'no-colors', mode: 'dark', origin: 'custom', definition: { base: 'vs-dark', inherit: true, rules: [] } },
      { id: 'shogo-user-z', label: 'ok', mode: 'dark', origin: 'custom', definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#000000' } } },
    ] as unknown as ThemeDescriptor[]
    const storage = makeStorage(bad)
    const { monaco, calls } = makeMonaco()

    const out = loadCustomThemes(monaco, storage)

    // Only the well-formed entry is registered.
    expect(out.map(t => t.id)).toEqual(['shogo-user-z'])
    expect(calls.map(c => c.name)).toEqual(['shogo-user-z'])
  })

  it('catches defineTheme errors so one bad theme cannot brick startup', () => {
    let count = 0
    const calls: string[] = []
    const monaco: MonacoLike = {
      editor: {
        defineTheme(name) {
          calls.push(name)
          // Throw on the first registration to simulate a Monaco rejection.
          if (count++ === 0) throw new Error('boom')
        },
      },
    }
    const seed: ThemeDescriptor[] = [
      { id: 'shogo-user-explodes', label: 'X', mode: 'dark', origin: 'custom',
        definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#000000' } } },
      { id: 'shogo-user-survives', label: 'Y', mode: 'dark', origin: 'custom',
        definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#111111' } } },
    ]

    // Silence the warn we know fires.
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const out = loadCustomThemes(monaco, makeStorage(seed))
      expect(out.map(t => t.id)).toEqual(['shogo-user-survives'])
      expect(calls).toEqual(['shogo-user-explodes', 'shogo-user-survives'])
    } finally {
      console.warn = origWarn
    }
  })
})

/* ───── listAvailableThemes ──────────────────────────────────────────────── */

describe('listAvailableThemes', () => {
  it('returns built-ins first, then custom themes', () => {
    const custom: ThemeDescriptor = {
      id: 'shogo-user-z', label: 'Z', mode: 'dark', origin: 'custom',
      definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#000000' } },
    }
    const storage = makeStorage([custom])
    const all = listAvailableThemes(storage)

    expect(all.slice(0, BUILTIN_DESKTOP_THEMES.length)).toEqual(BUILTIN_DESKTOP_THEMES)
    expect(all[all.length - 1]).toEqual(custom)
  })
})

/* ───── defaultStorage tolerance ─────────────────────────────────────────── */

describe('defaultStorage', () => {
  type LSGlobal = { localStorage?: Storage }

  const KEY = 'shogo.ide.customThemes'

  function withMockLocalStorage(store: Map<string, string>) {
    const ls: Storage = {
      length: store.size,
      clear() { store.clear() },
      getItem(k) { return store.has(k) ? store.get(k)! : null },
      key(i) { return Array.from(store.keys())[i] ?? null },
      removeItem(k) { store.delete(k) },
      setItem(k, v) { store.set(k, v) },
    }
    ;(globalThis as LSGlobal).localStorage = ls
  }

  beforeEach(() => {
    delete (globalThis as LSGlobal).localStorage
  })

  it('returns [] when localStorage is unavailable', () => {
    expect(defaultStorage().read()).toEqual([])
  })

  it('returns [] when stored JSON is malformed', () => {
    withMockLocalStorage(new Map([[KEY, '{not-json']]))
    expect(defaultStorage().read()).toEqual([])
  })

  it('returns [] when stored value is not an array', () => {
    withMockLocalStorage(new Map([[KEY, JSON.stringify({ a: 1 })]]))
    expect(defaultStorage().read()).toEqual([])
  })

  it('round-trips an array through write/read', () => {
    withMockLocalStorage(new Map())
    const storage = defaultStorage()
    const theme: ThemeDescriptor = {
      id: 'shogo-user-x', label: 'X', mode: 'dark', origin: 'custom',
      definition: { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#101010' } },
    }
    storage.write([theme])
    expect(storage.read()).toEqual([theme])
  })

  it('write() on a localStorage that throws (quota) does not throw to the caller', () => {
    const ls: Storage = {
      length: 0,
      clear() {},
      getItem() { return null },
      key() { return null },
      removeItem() {},
      setItem() { throw new Error('QuotaExceeded') },
    }
    ;(globalThis as LSGlobal).localStorage = ls
    expect(() => defaultStorage().write([])).not.toThrow()
  })
})
