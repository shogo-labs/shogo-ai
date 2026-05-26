// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `runtime-trust.ts` — the central allowed-roots + trust-level
 * policy used by gateway-tools, canvas watchers, and the indexer.
 *
 * Covers the security-critical paths:
 *   - paths outside any allowed root must be rejected even if they
 *     resolve via realpathSync (symlink escape attempt)
 *   - paths inside an allowed root pass for `read` in either trust
 *     level
 *   - `restricted` mode blocks `write` / `exec` even inside an
 *     allowed root
 *   - `trusted` mode permits all modes inside allowed roots
 *   - multi-root setups: linked folders are honored alongside
 *     workspaceDir
 *   - nonexistent paths fall back to the nearest existing ancestor
 *     (so writing a new file under an allowed root succeeds without
 *     pre-creating it)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

import { _runtimeTrustSeamForTests, assertAllowedPath, getAllowedRoots, getRuntimeTrust } from '../runtime-trust'
import { __resetTrustForTests, __setTrustForTests } from '../trust-resolver'

// helper: clear env, resolver, AND the legacy global between cases so
// each test runs in a known-good context (server.ts isn't booted in
// unit tests, so `getRuntimeTrust()` should fall through to the env
// branch unless a test explicitly seeds the resolver).
function clearTrustState(): void {
  __resetTrustForTests()
  delete (globalThis as any).__SHOGO_AGENT_RUNTIME_CONFIG__
  delete process.env.WORKSPACE_DIR
  delete process.env.AGENT_DIR
  delete process.env.PROJECT_DIR
  delete process.env.WORKING_MODE
  delete process.env.TRUST_LEVEL
  delete process.env.LINKED_FOLDERS
}

describe('runtime-trust', () => {
  let workspaceDir: string
  let linkedDir: string
  let outsideDir: string

  beforeEach(() => {
    clearTrustState()
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-trust-ws-'))
    linkedDir = mkdtempSync(join(tmpdir(), 'shogo-trust-linked-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'shogo-trust-outside-'))
    writeFileSync(join(workspaceDir, 'inside.txt'), 'hi')
    writeFileSync(join(linkedDir, 'inside.txt'), 'hi')
    writeFileSync(join(outsideDir, 'secret.txt'), 'nope')
  })

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
    rmSync(linkedDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    clearTrustState()
  })

  function setTrust(opts: {
    workingMode?: 'managed' | 'external'
    trustLevel?: 'trusted' | 'restricted'
    linkedFolders?: string[]
  }): void {
    __setTrustForTests({
      workingMode: opts.workingMode ?? 'external',
      trustLevel: opts.trustLevel ?? 'restricted',
      workspaceDir,
      linkedFolders: opts.linkedFolders ?? [],
      initialized: true,
    })
  }

  test('env fallback: external + no TRUST_LEVEL defaults to restricted', () => {
    process.env.WORKSPACE_DIR = workspaceDir
    process.env.WORKING_MODE = 'external'
    const t = getRuntimeTrust()
    expect(t.workingMode).toBe('external')
    expect(t.trustLevel).toBe('restricted')
  })

  test('env fallback: managed defaults to trusted', () => {
    process.env.WORKSPACE_DIR = workspaceDir
    const t = getRuntimeTrust()
    expect(t.workingMode).toBe('managed')
    expect(t.trustLevel).toBe('trusted')
  })

  test('env fallback: LINKED_FOLDERS JSON parsed', () => {
    process.env.WORKSPACE_DIR = workspaceDir
    process.env.WORKING_MODE = 'external'
    process.env.LINKED_FOLDERS = JSON.stringify([linkedDir])
    const t = getRuntimeTrust()
    expect(t.linkedFolders).toEqual([linkedDir])
  })

  test('env fallback: malformed LINKED_FOLDERS JSON does not throw, falls to empty', () => {
    process.env.WORKSPACE_DIR = workspaceDir
    process.env.WORKING_MODE = 'external'
    process.env.LINKED_FOLDERS = '{ this is not json'
    const t = getRuntimeTrust()
    expect(t.linkedFolders).toEqual([])
  })

  test('env fallback: explicit TRUST_LEVEL=trusted overrides external default', () => {
    // This is the test-only env path — production no longer reads
    // TRUST_LEVEL from env, but unit tests pin trust via env when they
    // don't want to seed the resolver.
    process.env.WORKSPACE_DIR = workspaceDir
    process.env.WORKING_MODE = 'external'
    process.env.TRUST_LEVEL = 'trusted'
    expect(getRuntimeTrust().trustLevel).toBe('trusted')
  })

  test('resolver seeded but uninitialized: returns resolver values (fail-closed for external)', () => {
    // Mirrors the production cold-start moment between
    // initTrustResolver() and the first refreshTrust() landing.
    // The resolver seam exposes a fail-closed default; getRuntimeTrust
    // must surface it instead of falling through to env.
    __setTrustForTests({
      workingMode: 'external',
      trustLevel: 'restricted', // fail-closed pre-refresh
      workspaceDir,
      linkedFolders: [],
      initialized: false,
    })
    const t = getRuntimeTrust()
    expect(t.workspaceDir).toBe(workspaceDir)
    expect(t.trustLevel).toBe('restricted')
  })

  test('resolver initialized=true is authoritative over env vars', () => {
    // Even if a test sets a conflicting env, the resolver wins once
    // initialized — this is the production guarantee that env can't
    // override a live refresh result.
    process.env.WORKSPACE_DIR = '/different/from/resolver'
    process.env.TRUST_LEVEL = 'restricted'
    __setTrustForTests({
      workingMode: 'external',
      trustLevel: 'trusted',
      workspaceDir,
      linkedFolders: [linkedDir],
      initialized: true,
    })
    const t = getRuntimeTrust()
    expect(t.workspaceDir).toBe(workspaceDir)
    expect(t.trustLevel).toBe('trusted')
    expect(t.linkedFolders).toEqual([linkedDir])
  })

  test('getAllowedRoots dedupes workspaceDir + linkedFolders', () => {
    setTrust({ linkedFolders: [workspaceDir, linkedDir] })
    const roots = getAllowedRoots()
    expect(roots).toHaveLength(2)
    expect(roots).toContain(workspaceDir)
    expect(roots).toContain(linkedDir)
  })

  test('read inside workspace: allowed in restricted mode', () => {
    setTrust({ trustLevel: 'restricted' })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'read')
    expect(r.ok).toBe(true)
  })

  test('write inside workspace: BLOCKED in restricted mode', () => {
    setTrust({ trustLevel: 'restricted' })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('restricted_mode_write')
  })

  test('exec inside workspace: BLOCKED in restricted mode', () => {
    setTrust({ trustLevel: 'restricted' })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'exec')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('restricted_mode_exec')
  })

  test('write inside workspace: ALLOWED in trusted mode', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write')
    expect(r.ok).toBe(true)
  })

  test('exec inside workspace: ALLOWED in trusted mode', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'exec')
    expect(r.ok).toBe(true)
  })

  test('read outside all allowed roots: BLOCKED', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(join(outsideDir, 'secret.txt'), 'read')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('outside_allowed_roots')
  })

  test('read inside a linked folder: ALLOWED', () => {
    setTrust({ trustLevel: 'trusted', linkedFolders: [linkedDir] })
    const r = assertAllowedPath(join(linkedDir, 'inside.txt'), 'read')
    expect(r.ok).toBe(true)
  })

  test('symlink escape: symlink inside workspace pointing to outsideDir is REJECTED', () => {
    setTrust({ trustLevel: 'trusted' })
    const linkPath = join(workspaceDir, 'escape')
    symlinkSync(outsideDir, linkPath)
    const r = assertAllowedPath(join(linkPath, 'secret.txt'), 'read')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('outside_allowed_roots')
  })

  test('nonexistent path under workspace: resolves to ancestor; ALLOWED for write in trusted', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(join(workspaceDir, 'new-dir', 'new-file.txt'), 'write')
    expect(r.ok).toBe(true)
  })

  test('nonexistent path NOT under any allowed root: REJECTED', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(join(outsideDir, 'new-file.txt'), 'write')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('outside_allowed_roots')
  })

  test('empty path: REJECTED with invalid_path', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath('', 'read')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('invalid_path')
  })

  test('boundary: sibling folder whose path starts with workspaceDir name is REJECTED', () => {
    // `/tmp/shogo-trust-ws-abc-evil` must NOT match `/tmp/shogo-trust-ws-abc`
    setTrust({ trustLevel: 'trusted' })
    const sibling = workspaceDir + '-evil'
    mkdirSync(sibling, { recursive: true })
    try {
      writeFileSync(join(sibling, 'x.txt'), 'x')
      const r = assertAllowedPath(join(sibling, 'x.txt'), 'read')
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('outside_allowed_roots')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('exact workspace dir path: ALLOWED', () => {
    setTrust({ trustLevel: 'trusted' })
    const r = assertAllowedPath(workspaceDir, 'read')
    expect(r.ok).toBe(true)
  })

  test('no allowed roots configured: REJECTED', () => {
    __setTrustForTests({
      workingMode: 'external',
      trustLevel: 'restricted',
      workspaceDir: '',
      linkedFolders: [],
      initialized: true,
    })
    const r = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'read')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('outside_allowed_roots')
  })

  test('uses candidate when ancestor realpathSync also throws (line 177 catch)', () => {
    // Line 177-178: even after walking up to a real ancestor, the inner
    // realpathSync(cur) call itself throws. Swap the seam to force this.
    const origRealpath = _runtimeTrustSeamForTests.realpathSync
    _runtimeTrustSeamForTests.realpathSync = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    try {
      // target doesn't exist → outer realpathSync fails → ancestor walk runs
      // → inner seam throws → catch sets real = candidate.
      // The candidate is under workspaceDir (which also gets the non-throwing
      // real realpathSync for roots; we need to set the root to the same
      // candidate prefix so it still matches).
      const ghostRoot = '/nonexistent/ghost2'
      __setTrustForTests({
        workingMode: 'managed',
        trustLevel: 'trusted',
        workspaceDir: ghostRoot,
        linkedFolders: [],
        initialized: true,
      })
      const r = assertAllowedPath(ghostRoot + '/file.txt', 'read')
      // real falls back to candidate (ghostRoot/file.txt); root also fell
      // back via its own catch to resolve(ghostRoot). Both agree, so ok=true.
      expect(r.ok).toBe(true)
    } finally {
      _runtimeTrustSeamForTests.realpathSync = origRealpath
    }
  })

  test('roots with non-existent paths use resolved form (realpathSync-on-root catch)', () => {
    // Line 149-150: the `.map()` in assertAllowedPath calls realpathSync on
    // each root. If a root doesn't exist (e.g. a linked folder that was
    // un-mounted), realpathSync throws → catch returns `resolve(p)` instead.
    // Set a non-existent linked folder as the only root and assert the check
    // still succeeds for a path under it (it will match via the resolved form).
    const ghostRoot = '/nonexistent/ghost/root'
    __setTrustForTests({
      workingMode: 'external',
      trustLevel: 'trusted',
      workspaceDir: ghostRoot,
      linkedFolders: [],
      initialized: true,
    })
    // The target path also doesn't exist, so we exercise BOTH catch branches
    // (line 149 for the root + line 177 for the ancestor walk).
    const target = ghostRoot + '/subdir/newfile.txt'
    const r = assertAllowedPath(target, 'read')
    // The path is under the allowed root (matched via resolve(), not realpath())
    // so the check should pass.
    expect(r.ok).toBe(true)
  })
})
// Silence "imported but unused" complaints when sep import is needed later.
void sep
