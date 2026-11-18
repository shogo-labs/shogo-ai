// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `PREVIEW_BASE_PATH` (SHO-418): the built app has to work under a path prefix
 * because generated app code calls absolute `/api/...`.
 */

import { describe, expect, test } from 'bun:test'
import { injectPreviewBasePath, previewBasePath, stripPreviewBasePath } from '../preview-base-path'

const DOC = '<!doctype html><html><head><meta charset="utf-8"><title>app</title></head><body><div id="root"></div><script type="module" src="./assets/index-abc.js"></script></body></html>'

describe('previewBasePath', () => {
  test.each([
    ['/s/abc123', '/s/abc123'],
    ['/s/abc123/', '/s/abc123'],
    ['s/abc123', '/s/abc123'],
    ['  /s/abc123  ', '/s/abc123'],
  ])('%p normalizes to %p', (raw, expected) => {
    expect(previewBasePath({ PREVIEW_BASE_PATH: raw } as NodeJS.ProcessEnv)).toBe(expected)
  })

  test.each([undefined, '', '   ', '/'])('%p means the feature is off', (raw) => {
    expect(previewBasePath({ PREVIEW_BASE_PATH: raw } as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('stripPreviewBasePath', () => {
  test('strips the prefix and keeps the rest of the path', () => {
    expect(stripPreviewBasePath('/s/abc123/api/leads', '/s/abc123')).toBe('/api/leads')
    expect(stripPreviewBasePath('/s/abc123/assets/index-abc.js', '/s/abc123')).toBe('/assets/index-abc.js')
  })

  test('the bare prefix becomes the root', () => {
    expect(stripPreviewBasePath('/s/abc123', '/s/abc123')).toBe('/')
  })

  test('a path without the prefix is left alone', () => {
    expect(stripPreviewBasePath('/api/leads', '/s/abc123')).toBeNull()
    expect(stripPreviewBasePath('/s/abc1234/api/leads', '/s/abc123')).toBeNull()
  })

  test('no prefix configured means nothing to strip', () => {
    expect(stripPreviewBasePath('/api/leads', null)).toBeNull()
  })
})

describe('injectPreviewBasePath', () => {
  test('is a no-op when the prefix is unset', () => {
    expect(injectPreviewBasePath(DOC, null)).toBe(DOC)
  })

  test('adds a <base href> and the shim inside <head>, before any app script', () => {
    const out = injectPreviewBasePath(DOC, '/s/abc123')
    expect(out).toContain('<base href="/s/abc123/">')
    expect(out).toContain('data-shogo-preview-base="/s/abc123"')
    // Both land before the app's own module script.
    expect(out.indexOf('<base href')).toBeLessThan(out.indexOf('assets/index-abc.js'))
    expect(out.indexOf('data-shogo-preview-base')).toBeLessThan(out.indexOf('assets/index-abc.js'))
    // The document itself is otherwise untouched.
    expect(out).toContain('<div id="root"></div>')
  })

  test('keeps an existing <base> and only adds the shim', () => {
    const withBase = DOC.replace('<head>', '<head><base href="/custom/">')
    const out = injectPreviewBasePath(withBase, '/s/abc123')
    expect(out).toContain('<base href="/custom/">')
    expect(out).not.toContain('<base href="/s/abc123/">')
    expect(out).toContain('data-shogo-preview-base')
  })

  test('is idempotent', () => {
    const once = injectPreviewBasePath(DOC, '/s/abc123')
    expect(injectPreviewBasePath(once, '/s/abc123')).toBe(once)
  })

  test('a fragment with no <head> still gets the shim first', () => {
    const out = injectPreviewBasePath('<div id="root"></div>', '/s/abc123')
    expect(out.startsWith('<base href="/s/abc123/">')).toBe(true)
    expect(out).toContain('data-shogo-preview-base')
  })

  test('the shim only rewrites /api, and only absolute same-origin paths', () => {
    const out = injectPreviewBasePath(DOC, '/s/abc123')
    // The guard is in the emitted source, so assert on it directly.
    expect(out).toContain('u!=="/api"&&u.indexOf("/api/")!==0&&u.indexOf("/api?")!==0')
    expect(out).toContain('window.fetch')
    expect(out).toContain('XMLHttpRequest.prototype.open')
    expect(out).toContain('EventSource')
  })
})
