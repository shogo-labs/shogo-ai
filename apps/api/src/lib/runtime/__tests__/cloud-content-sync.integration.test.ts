// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration test for the desktop cloud ↔ content-sync wiring, exercising
 * the REAL stack — `CloudFileTransport` (Files API) + `CloudSyncWatcher` —
 * against a scripted cloud and a real temp workspace dir (files mode, no git).
 *
 *   bun test apps/api/src/lib/runtime/__tests__/cloud-content-sync.integration.test.ts
 *
 * Flow asserted (the user-visible promise of "auto-sync on open"):
 *   1. Open a cloud project  → its workspace files materialize on disk.
 *   2. Edit a local file     → the watcher pushes it back (presign-write + PUT).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The module pulls in prisma + federated-upstream for the (fire-and-forget)
// one-writer check. Stub both so the integration focuses on the file stack.
mock.module('../../prisma', () => ({
  prisma: { project: { findUnique: async () => null }, localConfig: { findUnique: async () => null, upsert: async () => {} } },
}))
mock.module('../../federated-upstream', () => ({ lookupCloudInstance: async () => null }))

const { syncCloudProjectIntoDir, getCloudSyncStatus, stopCloudSyncWatcher, _resetCloudContentSyncForTests } =
  await import('../cloud-content-sync')

// ─── scripted cloud (Files API) ──────────────────────────────────────────────

const realFetch = globalThis.fetch
let puts: Array<{ url: string; body: string }> = []

function installCloud(cloudFiles: Record<string, string>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = (init?.method ?? 'GET').toUpperCase()

    if (url.includes('/workspace/manifest')) {
      return new Response(
        JSON.stringify({
          ok: true,
          projectId: 'p',
          source: 's3',
          generatedAt: '',
          files: Object.entries(cloudFiles).map(([path, content]) => ({
            path,
            size: content.length,
            lastModified: null,
            etag: null,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url.includes('/s3/presign')) {
      const body = JSON.parse((init?.body as string) || '{}') as {
        files: Array<{ path: string; action: 'read' | 'write' }>
      }
      return new Response(
        JSON.stringify({
          ok: true,
          urls: body.files.map((f) => ({
            path: f.path,
            action: f.action,
            url: f.action === 'write' ? `https://up.test/${f.path}` : `https://dl.test/${f.path}`,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (url.startsWith('https://dl.test/')) {
      const path = url.slice('https://dl.test/'.length)
      const content = cloudFiles[path]
      return content == null ? new Response('nf', { status: 404 }) : new Response(content, { status: 200 })
    }

    if (url.startsWith('https://up.test/') && method === 'PUT') {
      puts.push({ url, body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '') })
      return new Response('', { status: 200 })
    }

    return new Response('unhandled', { status: 500 })
  }) as unknown as typeof fetch
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}

let dir: string
beforeEach(() => {
  _resetCloudContentSyncForTests()
  puts = []
  dir = mkdtempSync(join(tmpdir(), 'cloud-content-sync-int-'))
})
afterEach(async () => {
  await stopCloudSyncWatcher('proj-int').catch(() => {})
  globalThis.fetch = realFetch
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('cloud content sync (integration, files mode)', () => {
  test('opening a cloud project materializes files, then a local edit pushes back', async () => {
    installCloud({
      'package.json': '{"name":"cloud-app"}',
      'src/App.tsx': 'export default () => null',
    })

    const projectDir = join(dir, 'proj-int')

    // 1. Open → pull. useGit:false forces the Files API path (no git binary
    //    dependency); a short debounce keeps the push assertion fast.
    const res = await syncCloudProjectIntoDir({
      projectId: 'proj-int',
      projectDir,
      cloudUrl: 'https://cloud.test',
      apiKey: 'shogo_sk_test',
      useGit: false,
      debounceMs: 40,
      logger: { log() {}, warn() {}, error() {} },
    })

    expect(res.pulled).toBe(true)
    expect(res.mode).toBe('files')
    // Files appear locally.
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true)
    expect(readFileSync(join(projectDir, 'src/App.tsx'), 'utf-8')).toBe('export default () => null')
    expect(getCloudSyncStatus('proj-int').state).toBe('watching')

    // 2. Edit a local file → the watcher should presign-write + PUT it back.
    writeFileSync(join(projectDir, 'notes.md'), '# hello from desktop')

    const pushed = await waitFor(() => puts.some((p) => p.url === 'https://up.test/notes.md'))
    expect(pushed).toBe(true)
    const put = puts.find((p) => p.url === 'https://up.test/notes.md')!
    expect(put.body).toContain('hello from desktop')
  }, 15_000)
})
