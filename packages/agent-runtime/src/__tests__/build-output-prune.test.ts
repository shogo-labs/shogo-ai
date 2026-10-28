// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILD_OUTPUT_MANIFEST,
  buildOutputManifestPluginSource,
  consumeBuildOutputChange,
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
    expect(src).toContain("createHash('sha1')")
    expect(src).toContain('fingerprint')
  })
})

describe('build-output manifest plugin fingerprint (the canvas "Update available" toast)', () => {
  type Build = {
    modules: Record<string, string>
    chunks: Record<string, { name: string; code: string }>
    assets: Record<string, string | Uint8Array>
  }

  /** The plugin exactly as the watch wrapper splices it in. */
  function loadPlugin() {
    const src = buildOutputManifestPluginSource(join(shogoDir, BUILD_OUTPUT_MANIFEST))
    return new Function('createHash', 'writeFileSync', 'Buffer', `return (${src})`)(
      createHash,
      writeFileSync,
      Buffer,
    )
  }

  /** One `writeBundle`, then the question the reload broadcast asks. */
  function rebuild(b: Build, withModuleInfo = true): boolean {
    const bundle: Record<string, unknown> = {}
    for (const [fileName, chunk] of Object.entries(b.chunks)) bundle[fileName] = { type: 'chunk', ...chunk }
    for (const [fileName, source] of Object.entries(b.assets)) bundle[fileName] = { type: 'asset', source }
    const ctx = withModuleInfo
      ? {
          getModuleIds: () => Object.keys(b.modules)[Symbol.iterator](),
          getModuleInfo: (id: string) => ({ code: b.modules[id] }),
        }
      : {}
    loadPlugin().writeBundle.call(ctx, { dir: outDir }, bundle)
    return consumeBuildOutputChange(shogoDir)
  }

  const html = (chunk: string, title = 'Dashboard') =>
    `<!doctype html><title>${title}</title><script type="module" src="./${chunk}"></script>` +
    '<link rel="stylesheet" href="./assets/index-CSS1.css">'

  // The real diff between two "updates" on a recharts dashboard where nothing
  // was edited: a cached watch rebuild deconflicts decimal.js-light's
  // top-level `Decimal` differently from the full build.
  const modules = {
    '/w/src/main.tsx': 'import { App } from "./App"\nrender(App)',
    '/w/node_modules/decimal.js-light/decimal.mjs': 'var Decimal, external = true;\nexport default Decimal',
  }
  const full: Build = {
    modules,
    chunks: { 'assets/index-D1TaQJiw.js': { name: 'index', code: 'var Decimal,\n  external = true;' } },
    assets: { 'index.html': html('assets/index-D1TaQJiw.js'), 'assets/index-CSS1.css': '.p-4{padding:1rem}' },
  }
  const renamed: Build = {
    modules,
    chunks: { 'assets/index-KHXTg5s3.js': { name: 'index', code: 'var Decimal$1,\n  external = true;' } },
    assets: { 'index.html': html('assets/index-KHXTg5s3.js'), 'assets/index-CSS1.css': '.p-4{padding:1rem}' },
  }

  it('a rebuild that only renames colliding identifiers is not an update', () => {
    expect(rebuild(full)).toBe(true)
    expect(rebuild(renamed)).toBe(false)
    expect(rebuild(full)).toBe(false)
    expect(rebuild(renamed)).toBe(false)
  })

  it('an edit to any module is an update', () => {
    rebuild(full)
    expect(
      rebuild({ ...renamed, modules: { ...modules, '/w/src/main.tsx': 'import { App } from "./App"\nrender(App, 2)' } }),
    ).toBe(true)
  })

  it('a changed stylesheet or page shell is an update', () => {
    rebuild(full)
    expect(rebuild({ ...renamed, assets: { ...renamed.assets, 'assets/index-CSS1.css': '.p-8{padding:2rem}' } })).toBe(true)
    rebuild(full)
    expect(
      rebuild({ ...renamed, assets: { ...renamed.assets, 'index.html': html('assets/index-KHXTg5s3.js', 'Sales') } }),
    ).toBe(true)
  })

  it('source maps never count — they encode the render-time names', () => {
    rebuild({ ...full, assets: { ...full.assets, 'assets/index-D1TaQJiw.js.map': '{"names":["Decimal"]}' } })
    expect(
      rebuild({ ...renamed, assets: { ...renamed.assets, 'assets/index-KHXTg5s3.js.map': '{"names":["Decimal$1"]}' } }),
    ).toBe(false)
  })

  it('binary assets are hashed as bytes', () => {
    rebuild({ ...full, assets: { ...full.assets, 'assets/logo.png': new Uint8Array([1, 2, 3]) } })
    expect(rebuild({ ...renamed, assets: { ...renamed.assets, 'assets/logo.png': new Uint8Array([1, 2, 3]) } })).toBe(false)
    expect(rebuild({ ...renamed, assets: { ...renamed.assets, 'assets/logo.png': new Uint8Array([1, 2, 4]) } })).toBe(true)
  })

  it('without module info it falls back to the rendered chunks, and still writes the manifest', () => {
    expect(rebuild(full, false)).toBe(true)
    expect(rebuild(full, false)).toBe(false)
    expect(rebuild(renamed, false)).toBe(true)
    const manifest = JSON.parse(readFileSync(join(shogoDir, BUILD_OUTPUT_MANIFEST), 'utf-8'))
    expect(manifest.outDir).toBe(outDir)
    expect(manifest.files).toEqual(['assets/index-CSS1.css', 'assets/index-KHXTg5s3.js', 'index.html'])
  })
})

describe('consumeBuildOutputChange', () => {
  function writeManifest(fingerprint?: string) {
    writeFileSync(
      join(shogoDir, BUILD_OUTPUT_MANIFEST),
      JSON.stringify({
        outDir,
        files: ['index.html'],
        ...(fingerprint === undefined ? {} : { fingerprint }),
      }),
    )
  }

  it('reports the first build and changed fingerprints, but not repeats', () => {
    writeManifest('first')
    expect(consumeBuildOutputChange(shogoDir)).toBe(true)
    expect(consumeBuildOutputChange(shogoDir)).toBe(false)

    writeManifest('second')
    expect(consumeBuildOutputChange(shogoDir)).toBe(true)
    expect(consumeBuildOutputChange(shogoDir)).toBe(false)
  })

  it('reports a missing manifest or fingerprint as changed', () => {
    expect(consumeBuildOutputChange(shogoDir)).toBe(true)

    writeManifest()
    expect(consumeBuildOutputChange(shogoDir)).toBe(true)

    writeManifest('valid')
    expect(consumeBuildOutputChange(shogoDir)).toBe(true)
    expect(consumeBuildOutputChange(shogoDir)).toBe(false)
  })
})
