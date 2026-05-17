// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end check that a self-hosted operator's agent-runtime release
 * artifact actually ships the `runtime-template/` directory next to the
 * compiled binary, AND that {@link getRuntimeTemplatePath} resolves to
 * that bundled directory when the agent-runtime is run as a compiled
 * binary (where `process.execPath` is the binary, not `bun`).
 *
 * Why this is an integration test rather than a unit test:
 *   - The original bug was a layout bug: the post-compile copy step
 *     didn't exist, so the binary shipped without a sibling template
 *     and `getRuntimeTemplatePath` exhausted its candidate list. A
 *     unit test that mocks `process.execPath` can prove the candidate-
 *     order is correct, but it cannot prove the build pipeline actually
 *     puts the template next to the binary on disk. This test does
 *     both, in lockstep.
 *   - We run the actual `build:bin:postcompile` script (which is what
 *     `build:bin:darwin-*` / `build:bin:linux-*` chain to after `bun
 *     build --compile`) and then assert against the resulting `dist/`
 *     layout.
 *   - We additionally run a fresh `bun run` subprocess with
 *     `process.execPath` patched to a path *inside* `dist/`, verifying
 *     end-to-end that the resolution code path the compiled binary
 *     would hit actually finds the bundled template.
 *
 * What this test deliberately does NOT do:
 *   - It does NOT invoke `bun build --compile` itself. That step is
 *     ~120 MB of artifact and ~30s of wall time per platform, which is
 *     too expensive for a per-PR test. The `build:bin:darwin-arm64`
 *     script (in package.json) chains compile→postcompile, so any CI
 *     job that exercises a real `build:bin:*` will exercise both
 *     halves end-to-end. This test exercises the half that actually
 *     ships the template, which is the half that broke.
 *
 * Why one big describe instead of splitting layout vs. probe checks:
 *   - Bun's `bun:test` runs every `afterAll` callback at the end of
 *     the FILE, not at the end of its enclosing describe. Splitting
 *     into two describes meant the layout-cleanup ran *before* the
 *     probe describe started, so the probe found an empty dist/ and
 *     fell back to the source tree (caught the first time we ran this
 *     test — see git history). One describe → unambiguous lifecycle.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_ROOT = resolve(__dirname, '..', '..')
const DIST_DIR = join(PKG_ROOT, 'dist')
const POSTCOMPILE_SCRIPT = join(PKG_ROOT, 'scripts', 'copy-runtime-template-to-dist.ts')
const BUNDLED_TEMPLATE = join(DIST_DIR, 'runtime-template')

describe('agent-runtime release: binary + runtime-template/ ship together', () => {
  let preexistingTemplate = false
  let fakeExecPath: string
  let tmpRoot: string

  beforeAll(() => {
    // Run the actual post-compile script. If it fails, every assertion
    // below is meaningless, so we surface the failure verbatim.
    preexistingTemplate = existsSync(BUNDLED_TEMPLATE)
    if (preexistingTemplate) {
      rmSync(BUNDLED_TEMPLATE, { recursive: true, force: true })
    }
    if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true })

    const result = spawnSync('bun', ['run', POSTCOMPILE_SCRIPT], {
      cwd: PKG_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    if (result.status !== 0) {
      const stdout = result.stdout?.toString() ?? ''
      const stderr = result.stderr?.toString() ?? ''
      throw new Error(
        `copy-runtime-template-to-dist.ts failed (exit ${result.status})\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }

    // Probe-subprocess scaffolding. The fake binary doesn't need to be
    // executable — `getRuntimeTemplatePath` only ever takes its
    // `dirname()`, never `spawn`s it.
    tmpRoot = mkdtempSync(join(tmpdir(), 'agent-runtime-bin-layout-'))
    fakeExecPath = join(DIST_DIR, 'fake-shogo-agent-runtime')
    writeFileSync(fakeExecPath, '# placeholder for execPath dirname check')
  })

  afterAll(() => {
    if (existsSync(fakeExecPath)) rmSync(fakeExecPath, { force: true })
    rmSync(tmpRoot, { recursive: true, force: true })
    // Restore the working tree so a subsequent `bun build --compile`
    // doesn't see a half-deleted dist/. We only delete what we created;
    // if the template was already there we leave it as-is.
    if (!preexistingTemplate && existsSync(BUNDLED_TEMPLATE)) {
      rmSync(BUNDLED_TEMPLATE, { recursive: true, force: true })
    }
  })

  // ─── Layout assertions ───────────────────────────────────────────

  it('post-compile script writes a complete runtime-template next to dist/', () => {
    expect(existsSync(BUNDLED_TEMPLATE)).toBe(true)
    expect(statSync(BUNDLED_TEMPLATE).isDirectory()).toBe(true)

    // Smallest possible "this is a working scaffolding" assertion: a
    // package.json must exist at the bundled root because
    // `getRuntimeTemplatePath` keys candidate detection off it (see
    // workspace-defaults.ts). Without it, even with the dir on disk,
    // the runtime would skip past it.
    expect(existsSync(join(BUNDLED_TEMPLATE, 'package.json'))).toBe(true)
  })

  it('strips heavy / workspace-specific artifacts (node_modules, .shogo, src/generated)', () => {
    expect(existsSync(join(BUNDLED_TEMPLATE, 'node_modules'))).toBe(false)
    expect(existsSync(join(BUNDLED_TEMPLATE, '.shogo'))).toBe(false)
    expect(existsSync(join(BUNDLED_TEMPLATE, 'src', 'generated'))).toBe(false)
  })

  it('preserves the Vite/React scaffolding that seedRuntimeTemplate copies into project workspaces', () => {
    // Spot-check the files that turn an empty workspace into a working
    // dev server. These are the same entries `seedRuntimeTemplate`
    // streams into every cloud-pulled project; if the build script
    // mistakenly filters one of them out, every newly-pulled project
    // on the worker boots into a blank Vite shell.
    const required = [
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
      'src/main.tsx',
    ]
    for (const rel of required) {
      expect(existsSync(join(BUNDLED_TEMPLATE, rel))).toBe(true)
    }
  })

  // ─── Runtime resolution assertions ──────────────────────────────

  it('a subprocess with execPath inside dist/ resolves to dist/runtime-template (Patch B contract)', () => {
    // We spawn a fresh bun subprocess that overrides `process.execPath`
    // before importing `workspace-defaults`. This mirrors what the
    // compiled binary's runtime would see: `process.execPath` is the
    // binary path, and the candidate list MUST find the bundled
    // template before falling through to the source-tree candidate.
    //
    // `RUNTIME_TEMPLATE_DIR` is unset in the spawn env so the env-
    // override branch is excluded — we want to prove the `execAdjacent`
    // candidate (priority 2) actually fires.
    const probe = `
      Object.defineProperty(process, 'execPath', {
        value: ${JSON.stringify(fakeExecPath)},
        configurable: true,
      });
      const mod = await import(${JSON.stringify(join(PKG_ROOT, 'src', 'workspace-defaults.ts'))});
      const resolved = mod.getRuntimeTemplatePath();
      console.log('RESOLVED=' + (resolved ?? '<null>'));
    `
    const cleanEnv = { ...process.env }
    delete cleanEnv.RUNTIME_TEMPLATE_DIR

    const result = spawnSync('bun', ['-e', probe], {
      cwd: PKG_ROOT,
      env: cleanEnv,
      encoding: 'utf-8',
    })

    if (result.status !== 0) {
      throw new Error(
        `probe subprocess failed (exit ${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
    }

    const match = result.stdout.match(/^RESOLVED=(.*)$/m)
    expect(match).not.toBeNull()
    const resolved = match![1]

    expect(resolved).not.toBe('<null>')
    expect(resolved).toContain('runtime-template')
    expect(resolved).toContain('dist')

    // Also verify the listing matches our dist/runtime-template — the
    // runtime would have done the wrong thing at seedRuntimeTemplate
    // if it had picked up some unrelated runtime-template/ on the
    // system.
    const distEntries = new Set(readdirSync(BUNDLED_TEMPLATE))
    const resolvedEntries = new Set(readdirSync(resolved))
    expect(resolvedEntries).toEqual(distEntries)
  })

  it('RUNTIME_TEMPLATE_DIR still wins when set, even with execPath pointing into dist/ (priority order)', () => {
    // Patch B added the execPath candidate at priority 2 — explicit
    // env override at priority 1 must still beat it. This pins the
    // ordering so a future refactor that flips the priorities (and
    // silently breaks operators who set RUNTIME_TEMPLATE_DIR=
    // /opt/custom-templates/) gets caught here.
    const altTemplate = mkdtempSync(join(tmpdir(), 'alt-runtime-template-'))
    writeFileSync(join(altTemplate, 'package.json'), JSON.stringify({ name: 'alt' }))

    const probe = `
      Object.defineProperty(process, 'execPath', {
        value: ${JSON.stringify(fakeExecPath)},
        configurable: true,
      });
      const mod = await import(${JSON.stringify(join(PKG_ROOT, 'src', 'workspace-defaults.ts'))});
      const resolved = mod.getRuntimeTemplatePath();
      console.log('RESOLVED=' + (resolved ?? '<null>'));
    `
    try {
      const result = spawnSync('bun', ['-e', probe], {
        cwd: PKG_ROOT,
        env: { ...process.env, RUNTIME_TEMPLATE_DIR: altTemplate },
        encoding: 'utf-8',
      })
      if (result.status !== 0) {
        throw new Error(`probe subprocess failed: ${result.stderr}`)
      }
      const match = result.stdout.match(/^RESOLVED=(.*)$/m)
      expect(match).not.toBeNull()
      const resolved = match![1]
      // realpath-tolerant equality (macOS /var → /private/var).
      const isMatchingPath =
        resolved === altTemplate ||
        resolved === '/private' + altTemplate ||
        resolved.endsWith(altTemplate)
      expect(isMatchingPath).toBe(true)
    } finally {
      rmSync(altTemplate, { recursive: true, force: true })
    }
  })
})
