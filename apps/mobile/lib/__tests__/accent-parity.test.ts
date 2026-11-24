// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo orange is one colour in both themes (SHO-575).
 *
 * The default accent used to have a lighter dark-mode value (#F09050, a peach)
 * while light mode used the brand orange #E27927 — the colour of the app icon
 * and of the update bar before SHO-544 moved every bar onto `primary`. After
 * SHO-544 dark mode painted the peach everywhere, so the accent has to agree
 * with the brand in dark mode too.
 *
 * Four sources define that value independently — the preset the picker writes,
 * `global.css` (web), the gluestack dark overrides (native), and the ui-kit
 * `darkTheme` tokens — plus the composer chrome that names it as a hex. This
 * test pins the preset and asserts every other source agrees with it, so
 * editing one and forgetting another fails here instead of shipping.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ACCENT_PRESETS } from '../accent-themes'
import { CHATGPT_COMPOSER } from '../composer-phone'

const root = resolve(import.meta.dir, '../..')
const repoRoot = resolve(root, '../..')

/** The brand orange: `--color-brand-landing`, the app icon, the old update bar. */
const BRAND_TRIPLET = '226 121 39'
const BRAND_HEX = '#e27927'

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

/** Source from `marker` to the closing brace of the first `{` after it. */
function bracedBlockAfter(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`marker not found: ${marker}`)
  const start = source.indexOf('{', markerIndex)
  if (start < 0) throw new Error(`no block after marker: ${marker}`)
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

/** The value of a CSS custom property inside a block, e.g. `226 121 39`. */
function cssVar(block: string, name: string): string | undefined {
  return block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim()
}

/** The value of a quoted gluestack key inside a block. */
function gluestackVar(block: string, name: string): string | undefined {
  return block.match(new RegExp(`'${name}'\\s*:\\s*'([^']+)'`))?.[1].trim()
}

/** `226 121 39` → `#e27927`, so a triplet and a hex can be compared. */
function tripletToHex(triplet: string): string {
  const channels = triplet.trim().split(/\s+/).map(Number)
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

const presetDark = ACCENT_PRESETS['shogo-orange'].dark
const presetLight = ACCENT_PRESETS['shogo-orange'].light

describe('shogo-orange accent parity (SHO-575)', () => {
  test('the dark preset is the brand orange, not a lighter peach', () => {
    expect(presetDark.primary).toBe(BRAND_TRIPLET)
    expect(presetDark.ring).toBe(BRAND_TRIPLET)
    expect(presetDark.primaryForeground).toBe('255 255 255')
  })

  test('light mode is unchanged', () => {
    expect(presetLight.primary).toBe(BRAND_TRIPLET)
    expect(presetLight.ring).toBe(BRAND_TRIPLET)
  })

  test('global.css .dark agrees with the preset', () => {
    const darkBlock = bracedBlockAfter(read('global.css'), '\n.dark {')
    expect(cssVar(darkBlock, '--color-primary')).toBe(presetDark.primary)
    expect(cssVar(darkBlock, '--color-ring')).toBe(presetDark.ring)
    expect(cssVar(darkBlock, '--color-primary-foreground')).toBe(presetDark.primaryForeground)
  })

  test('the gluestack dark overrides agree with the preset', () => {
    const darkBlock = bracedBlockAfter(
      read('components/ui/gluestack-ui-provider/config.ts'),
      'dark: vars(',
    )
    expect(gluestackVar(darkBlock, '--color-primary')).toBe(presetDark.primary)
    expect(gluestackVar(darkBlock, '--color-ring')).toBe(presetDark.ring)
    expect(gluestackVar(darkBlock, '--color-primary-foreground')).toBe(
      presetDark.primaryForeground,
    )
  })

  test('the ui-kit darkTheme tokens are the same hex', () => {
    const darkTheme = bracedBlockAfter(
      readFileSync(resolve(repoRoot, 'packages/ui-kit/src/theme/tokens.ts'), 'utf8'),
      'export const darkTheme',
    )
    const colors = bracedBlockAfter(darkTheme, 'colors: {')
    expect(tripletToHex(presetDark.primary)).toBe(BRAND_HEX)
    expect(colors.match(/primary:\s*'(#[0-9a-fA-F]{6})'/)?.[1].toLowerCase()).toBe(BRAND_HEX)
    expect(colors.match(/ring:\s*'(#[0-9a-fA-F]{6})'/)?.[1].toLowerCase()).toBe(BRAND_HEX)
  })

  test('the native composer chrome uses the brand orange in both modes', () => {
    expect(CHATGPT_COMPOSER.light.sendFill.toLowerCase()).toBe(BRAND_HEX)
    expect(CHATGPT_COMPOSER.light.borderFocus.toLowerCase()).toBe(BRAND_HEX)
    expect(CHATGPT_COMPOSER.dark.sendFill.toLowerCase()).toBe(BRAND_HEX)
    expect(CHATGPT_COMPOSER.dark.borderFocus.toLowerCase()).toBe(BRAND_HEX)
  })

  test('nothing still names the peach, in any spelling', () => {
    const sources = [
      'global.css',
      'lib/accent-themes.ts',
      'lib/composer-phone.ts',
      'components/ui/gluestack-ui-provider/config.ts',
      'components/chat/ChatSessionPicker.tsx',
    ]
    const peach = /f09050|240[ ,]{1,2}144[ ,]{1,2}80/i
    const offenders = sources.filter((path) => peach.test(read(path)))
    expect(offenders).toEqual([])
  })
})
