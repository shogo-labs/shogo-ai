// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../docker/shogo-runtime-env.sh')
const MARKER = '<!--shogo-runtime-env-->'

function render(env: Record<string, string>, html = `<html><head>${MARKER}<title>x</title></head><body></body></html>`) {
  const path = join(mkdtempSync(join(tmpdir(), 'shogo-runtime-env-')), 'index.html')
  writeFileSync(path, html)
  const result = Bun.spawnSync(['sh', script], {
    env: { PATH: process.env.PATH ?? '', SHOGO_HTML_PATH: path, ...env },
  })
  return { exitCode: result.exitCode, stderr: result.stderr.toString(), html: readFileSync(path, 'utf8') }
}

describe('shogo-runtime-env entrypoint', () => {
  test('injects the environment and replaces the marker', () => {
    const { exitCode, html } = render({ SHOGO_APP_ENV: 'production_web', SHOGO_APP_VERSION: '1.14.2' })
    expect(exitCode).toBe(0)
    expect(html).not.toContain(MARKER)
    expect(html).toContain(
      '<head><script>window.__SHOGO_ENV__={"appEnv":"production_web","apiUrl":"","appVersion":"1.14.2"};</script><title>',
    )
    expect(html).not.toContain('googletagmanager')
    expect(html).not.toContain('fbq(')
  })

  test('adds GA4 and Facebook Pixel tags only when their IDs are set', () => {
    const { html } = render({ SHOGO_APP_ENV: 'production_web', GA4_MEASUREMENT_ID: 'G-ABC123', FB_PIXEL_ID: '1234567890' })
    expect(html).toContain('googletagmanager.com/gtag/js?id=G-ABC123')
    expect(html).toContain("gtag('config','G-ABC123')")
    expect(html).toContain("fbq('init','1234567890')")
  })

  test('rejects values that could break out of the script tag', () => {
    const { exitCode, stderr, html } = render({ SHOGO_APP_ENV: 'prod"</script><script>alert(1)' })
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('SHOGO_APP_ENV')
    expect(html).toContain(MARKER)
  })

  test('is a no-op when the marker is missing', () => {
    const original = '<html><head></head></html>'
    const { exitCode, html } = render({ SHOGO_APP_ENV: 'staging_web' }, original)
    expect(exitCode).toBe(0)
    expect(html).toBe(original)
  })
})
