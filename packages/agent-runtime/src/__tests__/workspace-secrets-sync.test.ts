// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-384: a cloud `ws:` runtime keeps its root `.env*` across a cold boot.
 *
 * The transport is in-memory here and the "cold boot" is REMOVING the files the
 * way a `git archive HEAD` rebuild does — the payload has to come back from the
 * store alone, not from anything left on disk. That is the shape of the metal
 * e2e SHO-382 shipped, replayed for the API-side store.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_SECRET_SLOT_ROOT,
  type WorkspaceRootSecrets,
  type WorkspaceRootSecretsTransport,
} from '@shogo/shared-runtime/workspace-root-secrets'
import {
  createWorkspaceRootSecretsSync,
  createWorkspaceRootSecretsTransport,
  workspaceRootSecretSyncFromEnv,
  type WorkspaceRootSecretSyncConfig,
} from '../workspace-secrets-sync'

function dir(prefix = 'ws-secrets-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A stand-in for the API: one stored payload, with the same tag comparison. */
function memoryTransport() {
  let stored: { tag: string; secrets: WorkspaceRootSecrets } | null = null
  const calls: Array<{ stored: boolean; tag: string }> = []
  const transport: WorkspaceRootSecretsTransport = {
    async pull() {
      return stored
    },
    async push(secrets, opts) {
      if (stored && stored.tag === opts.tag) {
        calls.push({ stored: false, tag: opts.tag })
        return { stored: false, tag: stored.tag }
      }
      stored = { tag: opts.tag, secrets: JSON.parse(JSON.stringify(secrets)) }
      calls.push({ stored: true, tag: opts.tag })
      return { stored: true, tag: opts.tag }
    },
  }
  return {
    transport,
    calls,
    peek: () => stored,
  }
}

function config(root: string): WorkspaceRootSecretSyncConfig {
  return {
    apiUrl: 'http://api.test',
    workspaceId: 'ws-1',
    anchorProjectId: null,
    runtimeAuthSecret: 'runtime-secret',
    roots: { [WORKSPACE_SECRET_SLOT_ROOT]: root },
    intervalMs: 60_000,
  }
}

describe('workspaceRootSecretSyncFromEnv', () => {
  const cloudEnv = {
    SHOGO_WORKSPACE_SECRET_STORE: 'rest',
    WORKSPACE_ID: 'ws-1',
    WORKSPACE_DIR: '/app/workspace',
    RUNTIME_AUTH_SECRET: 'runtime-secret',
    SHOGO_API_URL: 'http://api.test',
  }

  test('is off unless the API attached a store', () => {
    expect(workspaceRootSecretSyncFromEnv({ ...cloudEnv, SHOGO_WORKSPACE_SECRET_STORE: undefined })).toBeNull()
  })

  test('is off on a metal guest, which already keeps the same files in its home archive', () => {
    expect(
      workspaceRootSecretSyncFromEnv({ ...cloudEnv, SHOGO_DURABILITY_HOST_MEDIATED: '1' }),
    ).toBeNull()
  })

  test('is off without a runtime token or an API to call', () => {
    expect(workspaceRootSecretSyncFromEnv({ ...cloudEnv, RUNTIME_AUTH_SECRET: undefined })).toBeNull()
    expect(
      workspaceRootSecretSyncFromEnv({ ...cloudEnv, SHOGO_API_URL: undefined, AI_PROXY_URL: undefined }),
    ).toBeNull()
  })

  test('attaches the runtime root and the anchor that names the store', () => {
    const cfg = workspaceRootSecretSyncFromEnv({
      ...cloudEnv,
      WORKSPACE_ANCHOR_PROJECT_ID: 'proj-1',
      SHOGO_WORKSPACE_SECRET_SYNC_MS: '5000',
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.roots[WORKSPACE_SECRET_SLOT_ROOT]).toBe('/app/workspace')
    expect(cfg!.anchorProjectId).toBe('proj-1')
    expect(cfg!.intervalMs).toBe(5000)
  })
})

describe('cold boot', () => {
  test('a rebuilt root gets its .env* back byte-identical at 0600', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'STRIPE_KEY=sk_test_123\n')
    writeFileSync(join(root, '.env.local'), 'LOCAL_ONLY=1\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
    const { transport } = memoryTransport()

    const first = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    await first.restore()
    expect((await first.flush())?.stored).toBe(true)

    // A cold boot: the durable repo rebuilds the tracked tree and nothing else.
    unlinkSync(join(root, '.env'))
    unlinkSync(join(root, '.env.local'))
    writeFileSync(join(root, 'index.ts'), 'export {}\n')

    const second = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    const restored = await second.restore()
    expect(restored?.restored.sort()).toEqual(['root/.env', 'root/.env.local'])
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('STRIPE_KEY=sk_test_123\n')
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe('LOCAL_ONLY=1\n')
    expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600)
    // The repo's own ignore rules are untouched: the files stay out of git.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.env')
  })

  test('a .env deleted before the export does not come back on the next cold boot', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'KEEP=1\n')
    writeFileSync(join(root, '.env.production'), 'DROP=1\n')
    const { transport } = memoryTransport()
    const sync = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    await sync.restore()
    await sync.flush()

    // The agent removes one of them; the export that follows records its absence.
    unlinkSync(join(root, '.env.production'))
    await sync.flush()

    unlinkSync(join(root, '.env'))
    const cold = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    const restored = await cold.restore()
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('KEEP=1\n')
    expect(restored?.restored).toEqual(['root/.env'])
    expect(() => readFileSync(join(root, '.env.production'))).toThrow()
  })

  test('a root whose .env was deleted entirely clears the stored copy', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'GONE=1\n')
    const { transport, peek } = memoryTransport()
    const sync = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    await sync.restore()
    await sync.flush()
    unlinkSync(join(root, '.env'))
    await sync.flush()

    const stored = peek()!
    expect(stored.secrets.slots[0]!.files).toEqual([])

    writeFileSync(join(root, '.env'), 'STALE=1\n')
    const cold = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    expect((await cold.restore())?.removed).toEqual(['root/.env'])
    expect(() => readFileSync(join(root, '.env'))).toThrow()
  })

  test('an unchanged runtime sends nothing at all on the next tick', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'A=1\n')
    const { transport, calls } = memoryTransport()
    const sync = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    await sync.restore()
    await sync.flush()
    const second = await sync.flush()
    expect(second?.stored).toBe(false)
    expect(calls).toHaveLength(1)

    // A change is an upload again, and the stored copy follows it.
    writeFileSync(join(root, '.env'), 'A=2\n')
    expect((await sync.flush())?.stored).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('a failed restore never lets the rebuilt root overwrite the stored copy', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'TOKEN=keep-me\n')
    const mem = memoryTransport()
    const sync = createWorkspaceRootSecretsSync(config(root), { transport: mem.transport, log: () => {} })
    await sync.restore()
    await sync.flush()
    const seeded = mem.peek()!
    expect(seeded.secrets.slots[0]!.files).toHaveLength(1)

    // A cold boot: the tree is rebuilt from `git archive HEAD`, so there is no
    // `.env` on disk, and the API is down when the runtime comes up.
    unlinkSync(join(root, '.env'))
    let apiDown = true
    const flaky: WorkspaceRootSecretsTransport = {
      async pull() {
        if (apiDown) throw new Error('root-secrets GET HTTP 503')
        return mem.transport.pull()
      },
      push: (secrets, opts) => mem.transport.push(secrets, opts),
    }
    const cold = createWorkspaceRootSecretsSync(config(root), { transport: flaky, log: () => {} })

    expect(await cold.restore()).toBeNull()
    // This is the destructive half: exporting here would store the rebuilt
    // root's empty set over the user's only copy of the tokens.
    expect(await cold.flush()).toBeNull()
    expect(mem.peek()).toEqual(seeded)
    expect(mem.calls).toHaveLength(1)

    // The interval keeps retrying the restore, and once the API answers the
    // tokens are back and the export is a no-op again.
    apiDown = false
    expect((await cold.restore())?.restored).toEqual(['root/.env'])
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('TOKEN=keep-me\n')
    expect((await cold.flush())?.stored).toBe(false)
    expect(mem.peek()).toEqual(seeded)
  })

  test('a brand-new runtime with nothing stored is allowed to export', async () => {
    const root = dir()
    writeFileSync(join(root, '.env'), 'FIRST=1\n')
    const mem = memoryTransport()
    const sync = createWorkspaceRootSecretsSync(config(root), { transport: mem.transport, log: () => {} })
    // A 204 resolves as a successful, empty pull — there is nothing to protect.
    expect(await sync.restore()).not.toBeNull()
    const pushed = await sync.flush()
    expect(pushed?.stored).toBe(true)
    expect(pushed?.files).toBe(1)
  })

  test('a slot the runtime does not serve is skipped, not written anywhere', async () => {
    const root = dir()
    const transport: WorkspaceRootSecretsTransport = {
      async pull() {
        return {
          tag: 'abc',
          secrets: {
            version: 1,
            slots: [
              { slot: WORKSPACE_SECRET_SLOT_ROOT, files: [] },
              { slot: 'member-1', files: [{ name: '.env', content: Buffer.from('X=1').toString('base64'), mode: 0o600, mtimeMs: 0 }] },
            ],
          },
        }
      },
      async push() {
        return { stored: false, tag: 'abc' }
      },
    }
    const sync = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    const restored = await sync.restore()
    expect(restored?.skippedSlots).toEqual(['member-1'])
    expect(restored?.restored).toEqual([])
    expect(() => readFileSync(join(root, '.env'))).toThrow()
  })
})

describe('createWorkspaceRootSecretsTransport', () => {
  test('names the workspace, the anchor and the runtime token on every call', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method!, headers: init.headers as Record<string, string> })
      if (init.method === 'GET') return new Response(null, { status: 204 })
      return Response.json({ ok: true, stored: true, tag: 'abc' })
    }) as unknown as typeof fetch
    const transport = createWorkspaceRootSecretsTransport(
      {
        apiUrl: 'http://api.test',
        workspaceId: 'ws-1',
        anchorProjectId: 'proj-1',
        runtimeAuthSecret: 'runtime-secret',
      },
      { fetchImpl },
    )

    expect(await transport.pull()).toBeNull()
    expect(await transport.push({ version: 1, slots: [{ slot: 'root', files: [] }] }, { tag: 'abc' })).toEqual({
      stored: true,
      tag: 'abc',
    })

    expect(seen[0]!.url).toBe('http://api.test/api/internal/workspaces/ws-1/root-secrets?anchor=proj-1')
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.headers['x-runtime-token']).toBe('runtime-secret')
    expect(seen[1]!.headers['x-runtime-token']).toBe('runtime-secret')
  })

  test('a failed read is an error the sync logs and survives', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const transport = createWorkspaceRootSecretsTransport(
      { apiUrl: 'http://api.test', workspaceId: 'ws-1', anchorProjectId: null, runtimeAuthSecret: 't' },
      { fetchImpl },
    )
    await expect(transport.pull()).rejects.toThrow('HTTP 500')

    const root = dir()
    writeFileSync(join(root, '.env'), 'A=1\n')
    const sync = createWorkspaceRootSecretsSync(config(root), { transport, log: () => {} })
    expect(await sync.restore()).toBeNull()
    expect(await sync.flush()).toBeNull()
  })
})
