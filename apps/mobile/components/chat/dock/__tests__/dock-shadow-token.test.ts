// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-321: the dock card above the composer is a bordered card sitting on the
 * light theme's warm off-white canvas. Tailwind's `shadow-md` is two pure-black
 * 10% layers, so on light it read as a heavy grey smudge under the card. The
 * three dock surfaces (status zone, blocking zone, team chat's non-floating
 * `RunningAgentsDock`) now use the theme's soft `--shadow-agent` token, which
 * dark mode keeps as today's `shadow-md`.
 *
 * These assertions keep that from regressing: no bare `shadow-md` on the dock
 * card, and the Tailwind token still mirrors the light `--shadow-agent` value
 * in global.css (NativeWind can't resolve a CSS var inside a native shadow, so
 * the value is written out literally in the config).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dir
const read = (...parts: string[]) => readFileSync(join(here, ...parts), 'utf8')

const config = require('../../../../tailwind.config') as {
  theme: { extend: { boxShadow: Record<string, string>; elevation: Record<string, number> } }
}

/** Every class string in a source file that styles a `bg-popover` card. */
const cardClassStrings = (source: string) =>
  [...source.matchAll(/"([^"\n]*bg-popover[^"\n]*)"/g)].map((m) => m[1]!)

const expectDockCardClass = (cls: string) => {
  const tokens = cls.split(/\s+/)
  expect(tokens).toContain('shadow-dock')
  // A bare `shadow-md` is the bug; only the dark variant may use it.
  expect(tokens).not.toContain('shadow-md')
  expect(tokens).toContain('dark:shadow-md')
}

/** Split a box-shadow value into its layers (commas inside `rgb()` stay put). */
const shadowLayers = (value: string) => {
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      layers.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  layers.push(current.trim())
  return layers
}

describe('dock card shadow (SHO-321)', () => {
  test('ChatDock uses the soft token for both dock zones', () => {
    const classes = cardClassStrings(read('../ChatDock.tsx'))
    expect(classes).toHaveLength(2)
    classes.forEach(expectDockCardClass)
  })

  test("team chat's non-floating RunningAgentsDock matches the chat dock", () => {
    const classes = cardClassStrings(read('../../../team-chat/RunningAgentsDock.tsx'))
    expect(classes).toHaveLength(1)
    classes.forEach(expectDockCardClass)
  })

  test('the light theme maps to the soft --shadow-agent token', () => {
    const dock = config.theme.extend.boxShadow.dock
    expect(dock).toBeDefined()

    // First `--shadow-agent` declaration is the light theme's.
    const lightToken = read('../../../../global.css').match(/--shadow-agent:\s*([^;]+);/)?.[1].trim()
    expect(dock).toBe(lightToken)

    // Warm stone tint, not pure black, and nothing above ~5% alpha.
    expect(dock).not.toMatch(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/)
    const alphas = [...dock.matchAll(/rgba\([^)]*?,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]))
    expect(alphas.length).toBeGreaterThan(0)
    alphas.forEach((alpha) => expect(alpha).toBeLessThanOrEqual(0.05))

    // And it is genuinely softer than the shadow-md it replaced.
    expect(dock).not.toContain('0 4px 6px -1px')
  })

  test('native keeps the ambient layer, at a shallower Android elevation', () => {
    const dock = config.theme.extend.boxShadow.dock
    const [firstLayer] = shadowLayers(dock)

    // NativeWind drops every layer but the first on ios/android, so the ambient
    // one has to lead — a 1px layer in front would lose the lift entirely.
    expect(firstLayer!.trim()).toBe('0 8px 24px rgba(28, 25, 23, 0.04)')

    // Android falls back to parsing that layer's blur as dp (24), so the dock
    // pins its own, much shallower elevation instead.
    const elevation = config.theme.extend.elevation?.dock
    expect(elevation).toBe(3)
    expect(elevation).toBeLessThan(Number.parseFloat(firstLayer!.trim().split(/\s+/)[2]!))
  })
})
