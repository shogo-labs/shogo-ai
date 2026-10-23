// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 §4a — a symlinked workspace root must not reject relative paths.
 *
 * A project runtime's `WORKSPACE_DIR` is
 * `<ws>/.workspace-roots/proj-<id>/<projectId>`, a **symlink** into
 * `<ws>/workspaces/<projectId>`, and `LINKED_FOLDERS` carries the real path.
 * The guard realpath'd its roots but compared them against a raw
 * `resolve()` of the input, so every relative path was refused with
 * "Path is outside the project's allowed folders: MEMORY.md".
 *
 * Both guards — `assertWithinWorkspace` (permission-engine, the one that threw
 * first) and `assertAllowedPath` (runtime-trust, which already canonicalized
 * correctly) — run through the SAME fixture table below so they cannot drift
 * apart again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { canonicalPathSync, isWithinAnyCanonicalRoot } from '../path-boundary'
import { assertWithinWorkspace } from '../permission-engine'
import { assertAllowedPath, getRuntimeTrust } from '../runtime-trust'
import { __resetTrustForTests, __setTrustForTests } from '../trust-resolver'

// Creating symlinks needs elevation/Developer Mode on Windows; skip there
// rather than fail a job on something the platform forbids (cf. SHOG-749).
const SYMLINKS_SUPPORTED = process.platform !== 'win32'

let farmRoot: string
let realRoot: string
/** `<tmp>/farm/<id>` — a symlink standing in for the project runtime root. */
let linkedRoot: string
/** A sibling directory whose name merely prefixes the root. */
let siblingEvil: string

const savedEnv = {
  linkedFolders: process.env.LINKED_FOLDERS,
  localMode: process.env.SHOGO_LOCAL_MODE,
  workspaceDir: process.env.WORKSPACE_DIR,
  trustLevel: process.env.TRUST_LEVEL,
}

beforeAll(() => {
  farmRoot = mkdtempSync(join(tmpdir(), 'shogo-symlink-guard-'))
  realRoot = join(farmRoot, 'real', 'proj-1')
  const farmDir = join(farmRoot, 'farm')
  mkdirSync(realRoot, { recursive: true })
  mkdirSync(farmDir, { recursive: true })
  writeFileSync(join(realRoot, 'MEMORY.md'), '# project memory\n')
  mkdirSync(join(realRoot, 'apps', 'api'), { recursive: true })
  writeFileSync(join(realRoot, 'apps', 'api', 'main.ts'), 'export {}\n')

  linkedRoot = join(farmDir, 'proj-1')
  if (SYMLINKS_SUPPORTED) symlinkSync(realRoot, linkedRoot, 'dir')

  // A symlink INSIDE the allowed root that points outside it — must stay denied.
  const outside = join(farmRoot, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'nope\n')
  if (SYMLINKS_SUPPORTED) symlinkSync(outside, join(realRoot, 'escape'), 'dir')

  siblingEvil = `${realRoot}-evil`
  mkdirSync(siblingEvil, { recursive: true })

  // A raw LINKED_FOLDERS path (the real dir) with a symlinked workspaceDir is
  // exactly the project-runtime layout.
  process.env.LINKED_FOLDERS = JSON.stringify([realRoot])
  delete process.env.SHOGO_LOCAL_MODE
  process.env.WORKSPACE_DIR = linkedRoot
  process.env.TRUST_LEVEL = 'trusted'
  __setTrustForTests({
    workingMode: 'external',
    trustLevel: 'trusted',
    workspaceDir: linkedRoot,
    linkedFolders: [realRoot],
    initialized: true,
  })
})

afterAll(() => {
  for (const [key, value] of [
    ['LINKED_FOLDERS', savedEnv.linkedFolders],
    ['SHOGO_LOCAL_MODE', savedEnv.localMode],
    ['WORKSPACE_DIR', savedEnv.workspaceDir],
    ['TRUST_LEVEL', savedEnv.trustLevel],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetTrustForTests()
  rmSync(farmRoot, { recursive: true, force: true })
})

type Outcome = 'allow' | 'outside' | 'symlink'

interface Fixture {
  label: string
  /** Path as the agent passes it — resolved lazily, the temp dirs are made in beforeAll. */
  input: () => string
  outcome: Outcome
}

const FIXTURES: Fixture[] = [
  { label: 'relative path at the root', input: () => 'MEMORY.md', outcome: 'allow' },
  { label: 'relative path one level down', input: () => 'apps/api/main.ts', outcome: 'allow' },
  { label: 'relative path whose file does not exist yet', input: () => 'notes/new.md', outcome: 'allow' },
  { label: 'explicit ./ prefix', input: () => './MEMORY.md', outcome: 'allow' },
  { label: 'dot-segment that stays inside', input: () => 'apps/../MEMORY.md', outcome: 'allow' },
  { label: 'the root itself', input: () => '.', outcome: 'allow' },
  { label: 'absolute path inside the real root', input: () => join(realRoot, 'MEMORY.md'), outcome: 'allow' },
  { label: 'traversal out of the root', input: () => '../../etc/passwd', outcome: 'outside' },
  { label: 'absolute path outside every root', input: () => join(tmpdir(), 'shogo-elsewhere.txt'), outcome: 'outside' },
  { label: 'sibling dir whose name prefixes the root', input: () => siblingEvil, outcome: 'outside' },
  { label: 'symlink inside the root pointing outside', input: () => 'escape/secret.txt', outcome: 'symlink' },
]

function runPermissionGuard(input: string): { ok: boolean; path?: string; error?: string } {
  try {
    return { ok: true, path: assertWithinWorkspace(linkedRoot, input) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function runTrustGuard(input: string): { ok: boolean; path?: string } {
  const result = assertAllowedPath(resolve(linkedRoot, input), 'read')
  return { ok: result.ok, path: result.resolved }
}

describe.skipIf(!SYMLINKS_SUPPORTED)('canonical containment against a symlinked project root', () => {
  test('canonicalPathSync resolves the runtime root to the real directory', () => {
    expect(canonicalPathSync(linkedRoot)).toBe(canonicalPathSync(realRoot))
  })

  test('canonicalPathSync keeps a not-yet-existing tail on the real ancestor', () => {
    expect(canonicalPathSync(join(linkedRoot, 'notes', 'new.md'))).toBe(
      join(canonicalPathSync(realRoot), 'notes', 'new.md'),
    )
  })

  test('isWithinAnyCanonicalRoot accepts a relative path under the symlinked root', () => {
    expect(isWithinAnyCanonicalRoot([linkedRoot], join(linkedRoot, 'MEMORY.md'))).toBe(true)
  })

  test('isWithinAnyCanonicalRoot accepts the real directory as a root alias', () => {
    expect(isWithinAnyCanonicalRoot([realRoot], join(linkedRoot, 'MEMORY.md'))).toBe(true)
  })

  test('isWithinAnyCanonicalRoot still refuses a traversal', () => {
    expect(isWithinAnyCanonicalRoot([linkedRoot], join(linkedRoot, '../../etc/passwd'))).toBe(false)
  })

  test('the trust resolver is pinned to the symlinked root', () => {
    expect(getRuntimeTrust().workspaceDir).toBe(linkedRoot)
  })

  // One fixture table, both guards — a divergence shows up as a failing case
  // in whichever guard drifted, not as a guard test that quietly stopped
  // covering the other (SHO-125).
  for (const fixture of FIXTURES) {
    test(`assertWithinWorkspace: ${fixture.label} → ${fixture.outcome}`, () => {
      const input = fixture.input()
      const result = runPermissionGuard(input)
      expect(result.ok).toBe(fixture.outcome === 'allow')
      if (result.ok) expect(result.path).toBe(resolve(linkedRoot, input))
    })

    test(`assertAllowedPath: ${fixture.label} → ${fixture.outcome}`, () => {
      expect(runTrustGuard(fixture.input()).ok).toBe(fixture.outcome === 'allow')
    })
  }

  test('a traversal still names the allowed folders', () => {
    expect(() => assertWithinWorkspace(linkedRoot, '../../etc/passwd')).toThrow(
      /outside the project's allowed folders/i,
    )
  })

  test('an escaping symlink keeps its own message', () => {
    expect(() => assertWithinWorkspace(linkedRoot, 'escape/secret.txt')).toThrow(
      /Symlink target outside allowed roots/i,
    )
  })

  test('the allowed-roots list still prints the raw (non-realpath) root', () => {
    try {
      assertWithinWorkspace(linkedRoot, '../../etc/passwd')
      throw new Error('expected a rejection')
    } catch (err) {
      expect((err as Error).message).toContain(linkedRoot)
    }
  })
})
