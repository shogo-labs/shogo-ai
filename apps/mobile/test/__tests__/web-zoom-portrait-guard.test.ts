// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-405 — phone web must not zoom and must not stay in landscape.
//
// The rules live in the web shell, and the shell has two builders: `app/+html.tsx`
// (dev server) and `scripts/inject-analytics.js` (the deployed `dist/index.html`).
// `app.json` sets `web.output: "single"`, which makes the export ignore
// `+html.tsx` *entirely*, so the shipped shell is Expo's default template and the
// post-export step is the one that actually ships. Its fixture below is a real
// `expo export --platform web` index.html, so this file fails if the export
// template ever changes shape or if a guard stops being re-added.
//
// `e2e/local/web-shell-zoom-portrait.test.ts` renders the same CSS and script in a
// real browser at phone, iPad and desktop viewports and asserts the behaviour.

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
  PHONE_MEDIA_QUERY,
  PHONE_VIEWPORT_GUARD_CSS,
  VIEWPORT_META_CONTENT,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
} from '../../scripts/web-shell-guards'

const mobileDir = fileURLToPath(new URL('../..', import.meta.url))

const htmlShell = readFileSync(join(mobileDir, 'app', '+html.tsx'), 'utf8')
const appJson = JSON.parse(readFileSync(join(mobileDir, 'app.json'), 'utf8')).expo as Record<string, any>
const manifest = JSON.parse(readFileSync(join(mobileDir, 'public', 'manifest.json'), 'utf8'))
/** Captured from `expo export --platform web` on this branch — what actually ships before patching. */
const exportedShell = readFileSync(join(mobileDir, 'test', 'fixtures', 'expo-single-export-index.html'), 'utf8')

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

/** Run the real post-export step against `html`, in an isolated copy of the scripts directory. */
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

describe('SHO-405 the exported shell starts out unguarded', () => {
  // Guards this test file itself: the fixture must be the real, permissive export.
  test('the export template has no zoom limits, manifest link or guard markup', () => {
    expect(exportedShell).toContain('<div id="root"></div>')
    expect(exportedShell).not.toContain('maximum-scale')
    expect(exportedShell).not.toContain('rel="manifest"')
    expect(exportedShell).not.toContain(ZOOM_GUARD_ATTRIBUTE)
    expect(exportedShell).not.toContain(PHONE_GUARD_STYLE_ID)
  })

  test('the dev shell renders the same strings from the shared module', () => {
    expect(htmlShell).toContain('<meta name="viewport" content={VIEWPORT_META_CONTENT} />')
    expect(htmlShell).toContain('<link rel="manifest" href="/manifest.json" />')
    expect(htmlShell).toMatch(/id=\{PHONE_GUARD_STYLE_ID\}/)
    expect(htmlShell).toContain('__html: PHONE_VIEWPORT_GUARD_CSS')
    expect(htmlShell).toContain('__html: ZOOM_GUARD_SCRIPT')
    expect(htmlShell).toContain('__html: LANDSCAPE_OVERLAY_HTML')
  })
})

describe('SHO-405 the post-export step guards the shell that actually ships', () => {
  const patched = runInjector(exportedShell)

  test('the viewport meta is replaced in place, with no global zoom lock', () => {
    expect(count(patched, 'name="viewport"')).toBe(1)
    // The export's own meta has no `viewport-fit=cover`, so this proves the in-place swap.
    expect(exportedShell).not.toContain('viewport-fit=cover')
    expect(patched).toContain(`content="${VIEWPORT_META_CONTENT}"`)
    // `maximum-scale` / `user-scalable` are global: they would also lock real
    // pinch on iPad-sized Blink tablets. The phone lock is the gated CSS + script.
    expect(patched).not.toContain('maximum-scale')
    expect(patched).not.toContain('user-scalable=no')
  })

  test('the manifest link is added, so the portrait PWA lock is live', () => {
    expect(count(patched, 'rel="manifest"')).toBe(1)
    expect(patched.indexOf('rel="manifest"')).toBeLessThan(patched.indexOf('</head>'))
    expect(existsSync(join(mobileDir, 'public', 'manifest.json'))).toBe(true)
  })

  test('the guard style, prompt and script are each added exactly once', () => {
    expect(count(patched, `id="${PHONE_GUARD_STYLE_ID}"`)).toBe(1)
    expect(count(patched, `id="${LANDSCAPE_OVERLAY_ID}"`)).toBe(1)
    expect(count(patched, ZOOM_GUARD_ATTRIBUTE)).toBe(1)

    expect(patched.indexOf(PHONE_GUARD_STYLE_ID)).toBeLessThan(patched.indexOf('</head>'))
    expect(patched.indexOf(ZOOM_GUARD_ATTRIBUTE)).toBeLessThan(patched.indexOf('</head>'))
    expect(patched.indexOf(`id="${LANDSCAPE_OVERLAY_ID}"`)).toBeGreaterThan(patched.indexOf('<body'))
    expect(patched.indexOf(`id="${LANDSCAPE_OVERLAY_ID}"`)).toBeLessThan(patched.indexOf('<div id="root">'))
    expect(patched).toContain(ZOOM_GUARD_SCRIPT)
    expect(patched).toContain(PHONE_VIEWPORT_GUARD_CSS)
    expect(patched).toContain(LANDSCAPE_OVERLAY_HTML)
  })

  test('running it twice does not duplicate anything', () => {
    const twice = runInjector(patched)
    expect(count(twice, 'name="viewport"')).toBe(1)
    expect(count(twice, 'rel="manifest"')).toBe(1)
    expect(count(twice, `id="${PHONE_GUARD_STYLE_ID}"`)).toBe(1)
    expect(count(twice, `id="${LANDSCAPE_OVERLAY_ID}"`)).toBe(1)
    expect(count(twice, ZOOM_GUARD_ATTRIBUTE)).toBe(1)
  })
})

describe('SHO-405 phones only: iPads and desktops keep their zoom', () => {
  test('the viewport meta is not the phone lock, so tablets keep real pinch', () => {
    // Measured with CDP `Input.synthesizePinchGesture` (see the e2e spec): with
    // these two tokens an iPad stayed at visualViewport.scale 1, without them it
    // reaches 2, and the phone stays at 1 either way.
    expect(VIEWPORT_META_CONTENT).not.toContain('maximum-scale')
    expect(VIEWPORT_META_CONTENT).not.toContain('user-scalable')
  })

  test('the phone gate is bounded by viewport size, not just touch', () => {
    expect(PHONE_MEDIA_QUERY).toContain('(pointer: coarse)')
    expect(PHONE_MEDIA_QUERY).toContain('(max-width: 600px)')
    expect(PHONE_MEDIA_QUERY).toContain('(max-height: 500px)')
  })

  test('the CSS rules are scoped to that gate, so an iPad neither loses pinch nor gets 16px inputs', () => {
    // The whole guard block opens with the phone gate, and the zoom/type rules
    // appear exactly once, inside it.
    expect(PHONE_VIEWPORT_GUARD_CSS.startsWith(`@media ${PHONE_MEDIA_QUERY}{`)).toBe(true)
    expect(count(PHONE_VIEWPORT_GUARD_CSS, 'touch-action:pan-x pan-y')).toBe(1)
    expect(count(PHONE_VIEWPORT_GUARD_CSS, 'font-size:max(16px,1em)')).toBe(1)
    const gateBody = PHONE_VIEWPORT_GUARD_CSS.slice(0, PHONE_VIEWPORT_GUARD_CSS.indexOf('\n'))
    expect(gateBody).toContain('touch-action:pan-x pan-y')
    expect(gateBody).toContain('font-size:max(16px,1em)!important')
  })

  test('the script re-reads the same gate on every event', () => {
    expect(ZOOM_GUARD_SCRIPT).toContain(PHONE_MEDIA_QUERY)
    expect(ZOOM_GUARD_SCRIPT).toContain('matchMedia(PHONE)')
    expect(ZOOM_GUARD_SCRIPT).toContain('gesturestart')
    expect(ZOOM_GUARD_SCRIPT).toContain('event.ctrlKey')
    expect(ZOOM_GUARD_SCRIPT).toContain('preventDefault()')
    // Best-effort PWA orientation lock must not run on a tablet either.
    expect(ZOOM_GUARD_SCRIPT).toContain('standalone && isPhone()')
  })
})

describe('SHO-405 portrait-only', () => {
  test('the rotate prompt appears only for coarse-pointer phones in landscape', () => {
    expect(LANDSCAPE_OVERLAY_HTML).toContain(`id="${LANDSCAPE_OVERLAY_ID}"`)
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
