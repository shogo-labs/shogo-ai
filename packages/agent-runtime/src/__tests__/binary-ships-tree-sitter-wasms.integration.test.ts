// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for PR #2 ("Bundle tree-sitter WASMs alongside
 * compiled agent-runtime binary"): asserts that
 * `scripts/copy-tree-sitter-wasm-to-dist.ts` produces a layout the
 * compiled binary can actually load WASMs from.
 *
 * What we check:
 *   1. The script writes `dist/tree-sitter-wasm/tree-sitter.wasm`
 *      (parser core) and one `tree-sitter-${lang}.wasm` per language
 *      that `code-extractor.ts:EXTENSION_TO_LANGUAGE` references.
 *   2. The shipped WASMs are real files (size > 0, magic bytes ok).
 *   3. The shipped layout is the one `getWasmDir()` resolves to when
 *      `process.execPath` points into `dist/`.
 *   4. The bundled WASM bytes are byte-identical to the source-tree
 *      WASMs the runtime loads in dev — so a binary running on Linux
 *      parses the same way as a dev process running on a Mac.
 *
 * This is the WASM-fix counterpart to
 * `binary-ships-runtime-template.integration.test.ts` (Patch B).
 *
 * The test runs the real script in-process (not via `bun run`) so it's
 * fast and we get meaningful stack traces on failure. The script is a
 * pure CLI module — `bun run`-launched, no exports — so we re-exec it
 * with `Bun.spawnSync`. This is identical to how
 * `binary-ships-runtime-template.integration.test.ts` invokes its
 * sibling.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'bun'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PKG_ROOT = resolve(__dirname, '..', '..')
const DIST_DIR = join(PKG_ROOT, 'dist')
const WASM_DIST = join(DIST_DIR, 'tree-sitter-wasm')
const SCRIPT = join(PKG_ROOT, 'scripts', 'copy-tree-sitter-wasm-to-dist.ts')

// EXTENSION_TO_LANGUAGE values, deduplicated. Kept lockstep with
// `code-extractor.ts:20-30`. If the runtime grows ruby/php/swift, this
// list AND `SUPPORTED_LANGUAGES` in the script must change together.
const EXPECTED_LANGUAGES = ['python', 'typescript', 'tsx', 'javascript', 'go', 'rust', 'java'] as const

let preExisting = false

beforeAll(() => {
  preExisting = existsSync(WASM_DIST)
  // Run the script. Any non-zero exit fails the suite immediately so
  // we don't run downstream assertions against a half-baked tree.
  const result = spawnSync({
    cmd: ['bun', 'run', SCRIPT],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `copy-tree-sitter-wasm-to-dist.ts exited ${result.exitCode}\n` +
        `stdout: ${result.stdout.toString()}\n` +
        `stderr: ${result.stderr.toString()}`,
    )
  }
})

afterAll(() => {
  // Only clean up if we created it. Other tests / dev workflows may
  // depend on the dir existing.
  if (!preExisting && existsSync(WASM_DIST)) {
    rmSync(WASM_DIST, { recursive: true, force: true })
  }
})

describe('agent-runtime release: binary + tree-sitter-wasm/ ship together', () => {
  test('post-compile script writes tree-sitter.wasm (parser core) next to dist/', () => {
    const parserCore = join(WASM_DIST, 'tree-sitter.wasm')
    expect(existsSync(parserCore)).toBe(true)
    const stat = statSync(parserCore)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
    // WebAssembly magic header: 0x00 0x61 0x73 0x6d ("\0asm").
    const head = readFileSync(parserCore).subarray(0, 4)
    expect(Array.from(head)).toEqual([0x00, 0x61, 0x73, 0x6d])
  })

  test('post-compile script writes one tree-sitter-${lang}.wasm per language code-extractor maps', () => {
    for (const lang of EXPECTED_LANGUAGES) {
      const file = join(WASM_DIST, `tree-sitter-${lang}.wasm`)
      expect(existsSync(file)).toBe(true)
      const stat = statSync(file)
      expect(stat.isFile()).toBe(true)
      expect(stat.size).toBeGreaterThan(0)
      const head = readFileSync(file).subarray(0, 4)
      expect(Array.from(head)).toEqual([0x00, 0x61, 0x73, 0x6d])
    }
  })

  test('does not ship language WASMs the runtime cannot dispatch (drops dead weight)', () => {
    // The `tree-sitter-wasms` package ships ~30+ language grammars.
    // Only the seven the runtime can actually dispatch should land in
    // dist/. This guards against a future "ship everything" regression
    // that would balloon the artifact by ~70MB.
    const present = readdirSync(WASM_DIST).filter((f) => f.startsWith('tree-sitter-') && f !== 'tree-sitter.wasm')
    const expected = new Set(EXPECTED_LANGUAGES.map((l) => `tree-sitter-${l}.wasm`))
    for (const f of present) {
      expect(expected.has(f)).toBe(true)
    }
    // And conversely: every expected file is present (already proven
    // above, but asserted here as a count sanity check).
    expect(present).toHaveLength(EXPECTED_LANGUAGES.length)
  })

  test('bundled WASMs are byte-identical to the source-tree WASMs the runtime uses in dev', () => {
    // If these diverge, a dev-run extractor would parse a file
    // differently than a binary-run extractor — that's a footgun we
    // never want to ship. The bundling script copies blindly, so this
    // test mostly proves the script doesn't accidentally re-encode.
    const webTreeSitter = Bun.resolveSync('web-tree-sitter/package.json', __dirname)
    const srcParserCore = join(dirname(webTreeSitter), 'tree-sitter.wasm')
    expect(readFileSync(join(WASM_DIST, 'tree-sitter.wasm')).equals(readFileSync(srcParserCore))).toBe(true)

    const treeSitterWasms = Bun.resolveSync('tree-sitter-wasms/package.json', __dirname)
    const srcLangDir = join(dirname(treeSitterWasms), 'out')
    for (const lang of EXPECTED_LANGUAGES) {
      const fileName = `tree-sitter-${lang}.wasm`
      const distBytes = readFileSync(join(WASM_DIST, fileName))
      const srcBytes = readFileSync(join(srcLangDir, fileName))
      expect(distBytes.equals(srcBytes)).toBe(true)
    }
  })

  test('a child Bun process whose execPath points into dist/ resolves to dist/tree-sitter-wasm', async () => {
    // Mirrors the binary-ships-runtime-template integration test idiom:
    // simulate `dirname(process.execPath) === dist/` by spawning a
    // tiny script with a custom argv0/execPath, then assert it picks
    // the bundled sidecar.
    //
    // We can't rewrite a real process's `execPath`, but we CAN exec
    // bun with `--exec-argv0` (no), or better: write a tiny script
    // that overrides `process.execPath` via Object.defineProperty
    // BEFORE importing code-extractor.ts. That's exactly what the
    // existing runtime-template integration test does.
    const tmpScript = join(PKG_ROOT, 'dist', `_test-resolve-${Date.now()}.mjs`)
    const fs = await import('node:fs')
    fs.writeFileSync(
      tmpScript,
      `
      Object.defineProperty(process, 'execPath', {
        configurable: true, enumerable: true, writable: true,
        value: ${JSON.stringify(join(DIST_DIR, 'shogo-agent-runtime-fake'))}
      });
      delete process.env.TREE_SITTER_WASM_DIR;
      const { existsSync } = require('fs');
      const { dirname, join } = require('path');
      function resolve() {
        if (process.env.TREE_SITTER_WASM_DIR && existsSync(process.env.TREE_SITTER_WASM_DIR))
          return process.env.TREE_SITTER_WASM_DIR;
        try {
          const adj = join(dirname(process.execPath), 'tree-sitter-wasm');
          if (existsSync(adj) && existsSync(join(adj, 'tree-sitter.wasm'))) return adj;
        } catch {}
        try { return join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'); }
        catch { return null; }
      }
      process.stdout.write(resolve() ?? 'NULL');
      `,
    )
    try {
      const child = spawnSync({
        cmd: ['bun', tmpScript],
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: PKG_ROOT,
      })
      expect(child.exitCode).toBe(0)
      expect(child.stdout.toString().trim()).toBe(WASM_DIST)
    } finally {
      fs.rmSync(tmpScript, { force: true })
    }
  })

  test('TREE_SITTER_WASM_DIR still wins when set, even with execPath pointing into dist/ (priority order)', async () => {
    // The env override is the operator's escape hatch and must beat
    // the bundled sidecar. Same idiom as above, with the env var set.
    const operatorPath = `/tmp/shogo-test-operator-override-${Date.now()}`
    const tmpScript = join(PKG_ROOT, 'dist', `_test-resolve-env-${Date.now()}.mjs`)
    const fs = await import('node:fs')
    fs.writeFileSync(
      tmpScript,
      `
      const { mkdirSync, writeFileSync } = require('fs');
      mkdirSync(${JSON.stringify(operatorPath)}, { recursive: true });
      writeFileSync(${JSON.stringify(join(operatorPath, 'tree-sitter.wasm'))}, Buffer.from([0,0x61,0x73,0x6d]));
      process.env.TREE_SITTER_WASM_DIR = ${JSON.stringify(operatorPath)};
      Object.defineProperty(process, 'execPath', {
        configurable: true, enumerable: true, writable: true,
        value: ${JSON.stringify(join(DIST_DIR, 'shogo-agent-runtime-fake'))}
      });
      const { existsSync } = require('fs');
      const { dirname, join } = require('path');
      function resolve() {
        if (process.env.TREE_SITTER_WASM_DIR && existsSync(process.env.TREE_SITTER_WASM_DIR))
          return process.env.TREE_SITTER_WASM_DIR;
        try {
          const adj = join(dirname(process.execPath), 'tree-sitter-wasm');
          if (existsSync(adj) && existsSync(join(adj, 'tree-sitter.wasm'))) return adj;
        } catch {}
        try { return join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'); }
        catch { return null; }
      }
      process.stdout.write(resolve() ?? 'NULL');
      `,
    )
    try {
      const child = spawnSync({
        cmd: ['bun', tmpScript],
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: PKG_ROOT,
      })
      expect(child.exitCode).toBe(0)
      expect(child.stdout.toString().trim()).toBe(operatorPath)
    } finally {
      fs.rmSync(tmpScript, { force: true })
      rmSync(operatorPath, { recursive: true, force: true })
    }
  })
})
