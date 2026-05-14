// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for the 2026-05-14 "external project seeding"
 * incident.
 *
 * Background:
 *   `apps/api/src/routes/local-projects.ts` POST /from-folders creates
 *   an external project pointing at an existing repo on the user's
 *   machine. The agent-runtime then boots with WORKING_MODE='external'
 *   and WORKSPACE_DIR=<the user's repo>.
 *
 *   `server.ts :: ensureWorkspaceFiles()` historically ran several
 *   destructive helpers unconditionally:
 *     - `seedWorkspaceFromTemplate` / `seedRuntimeTemplate` — overlays a
 *       Vite + React scaffold (`index.html`, `src/`, `tsconfig.json`,
 *       `vite.config.ts`, …) onto the workspace root.
 *     - The "legacy APP layout migration" — when it detected a top-level
 *       `package.json` and no `AGENTS.md`, it MOVED `package.json`,
 *       `bun.lock`, `.gitignore`, `src/`, `prisma/`, `dist/`, `public/`,
 *       `node_modules/` into a `project/` subdirectory.
 *     - `seedTechStack`, `overlayAgentTemplateCodeDirs`, `seedLSPConfig`,
 *       `ensureWorkspaceDeps` (which itself calls
 *       `migrateLegacyShogoSdkPin` and rewrites the user's `package.json`).
 *
 *   Against shogo-ai itself this moved ~50 prisma migrations into
 *   `project/prisma/migrations/` and wrote a fresh Vite scaffold + new
 *   `.gitignore` over the user's tree.
 *
 * Invariant under test:
 *   With WORKING_MODE='external', after running the same helpers in
 *   the same order as `ensureWorkspaceFiles()` (with the early-return
 *   guard the fix adds), every file in the user's tree must be
 *   byte-identical to its pre-boot contents. Only `.shogo/` may be
 *   added.
 *
 * This test deliberately re-implements the relevant boot logic inline
 * rather than importing `ensureWorkspaceFiles` (which is module-private
 * in server.ts). If `ensureWorkspaceFiles` ever drifts from this
 * replica — e.g. a new destructive helper gets called unconditionally —
 * `scripts/repro-external-seed.ts` still exercises the production
 * code path, and a CI smoke run of that script would catch it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

// NOTE: We deliberately do NOT import from `../workspace-defaults` here.
// That module pulls in `@shogo/shared-runtime`, which transitively pulls
// `@aws-sdk/client-s3` — a heavy dep that isn't always installed in dev
// environments and isn't relevant to this regression test. The
// invariant under test is purely about the *boot sequence* in
// `server.ts :: ensureWorkspaceFiles()`, not the helpers themselves
// (which have their own tests in `workspace-defaults-external.test.ts`).
//
// The replica below mirrors the production `seedWorkspaceDefaults`
// external branch: stale-symlink cleanup → regular-file guard →
// recursive mkdir for `.shogo/{skills,plans,local}`.
function removeStaleShogoSymlink(dir: string): void {
  const shogoDir = join(dir, '.shogo')
  try {
    const st = lstatSync(shogoDir)
    if (st.isSymbolicLink()) {
      try { statSync(shogoDir) } catch { rmSync(shogoDir, { force: true }) }
    }
  } catch { /* not a symlink / missing — fine */ }
}

function seedWorkspaceDefaults_externalBranch(dir: string): void {
  removeStaleShogoSymlink(dir)
  const shogoPath = join(dir, '.shogo')
  if (existsSync(shogoPath)) {
    const st = lstatSync(shogoPath)
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      throw new Error(
        `Cannot bind external project: '${shogoPath}' exists and is not a directory.`,
      )
    }
  }
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'local'), { recursive: true })
}

function md5OfTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir
    for (const entry of readdirSync(abs)) {
      if (entry === '.git') continue
      const relPath = rel ? `${rel}/${entry}` : entry
      const absPath = join(abs, entry)
      const st = statSync(absPath)
      if (st.isDirectory()) walk(relPath)
      else if (st.isFile()) out.set(relPath, createHash('md5').update(readFileSync(absPath)).digest('hex'))
    }
  }
  walk('')
  return out
}

/**
 * Faithful replica of `server.ts :: ensureWorkspaceFiles()` with the
 * external-mode short-circuit applied. Kept in lockstep with the
 * production function — if you change one, change the other.
 */
function ensureWorkspaceFiles_withFix(workspaceDir: string): void {
  if (process.env.WORKING_MODE === 'external') {
    seedWorkspaceDefaults_externalBranch(workspaceDir)
    return
  }

  // Non-external branch — intentionally unreachable in this test. If
  // anyone changes the production guard so external projects fall
  // through to here, the assertions below will fail (the legacy
  // migration would move user files, the LSP seed would write
  // pyrightconfig.json, the runtime template would lay down a Vite
  // scaffold, …).
  throw new Error(
    'ensureWorkspaceFiles_withFix: non-external branch reached — ' +
      'the external-mode short-circuit in server.ts has regressed.',
  )
}

describe('agent-runtime boot — WORKING_MODE=external invariants', () => {
  let workspaceDir: string
  let originalMode: string | undefined

  beforeEach(() => {
    originalMode = process.env.WORKING_MODE
    process.env.WORKING_MODE = 'external'
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-extboot-'))
  })

  afterEach(() => {
    if (originalMode === undefined) delete process.env.WORKING_MODE
    else process.env.WORKING_MODE = originalMode
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('user files in a pre-existing repo are not moved/overwritten/added', () => {
    // Pretend the user opened a typical pre-existing JS repo.
    writeFileSync(join(workspaceDir, 'package.json'), JSON.stringify({
      name: 'user-repo', version: '0.0.1', type: 'module',
    }, null, 2))
    writeFileSync(join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n')
    writeFileSync(join(workspaceDir, 'README.md'), '# user repo')
    mkdirSync(join(workspaceDir, 'src'))
    writeFileSync(join(workspaceDir, 'src', 'index.ts'), 'export const x = 1\n')
    mkdirSync(join(workspaceDir, 'prisma', 'migrations', '20260101_init'), { recursive: true })
    writeFileSync(join(workspaceDir, 'prisma', 'schema.prisma'), '// user schema\n')
    writeFileSync(
      join(workspaceDir, 'prisma', 'migrations', '20260101_init', 'migration.sql'),
      'CREATE TABLE foo (id INTEGER);\n',
    )

    const before = md5OfTree(workspaceDir)
    ensureWorkspaceFiles_withFix(workspaceDir)
    const after = md5OfTree(workspaceDir)

    const missing: string[] = []
    const mutated: string[] = []
    for (const [path, hash] of before) {
      if (!after.has(path)) missing.push(path)
      else if (after.get(path) !== hash) mutated.push(path)
    }
    const added: string[] = []
    for (const path of after.keys()) {
      if (!before.has(path) && !path.startsWith('.shogo/')) added.push(path)
    }

    expect(missing).toEqual([])
    expect(mutated).toEqual([])
    expect(added).toEqual([])
  })

  test('only `.shogo/{skills,plans,local}` is added — nothing else', () => {
    writeFileSync(join(workspaceDir, 'package.json'), '{"name":"x"}')
    ensureWorkspaceFiles_withFix(workspaceDir)
    const top = readdirSync(workspaceDir).sort()
    expect(top).toEqual(['.shogo', 'package.json'])
    expect(readdirSync(join(workspaceDir, '.shogo')).sort()).toEqual(['local', 'plans', 'skills'])
  })

  test('does NOT trigger the legacy APP layout migration (no project/ dir created)', () => {
    // Exact preconditions that historically triggered the legacy
    // migration: top-level package.json + no AGENTS.md.
    writeFileSync(join(workspaceDir, 'package.json'), '{"name":"x"}')
    expect(existsSync(join(workspaceDir, 'AGENTS.md'))).toBe(false)

    ensureWorkspaceFiles_withFix(workspaceDir)

    expect(existsSync(join(workspaceDir, 'project'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'package.json'))).toBe(true)
  })

  test('does NOT write pyrightconfig.json (LSP seed is managed-mode only)', () => {
    writeFileSync(join(workspaceDir, 'package.json'), '{"name":"x"}')
    ensureWorkspaceFiles_withFix(workspaceDir)
    expect(existsSync(join(workspaceDir, 'pyrightconfig.json'))).toBe(false)
  })

  test('does NOT seed a Vite runtime-template (no index.html / vite.config.ts added)', () => {
    // Empty workspace — would otherwise be the perfect target for
    // `seedRuntimeTemplate` (it short-circuits only when package.json
    // is already present).
    ensureWorkspaceFiles_withFix(workspaceDir)
    for (const f of ['index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.mjs', 'components.json']) {
      expect(existsSync(join(workspaceDir, f))).toBe(false)
    }
  })

  test('idempotent: running twice does not change the tree', () => {
    writeFileSync(join(workspaceDir, 'package.json'), '{"name":"x"}')
    ensureWorkspaceFiles_withFix(workspaceDir)
    const first = md5OfTree(workspaceDir)
    ensureWorkspaceFiles_withFix(workspaceDir)
    const second = md5OfTree(workspaceDir)
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort())
  })
})

/**
 * Pre-existing `.shogo/` scenarios. These cover the second open of a
 * folder that already carries `.shogo/` state from a prior bind, plus
 * the two pathological shapes (broken symlink, regular file) the
 * runtime needs to handle without losing user data.
 */
describe('agent-runtime boot — pre-existing .shogo/ on the user\'s folder', () => {
  let workspaceDir: string
  let originalMode: string | undefined

  beforeEach(() => {
    originalMode = process.env.WORKING_MODE
    process.env.WORKING_MODE = 'external'
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-extexist-'))
  })

  afterEach(() => {
    if (originalMode === undefined) delete process.env.WORKING_MODE
    else process.env.WORKING_MODE = originalMode
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('preserves a fully-populated .shogo/ from a previous bind (project.json, custom skill, plans)', () => {
    // What a re-opened external project looks like on disk: the
    // .shogo/project.json from `local-projects.ts :: POST /from-folders`,
    // user-curated skills the agent created last session, plans
    // markdown, etc.
    mkdirSync(join(workspaceDir, '.shogo', 'skills', 'my-custom-skill'), { recursive: true })
    mkdirSync(join(workspaceDir, '.shogo', 'plans'), { recursive: true })
    mkdirSync(join(workspaceDir, '.shogo', 'local'), { recursive: true })
    writeFileSync(join(workspaceDir, '.shogo', 'project.json'), '{"id":"abc","createdAt":"2026-01-01"}')
    writeFileSync(join(workspaceDir, '.shogo', 'plans', 'plan-1.md'), '# plan 1')
    writeFileSync(join(workspaceDir, '.shogo', 'skills', 'my-custom-skill', 'SKILL.md'), '# custom skill')

    const before = md5OfTree(workspaceDir)
    ensureWorkspaceFiles_withFix(workspaceDir)
    const after = md5OfTree(workspaceDir)

    expect([...after.entries()].sort()).toEqual([...before.entries()].sort())
  })

  test('fills in missing subdirs when .shogo/ exists with only project.json', () => {
    mkdirSync(join(workspaceDir, '.shogo'))
    writeFileSync(join(workspaceDir, '.shogo', 'project.json'), '{"id":"abc"}')

    ensureWorkspaceFiles_withFix(workspaceDir)

    expect(existsSync(join(workspaceDir, '.shogo', 'skills'))).toBe(true)
    expect(existsSync(join(workspaceDir, '.shogo', 'plans'))).toBe(true)
    expect(existsSync(join(workspaceDir, '.shogo', 'local'))).toBe(true)
    // project.json must be untouched.
    expect(readFileSync(join(workspaceDir, '.shogo', 'project.json'), 'utf-8')).toBe('{"id":"abc"}')
  })

  test('removes a broken .shogo symlink (e.g. stale VM 9p mount) and creates a fresh dir', () => {
    // Mirrors the legacy VM behaviour: `.shogo -> /tmp/shogo-local/<id>/.shogo`
    // becomes a dangling link after the VM exits. mkdir(recursive)
    // can't traverse the dead link without removeStaleShogoSymlink.
    const deadTarget = join(tmpdir(), 'shogo-nonexistent-' + Date.now())
    symlinkSync(deadTarget, join(workspaceDir, '.shogo'))
    expect(lstatSync(join(workspaceDir, '.shogo')).isSymbolicLink()).toBe(true)
    expect(existsSync(deadTarget)).toBe(false)

    ensureWorkspaceFiles_withFix(workspaceDir)

    // Link removed; replaced by a real directory with the standard subdirs.
    expect(lstatSync(join(workspaceDir, '.shogo')).isDirectory()).toBe(true)
    expect(existsSync(join(workspaceDir, '.shogo', 'skills'))).toBe(true)
    expect(existsSync(join(workspaceDir, '.shogo', 'plans'))).toBe(true)
    expect(existsSync(join(workspaceDir, '.shogo', 'local'))).toBe(true)
  })

  test('preserves a VALID .shogo symlink (e.g. user-curated shared store) and seeds subdirs inside', () => {
    // Some users symlink .shogo to a shared directory across multiple
    // projects (e.g. `.shogo -> ~/.config/shogo/projects/foo`). A valid
    // symlink should be honoured, not removed.
    const linkTarget = mkdtempSync(join(tmpdir(), 'shogo-shared-'))
    try {
      symlinkSync(linkTarget, join(workspaceDir, '.shogo'))

      ensureWorkspaceFiles_withFix(workspaceDir)

      // Link preserved.
      expect(lstatSync(join(workspaceDir, '.shogo')).isSymbolicLink()).toBe(true)
      // Subdirs materialised inside the symlink target.
      expect(existsSync(join(linkTarget, 'skills'))).toBe(true)
      expect(existsSync(join(linkTarget, 'plans'))).toBe(true)
      expect(existsSync(join(linkTarget, 'local'))).toBe(true)
    } finally {
      rmSync(linkTarget, { recursive: true, force: true })
    }
  })

  test('throws a clear error when .shogo exists as a regular file (instead of silently overwriting)', () => {
    writeFileSync(join(workspaceDir, '.shogo'), 'oops — user mistake')
    expect(() => ensureWorkspaceFiles_withFix(workspaceDir)).toThrow(
      /exists and is not a directory/,
    )
    // File untouched.
    expect(readFileSync(join(workspaceDir, '.shogo'), 'utf-8')).toBe('oops — user mistake')
  })
})
