// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression test for the imported-Expo-never-rebuilds bug
// =========================================================
//
// The bundle's `workspace/.shogo/install-marker` is a sha256 of the
// EXPORTING machine's `package.json` written when its `bun install`
// last succeeded. When that marker rides along into the cloud and is
// extracted on top of a warm-pod's pre-seeded Vite `node_modules/`,
// `ensureWorkspaceDeps` and `PreviewManager.installDepsIfNeeded`
// both read it, see it matches the (also-imported) Expo `package.json`
// hash, and conclude "deps are good — skip install". They aren't:
// the on-disk node_modules is the warm pod's Vite tree, and the user's
// Expo deps were never installed. Build then has no `expo` bin and
// CanvasBuildManager (after fix `0ef3131e`) refuses to fall back to
// vite — the user-visible result is "imported, kind of works, but
// never rebuilds".
//
// Fix: drop `.shogo/install-marker` at import time so the cloud
// ALWAYS runs a real install against the imported workspace's
// `package.json` + lockfile. The marker is per-machine state, not
// portable workspace content; it should never have shipped.
//
// Run: bun test apps/api/src/routes/__tests__/project-import-install-marker.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

// `WORKSPACES_DIR` in project-export-import.ts is captured at module
// evaluation. Setting the env var here is best-effort — if another
// test in the same process imports the route first, it wins. The
// assertions below avoid disk inspection and rely on `runImport`'s
// own `stats` and SSE events instead, so the test is correct
// regardless of which WORKSPACES_DIR is in effect.
const WORKSPACES_ROOT = mkdtempSync(join(tmpdir(), 'shogo-import-marker-root-'))
process.env.WORKSPACES_DIR = WORKSPACES_ROOT

// ──────────────────────────────────────────────────────────────────────
// Mocks (mirror the project-export-import-s3 test file's setup so the
// route's import-time bindings capture our mocked prisma / S3).
// ──────────────────────────────────────────────────────────────────────

const prismaState: { projects: Map<string, any> } = { projects: new Map() }

const mockPrisma = {
  member: { findFirst: mock(async () => ({ id: 'member-1', role: 'admin' })) },
  user: { findUnique: mock(async () => ({ role: 'admin' })) },
  project: {
    create: mock(async ({ data }: any) => {
      const id = `proj_${Math.random().toString(36).slice(2, 10)}`
      const row = { id, ...data, description: data.description ?? null }
      prismaState.projects.set(id, row)
      return row
    }),
    delete: mock(async ({ where }: any) => {
      prismaState.projects.delete(where.id)
      return { id: where.id }
    }),
  },
  agentConfig: { create: mock(async () => ({})) },
  chatSession: { create: mock(async () => ({ id: 'session-1' })) },
  chatMessage: { createMany: mock(async () => ({ count: 0 })) },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

// Stub S3 sync so the K8s code path doesn't try to dial Oracle/AWS in
// tests. We only care that the local on-disk write step honored the
// install-marker exclusion before S3 ran.
mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: () => ({
    uploadAll: async () => ({
      downloaded: 0,
      uploaded: 1,
      deleted: 0,
      errors: [],
      lastSync: new Date(),
      archiveSize: 0,
    }),
  }),
  // mock.module replaces the entire module — the route under test also
  // imports isMacOSJunkName/isMacOSJunkPath, so we must re-export them
  // or Bun raises `Export named '…' not found in module` at link time.
  // No AppleDouble detritus in the install-marker bundle, so a no-op
  // stub is correct.
  isMacOSJunkName: (_name: string) => false,
  isMacOSJunkPath: (_relPath: string) => false,
}))

const { runImport } = await import('../project-export-import')
import type { ImportEvent } from '../project-export-import' assert { 'resolution-mode': 'import' }

// ──────────────────────────────────────────────────────────────────────

function buildBundleZipWithInstallMarker(): Uint8Array {
  const projectJson = {
    version: '1.1',
    project: {
      name: 'imported-with-stale-marker',
      tier: 'starter',
      status: 'draft',
      settings: { activeMode: 'none', canvasMode: 'code', canvasEnabled: false },
      schemas: [],
      accessLevel: 'anyone',
    },
    agentConfig: null,
  }
  return zipSync({
    'project.json': strToU8(JSON.stringify(projectJson)),
    // Real workspace content the importer expects.
    'workspace/package.json': strToU8(
      JSON.stringify({ name: 'expo-app', dependencies: { expo: '~51.0.0' } }),
    ),
    'workspace/app/index.tsx': strToU8('export default () => null\n'),
    // The toxic file: a per-machine install-marker that was written by
    // the exporter's bun install. If the importer trusts it, the
    // cloud's pre-seeded Vite node_modules will be (incorrectly)
    // accepted as "matching".
    'workspace/.shogo/install-marker': strToU8(
      'b3a9d2f1c0e7a8b4f1d9e6c3a7b8d4f0e1c9a6b2d8f0e3c7a9b1d4f6e8c0a2b4',
    ),
    // A second .shogo file we DO want to preserve, to prove the
    // exclusion is targeted (not "drop everything under .shogo/").
    'workspace/.shogo/STACK.md': strToU8('# tech stack notes\n'),
  })
}

beforeEach(() => {
  prismaState.projects.clear()
  for (const top of Object.values(mockPrisma) as any[]) {
    for (const fn of Object.values(top) as any[]) {
      if (typeof fn?.mockClear === 'function') fn.mockClear()
    }
  }
  // Don't wipe the project dir after S3 upload — keeps the temp dir
  // around in case of debugging, no impact on assertions.
  process.env.PURGE_LOCAL_AFTER_S3 = 'false'
})

afterEach(() => {
  // Best-effort cleanup of anything written under WORKSPACES_ROOT (only
  // present when this file's WORKSPACES_DIR set won the race against
  // any sibling test files).
  try {
    for (const entry of readdirSync(WORKSPACES_ROOT)) {
      rmSync(join(WORKSPACES_ROOT, entry), { recursive: true, force: true })
    }
  } catch { /* WORKSPACES_DIR was overridden by another test — fine */ }
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.S3_WORKSPACES_BUCKET
  delete process.env.PURGE_LOCAL_AFTER_S3
})

describe('runImport — strip .shogo/install-marker', () => {
  // Bundle has 4 workspace files; if `.shogo/install-marker` is
  // correctly excluded, exactly one file should be skipped and three
  // should be written (package.json, .shogo/STACK.md, app/index.tsx).
  const TOTAL_WORKSPACE_FILES_IN_BUNDLE = 4

  test('skips the marker via stats (local mode)', async () => {
    const events: ImportEvent[] = []
    const result = await runImport(
      buildBundleZipWithInstallMarker(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Exactly one file skipped and it's the install-marker. The
    // route's stats are the source of truth here — they don't depend
    // on which WORKSPACES_DIR ended up in effect for this process.
    expect(result.stats.filesSkipped).toBe(1)
    expect(result.stats.filesWritten).toBe(TOTAL_WORKSPACE_FILES_IN_BUNDLE - 1)

    // None of the writeFiles SSE events should report a path under
    // `.shogo/install-marker`. Prove by asserting that no such file
    // appears in either the writeFiles `path` payloads (if any) or the
    // error events (which would be emitted on a real attempted-then-
    // failed write).
    for (const ev of events) {
      // Some import events carry `path` for safety-rejection logging;
      // ensure the marker never appears as a written path either.
      const anyEv = ev as any
      if (typeof anyEv.path === 'string') {
        expect(anyEv.path.endsWith('.shogo/install-marker')).toBe(false)
      }
    }
  })

  test('skips the marker via stats (k8s mode)', async () => {
    // Same write loop runs before the S3 upload in K8s mode — re-verify
    // so the exclusion is pinned for both code paths.
    process.env.KUBERNETES_SERVICE_HOST = '1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-test'

    const result = await runImport(
      buildBundleZipWithInstallMarker(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      () => {},
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.stats.filesSkipped).toBe(1)
    expect(result.stats.filesWritten).toBe(TOTAL_WORKSPACE_FILES_IN_BUNDLE - 1)
  })
})
