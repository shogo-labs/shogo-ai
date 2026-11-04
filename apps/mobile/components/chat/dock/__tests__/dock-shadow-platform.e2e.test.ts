// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-321 e2e: what the dock card's shadow actually compiles to.
 *
 * `dock-shadow-token.test.ts` pins the config; this spec pins the OUTPUT, per
 * platform, by running the real Tailwind build over the real config the same
 * way NativeWind does (`NATIVEWIND_OS` selects the native plugin path). That
 * distinction matters: NativeWind's shadow plugin emits only the FIRST valid
 * layer of a `box-shadow` as a native shadow (`ast.find(valid)` in
 * nativewind/dist/tailwind/shadows.js) and derives Android elevation from that
 * layer's blur radius, so a correct-looking token can still compile to a
 * 2px hairline on iOS and a 24dp drop shadow on Android.
 *
 * Acceptance criteria covered: light theme is warm (never pure black), dark
 * theme still overrides with `shadow-md`, and iOS/Android keep a real lift.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mobileRoot = resolve(import.meta.dir, '../../../..')
const workDir = mkdtempSync(join(tmpdir(), 'sho321-shadow-'))

const nativeOs = ['ios', 'android'] as const
type Platform = (typeof nativeOs)[number] | 'web'

const compiled = new Map<Platform, string>()

/** Compile the dock classes for one platform through the app's real config. */
const compileDockShadow = (platform: Platform): string => {
  const cached = compiled.get(platform)
  if (cached) return cached

  const content = join(workDir, 'content.html')
  writeFileSync(content, '<div class="shadow-dock shadow-md dark:shadow-md"></div>\n')

  const input = join(workDir, 'in.css')
  writeFileSync(input, '@tailwind utilities;\n')

  const config = join(workDir, `tw.${platform}.cjs`)
  writeFileSync(
    config,
    [
      `const base = require(${JSON.stringify(join(mobileRoot, 'tailwind.config'))})`,
      `module.exports = { ...base, content: [${JSON.stringify(content)}] }`,
      '',
    ].join('\n'),
  )

  const out = join(workDir, `out.${platform}.css`)
  execFileSync(
    process.execPath,
    [
      require.resolve('tailwindcss/lib/cli.js'),
      '--config',
      config,
      '--input',
      input,
      '--output',
      out,
    ],
    {
      cwd: mobileRoot,
      env: platform === 'web' ? process.env : { ...process.env, NATIVEWIND_OS: platform },
      stdio: 'pipe',
    },
  )

  const css = readFileSync(out, 'utf8')
  compiled.set(platform, css)
  return css
}

/** The declaration block for one selector, or '' when the utility was not emitted. */
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('dock shadow compiles per platform (SHO-321)', () => {
  for (const platform of nativeOs) {
    test(`${platform}: the ambient layer survives, so the dock keeps its lift`, () => {
      const dock = rule(compileDockShadow(platform), '.shadow-dock')

      expect(dock).toContain('-rn-shadow-offset-height: 8px')
      expect(dock).toContain('-rn-shadow-radius: 24px')
      // Warm stone, never a black halo.
      expect(dock).toContain('rgba(28, 25, 23, 0.04)')
      expect(dock).not.toContain('rgba(0, 0, 0')
      // The tight 1px layer must not be the one that leads.
      expect(dock).not.toContain('-rn-shadow-radius: 2px')
    })
  }

  test('android: elevation is pinned, not derived from the 24px blur', () => {
    expect(rule(compileDockShadow('android'), '.shadow-dock')).toContain('-rn-elevation: 3px')
  })

  test('web: both layers, warm, with no pure-black layer', () => {
    const dock = rule(compileDockShadow('web'), '.shadow-dock')

    expect(dock).toContain('0 8px 24px rgba(28, 25, 23, 0.04)')
    expect(dock).toContain('0 1px 2px rgba(28, 25, 23, 0.04)')
    expect(dock).not.toContain('rgba(0, 0, 0')
  })

  test('dark mode still overrides with the unchanged shadow-md', () => {
    const dark = rule(compileDockShadow('web'), '.dark\\:shadow-md:is(.dark *)')

    expect(dark).toContain('box-shadow')
    expect(dark).toContain('rgba(0, 0, 0, 0.35)')
  })
})
