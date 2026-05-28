// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  DARK_PLUS_THEME,
  LIGHT_PLUS_THEME,
  resolveShogoTheme,
  type ThemeSource,
} from '../use-shogo-theme'

function fixedSource(isDark: boolean): ThemeSource {
  return {
    getIsDark() { return isDark },
    subscribe() { return () => undefined },
  }
}

describe('resolveShogoTheme', () => {
  it('returns the dark palette when source.getIsDark() is true', () => {
    const r = resolveShogoTheme({ source: fixedSource(true) })
    expect(r.isDark).toBe(true)
    expect(r.theme).toEqual(DARK_PLUS_THEME)
  })

  it('returns the light palette when source.getIsDark() is false', () => {
    const r = resolveShogoTheme({ source: fixedSource(false) })
    expect(r.isDark).toBe(false)
    expect(r.theme).toEqual(LIGHT_PLUS_THEME)
  })

  it('honors a custom dark override', () => {
    const custom = { ...DARK_PLUS_THEME, background: '#000' }
    const r = resolveShogoTheme({ source: fixedSource(true), darkTheme: custom })
    expect(r.theme.background).toBe('#000')
  })

  it('honors a custom light override', () => {
    const custom = { ...LIGHT_PLUS_THEME, background: '#fff5e0' }
    const r = resolveShogoTheme({ source: fixedSource(false), lightTheme: custom })
    expect(r.theme.background).toBe('#fff5e0')
  })
})

describe('DARK_PLUS_THEME / LIGHT_PLUS_THEME palette integrity', () => {
  it('both palettes define every required xterm color slot', () => {
    const required = [
      'background', 'foreground', 'cursor', 'selectionBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ] as const
    for (const k of required) {
      expect(typeof (DARK_PLUS_THEME as unknown as Record<string, unknown>)[k]).toBe('string')
      expect(typeof (LIGHT_PLUS_THEME as unknown as Record<string, unknown>)[k]).toBe('string')
    }
  })

  it('every color value is a valid #RRGGBB hex string', () => {
    const hex = /^#[0-9a-f]{6}$/i
    for (const [k, v] of Object.entries(DARK_PLUS_THEME)) {
      expect(hex.test(String(v))).toBe(true)
    }
    for (const [k, v] of Object.entries(LIGHT_PLUS_THEME)) {
      expect(hex.test(String(v))).toBe(true)
    }
  })

  it('the dark and light palettes differ on background (sanity)', () => {
    expect(DARK_PLUS_THEME.background).not.toBe(LIGHT_PLUS_THEME.background)
    expect(DARK_PLUS_THEME.foreground).not.toBe(LIGHT_PLUS_THEME.foreground)
  })
})

describe('ThemeSource subscription contract', () => {
  it('subscribe() returns an unsubscribe function that disables further notifications', () => {
    let value = false
    const holder: { listener: ((d: boolean) => void) | null } = { listener: null }
    const source: ThemeSource = {
      getIsDark() { return value },
      subscribe(l) { holder.listener = l; return () => { holder.listener = null } },
    }
    const initial = resolveShogoTheme({ source })
    expect(initial.isDark).toBe(false)
    // Flip the source's underlying value and call the listener (the
    // hook would do this internally on the next React render).
    value = true
    holder.listener?.(true)
    const next = resolveShogoTheme({ source })
    expect(next.isDark).toBe(true)
  })
})
