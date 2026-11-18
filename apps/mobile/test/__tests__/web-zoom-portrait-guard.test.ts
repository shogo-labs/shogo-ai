// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-405 — phone web must not zoom and must not stay in landscape.
//
// The web shell is the only place these can be enforced: `user-scalable=no` /
// `maximum-scale=1` cover input-focus auto-zoom, `touch-action` covers
// double-tap, and the gesture/touchmove guard covers iOS pinch (which has
// ignored the viewport meta since iOS 10). A browser tab can never be locked
// to portrait, so landscape phones get the rotate prompt instead. Tablets and
// desktop keep landscape and their own browser zoom.
//
// `e2e/local/web-shell-zoom-portrait.test.ts` renders this same CSS and script
// in a real phone-sized browser and asserts the behaviour; this file covers the
// markup/config wiring and the post-export path that deploys it.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LANDSCAPE_OVERLAY_HTML,
  LANDSCAPE_OVERLAY_ID,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
} from '../../scripts/web-shell-guards'

const mobileDir = fileURLToPath(new URL('../..', import.meta.url))

const htmlShell = readFileSync(join(mobileDir, 'app', '+html.tsx'), 'utf8')
const injectAnalytics = readFileSync(join(mobileDir, 'scripts', 'inject-analytics.js'), 'utf8')
const appJson = JSON.parse(readFileSync(join(mobileDir, 'app.json'), 'utf8')).expo as Record<string, any>
const manifest = JSON.parse(readFileSync(join(mobileDir, 'public', 'manifest.json'), 'utf8'))

describe('SHO-405 phone web: no zoom', () => {
  test('the viewport meta refuses pinch and input-focus zoom', () => {
    expect(htmlShell).toContain('maximum-scale=1')
    expect(htmlShell).toContain('user-scalable=no')
  })

  test('the shell renders the shared CSS and guard script', () => {
    expect(htmlShell).toContain('id={PHONE_GUARD_STYLE_ID}')
    expect(htmlShell).toContain('__html: PHONE_VIEWPORT_GUARD_CSS')
    expect(htmlShell).toContain('__html: ZOOM_GUARD_SCRIPT')
    expect(htmlShell).toContain('[ZOOM_GUARD_ATTRIBUTE]')
    expect(htmlShell).toContain('__html: LANDSCAPE_OVERLAY_HTML')
  })

  test('CSS kills pinch and double-tap zoom below the whole app', () => {
    expect(PHONE_VIEWPORT_GUARD_CSS).toContain('html{touch-action:pan-x pan-y')
    expect(PHONE_VIEWPORT_GUARD_CSS).toContain('-webkit-text-size-adjust:100%')
  })

  test('form controls are at least 16px on touch devices, so iOS never auto-zooms them', () => {
    // One rule instead of a font-size edit at ~30 `TextInput` call sites.
    const rule = PHONE_VIEWPORT_GUARD_CSS.match(/@media \(pointer:coarse\)\{([^@]*?)\}\}/)
    expect(rule?.[1] ?? '').toContain('font-size:max(16px,1em)!important')
    expect(rule?.[1] ?? '').toContain('textarea')
  })

  test('the guard script only engages on touch devices, so desktop keeps browser zoom', () => {
    expect(ZOOM_GUARD_SCRIPT).toContain("matchMedia('(pointer: coarse)').matches")
    expect(ZOOM_GUARD_SCRIPT).toContain('if (!window.matchMedia')
    expect(ZOOM_GUARD_SCRIPT).toContain('gesturestart')
    expect(ZOOM_GUARD_SCRIPT).toContain('touchmove')
    expect(ZOOM_GUARD_SCRIPT).toContain('event.ctrlKey')
    expect(ZOOM_GUARD_SCRIPT).toContain('preventDefault()')
  })
})

describe('SHO-405 phone web: no landscape', () => {
  test('the rotate prompt is markup the CSS can reveal', () => {
    expect(LANDSCAPE_OVERLAY_ID).toBe('shogo-lock-portrait')
    expect(LANDSCAPE_OVERLAY_HTML).toContain(`id="${LANDSCAPE_OVERLAY_ID}"`)
    expect(PHONE_VIEWPORT_GUARD_CSS).toContain(`#${LANDSCAPE_OVERLAY_ID}{display:none`)
  })

  test('it only appears on coarse-pointer phones in landscape, never on desktop or tablets', () => {
    const overlay = PHONE_VIEWPORT_GUARD_CSS.match(
      /@media \(orientation:landscape\)[^{]*\{#shogo-lock-portrait\{display:flex\}\}/,
    )
    expect(overlay?.[0] ?? '').toContain('max-height:500px')
    expect(overlay?.[0] ?? '').toContain('pointer:coarse')
  })

  test('an installed PWA asks the OS for portrait', () => {
    expect(manifest.orientation).toBe('portrait')
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toContain('192x192')
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toContain('512x512')
    for (const icon of manifest.icons as { src: string }[]) {
      expect(existsSync(join(mobileDir, 'public', icon.src.replace(/^\//, '')))).toBe(true)
    }
    expect(htmlShell).toContain('<link rel="manifest" href="/manifest.json" />')
  })

  test('native phones ship portrait while iPads keep all four orientations', () => {
    expect(appJson.orientation).toBe('portrait')
    expect(appJson.ios.supportsTablet).toBe(true)
    expect(appJson.ios.infoPlist['UISupportedInterfaceOrientations~ipad']).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ])
  })
})

describe('SHO-405 deployed shell', () => {
  // Expo's "single" export strips <script> tags from +html.tsx and has dropped
  // other customizations, so the deployed dist/index.html is patched post-export.
  // Run that patch for real, in an isolated copy of the scripts directory.
  function runInjector(html: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-web-shell-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      mkdirSync(join(dir, 'dist'))
      for (const file of ['inject-analytics.js', 'web-shell-guards.js']) {
        copyFileSync(join(mobileDir, 'scripts', file), join(dir, 'scripts', file))
      }
      writeFileSync(join(dir, 'dist', 'index.html'), html)
      execFileSync('node', [join(dir, 'scripts', 'inject-analytics.js')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, EXPO_PUBLIC_GA4_ID: '', EXPO_PUBLIC_FB_PIXEL_ID: '' },
      })
      return readFileSync(join(dir, 'dist', 'index.html'), 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

  const BARE_EXPORT =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"></head><body><div id="root"></div></body></html>'

  test('a stripped shell gets the guard style, prompt and script exactly once, in the right places', () => {
    const injected = runInjector(BARE_EXPORT)

    expect(count(injected, ZOOM_GUARD_ATTRIBUTE)).toBe(1)
    expect(injected.indexOf(ZOOM_GUARD_ATTRIBUTE)).toBeLessThan(injected.indexOf('</head>'))

    expect(count(injected, `id="${PHONE_GUARD_STYLE_ID}"`)).toBe(1)
    expect(injected.indexOf(PHONE_GUARD_STYLE_ID)).toBeLessThan(injected.indexOf('</head>'))

    expect(count(injected, `id="${LANDSCAPE_OVERLAY_ID}"`)).toBe(1)
    expect(injected.indexOf(`id="${LANDSCAPE_OVERLAY_ID}"`)).toBeGreaterThan(injected.indexOf('<body'))
  })

  test('running the post-export step on an intact shell changes nothing', () => {
    const intact = BARE_EXPORT.replace(
      '</head>',
      `<style id="${PHONE_GUARD_STYLE_ID}">${PHONE_VIEWPORT_GUARD_CSS}</style></head>`,
    ).replace('<body>', `<body>${LANDSCAPE_OVERLAY_HTML}`)

    const once = runInjector(intact)
    const twice = runInjector(once)

    for (const injected of [once, twice]) {
      expect(count(injected, ZOOM_GUARD_ATTRIBUTE)).toBe(1)
      expect(count(injected, `id="${PHONE_GUARD_STYLE_ID}"`)).toBe(1)
      expect(count(injected, `id="${LANDSCAPE_OVERLAY_ID}"`)).toBe(1)
    }
    expect(twice).toContain(ZOOM_GUARD_SCRIPT)
    expect(twice).toContain(PHONE_VIEWPORT_GUARD_CSS)
    expect(injectAnalytics).toContain("require('./web-shell-guards')")
  })
})
