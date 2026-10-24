// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { brotliDecompressSync, gunzipSync } from 'zlib'
import { precompress } from './precompress-assets.mjs'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'perf5-'))
  dirs.push(root)
  mkdirSync(join(root, 'static', 'js', 'web'), { recursive: true })
  mkdirSync(join(root, 'static', 'css'), { recursive: true })
  const js = 'export function hello(name) { return "hello " + name }\n'.repeat(400)
  const css = '.button { color: red; padding: 4px 8px; }\n'.repeat(200)
  writeFileSync(join(root, 'static', 'js', 'web', 'index-abc.js'), js)
  writeFileSync(join(root, 'static', 'css', 'web-abc.css'), css)
  writeFileSync(join(root, 'static', 'js', 'web', 'tiny-abc.js'), 'x()\n')
  writeFileSync(join(root, 'static', 'logo-abc.png'), Buffer.alloc(4096, 7))
  return { root, js, css }
}

describe('precompress-assets', () => {
  it('writes .br and .gz copies that decode to the original bytes', () => {
    const { root, js, css } = fixture()
    const jsPath = join(root, 'static', 'js', 'web', 'index-abc.js')
    const cssPath = join(root, 'static', 'css', 'web-abc.css')

    const stats = precompress(root)

    expect(stats.files).toBe(2)
    expect(brotliDecompressSync(readFileSync(`${jsPath}.br`)).toString()).toBe(js)
    expect(gunzipSync(readFileSync(`${jsPath}.gz`)).toString()).toBe(js)
    expect(brotliDecompressSync(readFileSync(`${cssPath}.br`)).toString()).toBe(css)
    expect(gunzipSync(readFileSync(`${cssPath}.gz`)).toString()).toBe(css)
    expect(stats.br).toBeLessThan(stats.gz)
    expect(stats.gz).toBeLessThan(stats.raw)
  })

  it('skips files under 1 KB and non-text assets', () => {
    const { root } = fixture()
    precompress(root)
    expect(existsSync(join(root, 'static', 'js', 'web', 'tiny-abc.js.br'))).toBe(false)
    expect(existsSync(join(root, 'static', 'logo-abc.png.br'))).toBe(false)
    expect(existsSync(join(root, 'static', 'logo-abc.png.gz'))).toBe(false)
  })

  it('does not compress its own output on a second run', () => {
    const { root } = fixture()
    precompress(root)
    const again = precompress(root)
    expect(again.files).toBe(2)
    expect(existsSync(join(root, 'static', 'js', 'web', 'index-abc.js.br.br'))).toBe(false)
    expect(existsSync(join(root, 'static', 'js', 'web', 'index-abc.js.gz.gz'))).toBe(false)
  })
})
