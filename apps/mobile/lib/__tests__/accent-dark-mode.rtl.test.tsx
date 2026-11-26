// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-575 acceptance — the orange the user actually gets in dark mode.
 *
 * `accent-parity.test.ts` pins the four token sources to one value. That is
 * necessary but not sufficient: the complaint was about what gets painted, so
 * this spec renders the two paths the UI reads the accent through and asserts
 * the colour that comes out.
 *
 *  - `useAccentColors()` — the concrete `rgb()` string handed to props and
 *    inline styles, which is how the canvas "Update available" bar
 *    (`CanvasWebView`) and the chat-session selection gradient
 *    (`ChatSessionPicker`) paint themselves.
 *  - `getAccentVars()` — the CSS vars `GluestackUIProvider` receives, i.e. the
 *    native side of `--color-primary`; on web the same vars are written by
 *    `applyAccentToWeb` and come from `global.css`.
 *
 * Both must be #E27927 in dark mode, the same orange the update bar showed
 * before SHO-544 moved every bar onto `primary`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { createElement } from 'react'

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentTripletToRgb,
  resolveAccentWithoutContext,
  withAlpha,
} from '../accent-themes'
import { getAccentVars, useAccentColors } from '../../contexts/accent-theme'

/** The brand orange: the app icon, `--color-brand-landing`, the old update bar. */
const BRAND_RGB = 'rgb(226, 121, 39)'
const BRAND_TRIPLET = '226 121 39'
/** The peach that shipped in dark mode before this card. */
const PEACH_TRIPLET = '240 144 80'

function setDark(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark)
}

const GLOBAL_CSS = readFileSync(resolve(import.meta.dir, '../../global.css'), 'utf8')

/** Source of the first `{…}` block that follows `marker`. */
function bracedBlockAfter(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`marker not found: ${marker}`)
  const start = source.indexOf('{', markerIndex)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error(`unbalanced block after marker: ${marker}`)
}

/**
 * Applies the real `:root` / `.dark` variable blocks from `global.css` to the
 * document and returns what a `bg-primary` element (desktop update banner,
 * buttons, spinners, the composer send button) actually resolves to.
 */
function resolvedPrimaryClassColour(): { light: string; dark: string; cleanup: () => void } {
  const style = document.createElement('style')
  style.textContent = `:root{${bracedBlockAfter(GLOBAL_CSS, '\n:root {')}}\n.dark{${bracedBlockAfter(
    GLOBAL_CSS,
    '\n.dark {',
  )}}`
  document.head.appendChild(style)

  const element = document.createElement('div')
  element.className = 'bg-primary'
  element.style.backgroundColor = 'rgb(var(--color-primary))'
  document.body.appendChild(element)

  setDark(false)
  const light = getComputedStyle(element).backgroundColor
  setDark(true)
  const dark = getComputedStyle(element).backgroundColor

  return {
    light,
    dark,
    cleanup: () => {
      element.remove()
      style.remove()
      setDark(false)
    },
  }
}

/**
 * Renders the hook the real consumers use and exposes its output as data
 * attributes — happy-dom has no layout, so the assertion is on the value the
 * component would hand to `style`/`backgroundColor`.
 */
function renderAccent() {
  function Probe() {
    const accent = useAccentColors()
    return createElement('div', {
      'data-testid': 'accent-probe',
      'data-primary': accent.primary,
      'data-foreground': accent.primaryForeground,
      'data-ring': accent.ring,
    })
  }
  const { getByTestId, unmount } = render(createElement(Probe))
  const element = getByTestId('accent-probe')
  return {
    primary: element.getAttribute('data-primary'),
    foreground: element.getAttribute('data-foreground'),
    ring: element.getAttribute('data-ring'),
    unmount,
  }
}

describe('SHO-575: the default accent is the brand orange in dark mode', () => {
  test('dark mode paints #E27927, not the peach', () => {
    setDark(true)
    const accent = renderAccent()
    expect(accent.primary).toBe(BRAND_RGB)
    expect(accent.ring).toBe(BRAND_RGB)
    expect(accent.foreground).toBe('rgb(255, 255, 255)')
    expect(accent.primary).not.toBe(accentTripletToRgb(PEACH_TRIPLET))
    accent.unmount()
  })

  test('light mode is the same orange — the two themes no longer differ', () => {
    setDark(false)
    const light = renderAccent()
    expect(light.primary).toBe(BRAND_RGB)
    light.unmount()

    setDark(true)
    const dark = renderAccent()
    expect(dark.primary).toBe(light.primary)
    expect(dark.ring).toBe(light.ring)
    dark.unmount()
  })

  test('the CSS vars handed to the native provider are the brand triplet in both modes', () => {
    const light = getAccentVars(DEFAULT_ACCENT, 'light')
    const dark = getAccentVars(DEFAULT_ACCENT, 'dark')
    expect(dark).toEqual(light)
    expect(dark['--color-primary']).toBe(BRAND_TRIPLET)
    expect(dark['--color-ring']).toBe(BRAND_TRIPLET)
    expect(dark['--color-primary-foreground']).toBe('255 255 255')
  })

  test('the no-providers fallback (root error boundary) is the brand orange in dark', () => {
    setDark(true)
    expect(resolveAccentWithoutContext().primary).toBe(BRAND_RGB)
    setDark(false)
    expect(resolveAccentWithoutContext().primary).toBe(BRAND_RGB)
  })

  test('the chat-session selection gradient tints with the accent, not the peach', () => {
    setDark(true)
    const accent = renderAccent()
    expect(withAlpha(accent.primary, 0.1)).toBe('rgba(226, 121, 39, 0.1)')
    expect(withAlpha(accent.primary, 0)).toBe('rgba(226, 121, 39, 0)')
    accent.unmount()
  })

  test('the accent is the same triplet as --color-brand-landing in both themes', () => {
    const css = readFileSync(resolve(import.meta.dir, '../../global.css'), 'utf8')
    const brandlanding = [...css.matchAll(/--color-brand-landing:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    )
    expect(brandlanding.length).toBeGreaterThanOrEqual(2)
    for (const triplet of brandlanding) expect(triplet).toBe(BRAND_TRIPLET)
    expect(ACCENT_PRESETS[DEFAULT_ACCENT].dark.primary).toBe(BRAND_TRIPLET)
  })

  test('a bg-primary surface resolves to the brand orange in dark mode', () => {
    const resolved = resolvedPrimaryClassColour()
    /** Channel values, so `rgb(226 121 39)` and `rgb(226, 121, 39)` both match. */
    const channels = (color: string) => (color.match(/\d+/g) ?? []).map(Number)
    try {
      expect(channels(resolved.light)).toEqual([226, 121, 39])
      expect(channels(resolved.dark)).toEqual([226, 121, 39])
      expect(channels(resolved.dark)).not.toEqual([240, 144, 80])
    } finally {
      resolved.cleanup()
    }
  })

  test('only the default accent changed — the others keep their per-theme tints', () => {
    const expected = {
      blue: { light: '37 99 235', dark: '33 150 243' },
      purple: { light: '124 58 237', dark: '167 139 250' },
      teal: { light: '13 148 136', dark: '45 212 191' },
      rose: { light: '225 29 72', dark: '251 113 133' },
    } as const
    for (const [name, tints] of Object.entries(expected)) {
      const preset = ACCENT_PRESETS[name as keyof typeof expected]
      expect(preset.light.primary).toBe(tints.light)
      expect(preset.dark.primary).toBe(tints.dark)
    }
  })
})
