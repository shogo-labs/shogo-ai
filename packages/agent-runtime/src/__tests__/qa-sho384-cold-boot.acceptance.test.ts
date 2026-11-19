// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-384 acceptance — a cloud `ws:` runtime keeps its root `.env*` across a
 * cold boot.
 *
 * Destination in the repo: packages/agent-runtime/src/__tests__/qa-sho384-cold-boot.acceptance.test.ts
 *
 * Driven through the pod's real sync code, in the order `server.ts` runs it
 * (`restore()` once the tree is final, then `start()`):
 *
 *   - a cold boot restores every secret file, byte-identical and at 0600;
 *   - a `.env` deleted before the export does not come back (the SHO-382
 *     round-1 failure, replayed here);
 *   - one failed GET at boot must never become an export: nothing is pushed
 *     before a pull succeeds, and the interval's job until then is to retry the
 *     restore — the store is the only copy a pod has;
 *   - desktop and metal attach no store at all.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkspaceRootSecretsSync,
  workspaceRootSecretSyncFromEnv,
  type WorkspaceRootSecretSyncConfig,
} from '../workspace-secrets-sync'
import {
  workspaceSecretsTag,
  type WorkspaceRootSecrets,
  type WorkspaceRootSecretsTransport,
} from '@shogo/shared-runtime/workspace-root-secrets'

const dirs: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho384-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function config(workspaceRoot: string, intervalMs = 60_000): WorkspaceRootSecretSyncConfig {
  return {
    apiUrl: 'http://api.test',
    workspaceId: 'ws-qa-384',
    anchorProjectId: null,
    runtimeAuthSecret: 'runtime-secret',
    roots: { root: workspaceRoot },
    intervalMs,
  }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

/** An in-memory store with the same contract as the API's two routes. */
function memoryStore(initial?: WorkspaceRootSecrets) {
  let stored: { secrets: WorkspaceRootSecrets; tag: string } | null = initial
    ? { secrets: initial, tag: workspaceSecretsTag(initial) }
    : null
  const calls: string[] = []
  const transport: WorkspaceRootSecretsTransport = {
    async pull() {
      calls.push('pull')
      return stored
    },
    async push(secrets, opts) {
      calls.push('push')
      const tag = workspaceSecretsTag(secrets)
      if (tag === stored?.tag) return { stored: false, tag }
      stored = { secrets, tag: opts.tag }
      return { stored: true, tag }
    },
  }
  return { transport, calls, peek: () => stored }
}

describe('SHO-384: a cloud ws: runtime cold-boots with its root .env* intact', () => {
  test('every secret name comes back byte-identical at 0600 after the tree is rebuilt', async () => {
    const workspaceRoot = root()
    const files: Record<string, string> = {
      '.env': 'STRIPE_SECRET_KEY=sk_live_abc\nDATABASE_URL=postgres://u:p@h/db\n',
      '.env.local': 'LOCAL_ONLY=1\n',
      '.env.production': 'PROD_TOKEN=prod-123\n',
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(workspaceRoot, name), body)
    writeFileSync(join(workspaceRoot, 'index.ts'), 'export {}\n')
    writeFileSync(join(workspaceRoot, '.gitignore'), 'node_modules\n.env\n.env.local\n')

    const store = memoryStore()
    const first = createWorkspaceRootSecretsSync(config(workspaceRoot), { transport: store.transport, log: () => {} })
    // The boot sequence in server.ts: the tree is final, restore, then export.
    // A brand-new runtime gets the store's "nothing stored" answer and may push.
    await first.restore()
    expect((await first.flush())?.stored).toBe(true)

    // Cold boot: git_only rebuilds the tracked tree and nothing else.
    for (const name of Object.keys(files)) unlinkSync(join(workspaceRoot, name))

    const cold = createWorkspaceRootSecretsSync(config(workspaceRoot), { transport: store.transport, log: () => {} })
    const restored = await cold.restore()
    expect(restored?.restored.sort()).toEqual(['root/.env', 'root/.env.local', 'root/.env.production'])
    for (const [name, body] of Object.entries(files)) {
      expect(readFileSync(join(workspaceRoot, name), 'utf8')).toBe(body)
      expect(statSync(join(workspaceRoot, name)).mode & 0o777).toBe(0o600)
    }
    // The repo's ignore rules are the repo's: the store does not rewrite them.
    expect(readFileSync(join(workspaceRoot, '.gitignore'), 'utf8')).toContain('.env')
  })

  test('a .env deleted before the export does not come back on the next cold boot', async () => {
    const workspaceRoot = root()
    writeFileSync(join(workspaceRoot, '.env'), 'KEEP=1\n')
    writeFileSync(join(workspaceRoot, '.env.local'), 'DROP=1\n')

    const store = memoryStore()
    const sync = createWorkspaceRootSecretsSync(config(workspaceRoot), { transport: store.transport, log: () => {} })
    await sync.restore()
    await sync.flush()

    unlinkSync(join(workspaceRoot, '.env.local'))
    await sync.flush()

    // The rebuild leaves neither file behind.
    unlinkSync(join(workspaceRoot, '.env'))
    const cold = createWorkspaceRootSecretsSync(config(workspaceRoot), { transport: store.transport, log: () => {} })
    await cold.restore()

    expect(readFileSync(join(workspaceRoot, '.env'), 'utf8')).toBe('KEEP=1\n')
    expect(() => readFileSync(join(workspaceRoot, '.env.local'))).toThrow()
  })

  test('a failed restore never exports, and the interval retries the pull instead', async () => {
    const workspaceRoot = root()
    const durable: WorkspaceRootSecrets = {
      version: 1,
      slots: [
        {
          slot: 'root',
          files: [
            {
              name: '.env',
              content: Buffer.from('TOKEN=only-copy-left\n').toString('base64'),
              mode: 0o600,
              mtimeMs: 1_700_000_000_000,
            },
          ],
        },
      ],
    }
    let pulls = 0
    let stored: { secrets: WorkspaceRootSecrets; tag: string } = { secrets: durable, tag: workspaceSecretsTag(durable) }
    const pushes: WorkspaceRootSecrets[] = []
    const transport: WorkspaceRootSecretsTransport = {
      async pull() {
        pulls += 1
        // The first read of the boot fails (an API restart, a 502, a dropped
        // connection). Every later call is fine.
        if (pulls === 1) throw new Error('root-secrets GET HTTP 502')
        return stored
      },
      async push(secrets, opts) {
        pushes.push(secrets)
        const tag = workspaceSecretsTag(secrets)
        if (tag === stored.tag) return { stored: false, tag }
        stored = { secrets, tag: opts.tag }
        return { stored: true, tag }
      },
    }

    // A cold pod: the rebuilt root holds no `.env` at all.
    const sync = createWorkspaceRootSecretsSync(config(workspaceRoot, 20), { transport, log: () => {} })
    expect(await sync.restore()).toBeNull()
    expect(readdirSync(workspaceRoot)).toEqual([])

    // An export here would store the rebuilt root's empty set over the user's
    // only copy of the token — the exact loss this card is about.
    await sync.flush()
    expect(pushes).toEqual([])
    expect(stored.secrets.slots[0]!.files.map((file) => file.name)).toEqual(['.env'])

    // The interval's job until a pull succeeds is the pull, then the restore.
    const stop = sync.start()
    const restored = await until(() => existsSync(join(workspaceRoot, '.env')))
    stop()
    expect(restored).toBe(true)
    expect(readFileSync(join(workspaceRoot, '.env'), 'utf8')).toBe('TOKEN=only-copy-left\n')
    expect(statSync(join(workspaceRoot, '.env')).mode & 0o777).toBe(0o600)
    expect(stored.secrets.slots[0]!.files.map((file) => file.name)).toEqual(['.env'])
  })

  test('desktop and metal attach no store — their root is not rebuilt from git', () => {
    const base = {
      WORKSPACE_ID: 'ws-1',
      WORKSPACE_DIR: '/tmp/ws-1',
      RUNTIME_AUTH_SECRET: 't',
      SHOGO_API_URL: 'http://api.test',
    }
    // Desktop: the API never sets the flag, so the runtime keeps its own disk.
    expect(workspaceRootSecretSyncFromEnv({ ...base } as NodeJS.ProcessEnv)).toBeNull()
    // Metal: the host-mediated home archive already carries the same files.
    expect(
      workspaceRootSecretSyncFromEnv({
        ...base,
        SHOGO_WORKSPACE_SECRET_STORE: 'rest',
        SHOGO_DURABILITY_HOST_MEDIATED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
    // The cloud `ws:` pod is the one runtime that takes the store.
    expect(
      workspaceRootSecretSyncFromEnv({
        ...base,
        SHOGO_WORKSPACE_SECRET_STORE: 'rest',
      } as NodeJS.ProcessEnv),
    ).not.toBeNull()
  })
})
