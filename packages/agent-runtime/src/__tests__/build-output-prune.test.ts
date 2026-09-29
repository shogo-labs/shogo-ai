// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILD_OUTPUT_MANIFEST,
  buildOutputManifestPluginSource,
  pruneStaleBuildOutput,
} from '../build-output-prune'

let root: string
let shogoDir: string
let outDir: string
let clock: number

function writeOut(file: string) {
  const abs = join(outDir, file)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, file)
  const t = new Date(clock++ * 1000)
  utimesSync(abs, t, t)
}

/** Simulate one watch rebuild: write its files, then the manifest, then prune. */
function build(files: string[]) {
  for (const f of files) writeOut(f)
  const manifest = join(shogoDir, BUILD_OUTPUT_MANIFEST)
  writeFileSync(manifest, JSON.stringify({ outDir, files }))
  const t = new Date(clock++ * 1000)
  utimesSync(manifest, t, t)
  return pruneStaleBuildOutput(shogoDir)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-'))
  shogoDir = join(root, '.shogo')
  outDir = join(root, 'dist')
  mkdirSync(shogoDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  clock = 1_700_000_000
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('pruneStaleBuildOutput', () => {
  it('keeps the current and previous build, deletes older chunks', () => {
    build(['index.html', 'assets/index-AAAA.js', 'assets/index-AAAA.css'])
    build(['index.html', 'assets/index-BBBB.js', 'assets/index-AAAA.css'])
    const { removed } = build(['index.html', 'assets/index-CCCC.js', 'assets/index-CCCC.css'])

    expect(removed.sort()).toEqual(['assets/index-AAAA.js'])
    expect(existsSync(join(outDir, 'assets/index-AAAA.css'))).toBe(true)
    expect(existsSync(join(outDir, 'assets/index-BBBB.js'))).toBe(true)

    const next = build(['index.html', 'assets/index-DDDD.js', 'assets/index-CCCC.css'])
    expect(next.removed.sort()).toEqual(['assets/index-AAAA.css', 'assets/index-BBBB.js'])
    expect(existsSync(join(outDir, 'assets/index-CCCC.js'))).toBe(true)
    expect(existsSync(join(outDir, 'index.html'))).toBe(true)
  })

  it('never touches files Vite did not emit (e.g. copied from public/)', () => {
    writeOut('assets/logo-20241231.png')
    writeOut('favicon.ico')
    for (const id of ['A', 'B', 'C', 'D']) build(['index.html', `assets/index-${id}.js`])
    expect(existsSync(join(outDir, 'assets/logo-20241231.png'))).toBe(true)
    expect(existsSync(join(outDir, 'favicon.ico'))).toBe(true)
  })

  it('skips a stale name that an in-flight rebuild already rewrote', () => {
    build(['index.html', 'assets/a-1111.js'])
    build(['index.html', 'assets/a-2222.js'])
    // Next rebuild (content reverted → old hash) writes a-1111.js again
    // after the manifest below was recorded.
    writeFileSync(join(shogoDir, BUILD_OUTPUT_MANIFEST), JSON.stringify({ outDir, files: ['index.html', 'assets/a-3333.js'] }))
    const m = new Date(clock++ * 1000)
    utimesSync(join(shogoDir, BUILD_OUTPUT_MANIFEST), m, m)
    writeOut('assets/a-3333.js')
    writeOut('assets/a-1111.js')
    const { removed } = pruneStaleBuildOutput(shogoDir)
    expect(removed).toEqual([])
    expect(existsSync(join(outDir, 'assets/a-1111.js'))).toBe(true)
  })

  it('ignores manifest paths that escape outDir', () => {
    const outside = join(root, 'secret.txt')
    writeFileSync(outside, 'x')
    utimesSync(outside, new Date(0), new Date(0))
    build(['index.html', '../secret.txt'])
    build(['index.html', 'assets/b.js'])
    build(['index.html', 'assets/c.js'])
    expect(existsSync(outside)).toBe(true)
  })

  it('persists history across runtime restarts and is a no-op without a manifest', () => {
    expect(pruneStaleBuildOutput(shogoDir)).toEqual({ removed: [] })
    build(['index.html', 'assets/x-1.js'])
    build(['index.html', 'assets/x-2.js'])
    // A fresh process reads the same state file.
    const { removed } = build(['index.html', 'assets/x-3.js'])
    expect(removed).toEqual(['assets/x-1.js'])
  })

  it('does not count a repeated identical build as a new generation', () => {
    build(['index.html', 'assets/p-1.js'])
    build(['index.html', 'assets/p-2.js'])
    const { removed } = build(['index.html', 'assets/p-2.js'])
    expect(removed).toEqual([])
    expect(existsSync(join(outDir, 'assets/p-1.js'))).toBe(true)
  })
})

describe('buildOutputManifestPluginSource', () => {
  it('embeds the manifest path as a string literal', () => {
    const src = buildOutputManifestPluginSource('/w/.shogo/build-output.json')
    expect(src).toContain('"/w/.shogo/build-output.json"')
    expect(src).toContain('writeBundle(options, bundle)')
  })
})
