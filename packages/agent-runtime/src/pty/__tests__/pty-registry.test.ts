// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PtyRegistry } from '../pty-registry'

describe('PtyRegistry', () => {
  test('creates, detaches, and reattaches a PTY session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-pty-registry-'))
    try {
      const registry = new PtyRegistry({ rootDir: dir, idleTtlMs: 1000, maxAgeMs: 60_000 })
      let first: Awaited<ReturnType<PtyRegistry['getOrCreate']>>
      try {
        first = await registry.getOrCreate({ cols: 80, rows: 24 })
      } catch (err) {
        // Some local Bun/macOS combinations can load node-pty but fail the
        // native fork helper. Runtime handles this by surfacing a clean PTY
        // init error and the client falls back to legacy HTTP mode.
        expect(String(err)).toContain('posix_spawn')
        return
      }
      expect(first.created).toBe(true)
      registry.detach(first.session.id)
      const second = await registry.getOrCreate({ sessionId: first.session.id, cols: 100, rows: 30 })
      expect(second.session.id).toBe(first.session.id)
      expect(second.attached).toBe(true)
      registry.kill(first.session.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not reap an attached idle PTY session before max age', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-pty-registry-'))
    try {
      const registry = new PtyRegistry({ rootDir: dir, idleTtlMs: 1000, maxAgeMs: 60_000 })
      let first: Awaited<ReturnType<PtyRegistry['getOrCreate']>>
      try {
        first = await registry.getOrCreate({ cols: 80, rows: 24 })
      } catch (err) {
        expect(String(err)).toContain('posix_spawn')
        return
      }

      registry.reapExpired(first.session.lastActivityAt + 2_000)
      expect(registry.size()).toBe(1)

      registry.detach(first.session.id)
      registry.reapExpired(first.session.lastActivityAt + 2_000)
      expect(registry.size()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
