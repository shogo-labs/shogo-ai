// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the live trust REFRESH path — the fix for the
 * "I clicked Trust folder but the agent is still restricted" bug.
 *
 * These exercise `refreshTrust()` against a mocked internal `/trust`
 * endpoint and assert that `assertAllowedPath()` flips from blocked to
 * allowed once the API reports `trustLevel: 'trusted'`, without any
 * process restart. This is the end-to-end guarantee that a user toggling
 * trust in the desktop UI unblocks write / exec tools on the next turn
 * (or immediately, via the /internal/refresh-trust IPC ping).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { assertAllowedPath } from '../runtime-trust'
import { initTrustResolver, refreshTrust, __resetTrustForTests } from '../trust-resolver'

describe('trust-resolver refresh -> assertAllowedPath', () => {
  let workspaceDir: string
  const origFetch = globalThis.fetch

  beforeEach(() => {
    __resetTrustForTests()
    workspaceDir = mkdtempSync(join(tmpdir(), 'shogo-trust-refresh-'))
    writeFileSync(join(workspaceDir, 'inside.txt'), 'hi')
    process.env.SHOGO_API_URL = 'http://127.0.0.1:65500'
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    delete process.env.SHOGO_API_URL
    rmSync(workspaceDir, { recursive: true, force: true })
    __resetTrustForTests()
  })

  // Stub global fetch to answer the internal /trust read with the given
  // level. Returns a getter so a test can flip the level between calls.
  function stubTrustEndpoint(getLevel: () => 'restricted' | 'trusted'): void {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          trustLevel: getLevel(),
          workingMode: 'external',
          linkedFolders: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch
  }

  test('cold start (pre-refresh) is fail-closed restricted for external', () => {
    initTrustResolver({
      projectId: 'proj-1',
      workspaceDir,
      workingMode: 'external',
      linkedFolders: [],
    })
    const w = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write')
    expect(w.ok).toBe(false)
    expect(w.reason).toBe('restricted_mode_write')
  })

  test('refresh flips restricted -> trusted and unblocks write + exec', async () => {
    let level: 'restricted' | 'trusted' = 'restricted'
    stubTrustEndpoint(() => level)

    initTrustResolver({
      projectId: 'proj-1',
      workspaceDir,
      workingMode: 'external',
      linkedFolders: [],
    })

    // First refresh: API still reports restricted -> write/exec blocked.
    await refreshTrust()
    const blockedWrite = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write')
    expect(blockedWrite.ok).toBe(false)
    expect(blockedWrite.reason).toBe('restricted_mode_write')
    const blockedExec = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'exec')
    expect(blockedExec.ok).toBe(false)
    expect(blockedExec.reason).toBe('restricted_mode_exec')

    // User clicks "Trust folder": DB flips, runtime re-resolves.
    level = 'trusted'
    await refreshTrust()
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write').ok).toBe(true)
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'exec').ok).toBe(true)
    // Reads were always allowed.
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'read').ok).toBe(true)
  })

  test('refresh can also revoke: trusted -> restricted re-blocks write', async () => {
    let level: 'restricted' | 'trusted' = 'trusted'
    stubTrustEndpoint(() => level)

    initTrustResolver({
      projectId: 'proj-1',
      workspaceDir,
      workingMode: 'external',
      linkedFolders: [],
    })

    await refreshTrust()
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write').ok).toBe(true)

    level = 'restricted'
    await refreshTrust()
    const w = assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write')
    expect(w.ok).toBe(false)
    expect(w.reason).toBe('restricted_mode_write')
  })

  test('transient fetch failure keeps the last-known trust level', async () => {
    let level: 'restricted' | 'trusted' = 'trusted'
    stubTrustEndpoint(() => level)
    initTrustResolver({
      projectId: 'proj-1',
      workspaceDir,
      workingMode: 'external',
      linkedFolders: [],
    })
    await refreshTrust()
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write').ok).toBe(true)

    // Next refresh throws (network blip) — the resolver must not flap
    // back to restricted; it keeps the last-known trusted value.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await refreshTrust()
    expect(assertAllowedPath(join(workspaceDir, 'inside.txt'), 'write').ok).toBe(true)

    void level
  })
})
