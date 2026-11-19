// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GET/PUT /api/internal/workspaces/:workspaceId/root-secrets (SHO-384).
 *
 * Real runtime-token auth over the seeded sqlite world: a workspace runtime may
 * read and write only its own workspace's store, and the bytes it gets back are
 * the ones it put in.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.BETTER_AUTH_SECRET ||= 'root-secrets-test-secret'
process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const { prisma } = await import('../../lib/prisma')
const { runtimeInternalRoutes } = await import('../internal-runtime-routes')
const { authenticateRuntimeToken } = await import('../internal-runtime-auth')
const { deriveWorkspaceRuntimeToken } = await import('../../lib/workspace-runtime-token')

const app = runtimeInternalRoutes({
  authenticate: authenticateRuntimeToken,
  loadAgentCall: () => import('../../services/agent-call.service'),
})

const w = {
  workspaceA: '',
  workspaceB: '',
  projects: { open: '', foreign: '' },
}
let tokenA: string
let tokenB: string

function payload(entries: Record<string, string>) {
  return {
    version: 1,
    slots: [
      {
        slot: 'root',
        files: Object.entries(entries).map(([name, content]) => ({
          name,
          content: Buffer.from(content).toString('base64'),
          mode: 0o600,
          mtimeMs: 1_700_000_000_000,
        })),
      },
    ],
  }
}

async function call(
  method: 'GET' | 'PUT',
  workspaceId: string,
  opts: { token?: string | null; anchor?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {}
  if (opts.token !== null) headers['x-runtime-token'] = opts.token ?? tokenA
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const query = opts.anchor ? `?anchor=${encodeURIComponent(opts.anchor)}` : ''
  const res = await app.request(`/workspaces/${workspaceId}/root-secrets${query}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  // Seeded directly rather than through the RBAC fixture: that helper pulls the
  // generated CRUD routes, which are build output and absent from a fresh
  // checkout. This test only needs two workspaces and one project in each.
  const suffix = crypto.randomUUID().slice(0, 8)
  const a = await prisma.workspace.create({ data: { name: 'Secrets A', slug: `secrets-a-${suffix}`, kind: 'team' } })
  const b = await prisma.workspace.create({ data: { name: 'Secrets B', slug: `secrets-b-${suffix}`, kind: 'team' } })
  w.workspaceA = a.id
  w.workspaceB = b.id
  w.projects.open = (await prisma.project.create({ data: { name: 'Open', workspaceId: a.id } })).id
  w.projects.foreign = (await prisma.project.create({ data: { name: 'Foreign', workspaceId: b.id } })).id
  tokenA = deriveWorkspaceRuntimeToken(a.id)
  tokenB = deriveWorkspaceRuntimeToken(b.id)
})

afterAll(async () => {
  await prisma.workspaceRootSecret.deleteMany({})
  await prisma.$disconnect().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

describe('auth', () => {
  test('no runtime token is a 401 on both verbs', async () => {
    expect((await call('GET', w.workspaceA, { token: null })).status).toBe(401)
    expect((await call('PUT', w.workspaceA, { token: null, body: payload({ '.env': 'A=1' }) })).status).toBe(401)
  })

  test("another workspace's runtime token cannot read or write this store", async () => {
    expect((await call('GET', w.workspaceA, { token: tokenB })).status).toBe(401)
    expect((await call('PUT', w.workspaceA, { token: tokenB, body: payload({ '.env': 'A=1' }) })).status).toBe(401)
  })
})

describe('store roundtrip', () => {
  test('204 before anything was ever stored', async () => {
    const res = await call('GET', w.workspaceA)
    expect(res.status).toBe(204)
  })

  test('PUT stores, GET returns the same bytes and the same tag', async () => {
    const body = payload({ '.env': 'STRIPE_KEY=sk_test_123\n', '.env.local': 'LOCAL=1\n' })
    const put = await call('PUT', w.workspaceA, { body })
    expect(put.status).toBe(200)
    expect(put.body.stored).toBe(true)

    const got = await call('GET', w.workspaceA)
    expect(got.status).toBe(200)
    expect(got.body.tag).toBe(put.body.tag)
    expect(got.body.secrets.slots[0].files).toHaveLength(2)
    const env = got.body.secrets.slots[0].files.find((f: any) => f.name === '.env')
    expect(Buffer.from(env.content, 'base64').toString()).toBe('STRIPE_KEY=sk_test_123\n')
  })

  test('and the row holds ciphertext, not the payload', async () => {
    const row = await prisma.workspaceRootSecret.findUnique({
      where: { runtimeKey: `ws:${w.workspaceA}` },
    })
    expect(row).not.toBeNull()
    expect(row!.ciphertext).not.toContain('STRIPE_KEY')
  })

  test('re-storing identical bytes is a no-op, so a poll costs one row read', async () => {
    const again = await call('PUT', w.workspaceA, {
      body: payload({ '.env': 'STRIPE_KEY=sk_test_123\n', '.env.local': 'LOCAL=1\n' }),
    })
    expect(again.status).toBe(200)
    expect(again.body.stored).toBe(false)
  })

  test('a deleted .env is stored as an empty slot and comes back as a deletion', async () => {
    const cleared = await call('PUT', w.workspaceA, { body: { version: 1, slots: [{ slot: 'root', files: [] }] } })
    expect(cleared.status).toBe(200)
    const got = await call('GET', w.workspaceA)
    expect(got.body.secrets.slots).toEqual([{ slot: 'root', files: [] }])
  })
})

describe('a project-anchored runtime names its own store', () => {
  test('the anchor must be a project of this workspace', async () => {
    const foreign = await call('PUT', w.workspaceA, {
      anchor: w.projects.foreign,
      body: payload({ '.env': 'A=1' }),
    })
    expect(foreign.status).toBe(403)

    const anchor = w.projects.open
    const put = await call('PUT', w.workspaceA, { anchor, body: payload({ '.env': 'ANCHOR=1' }) })
    expect(put.status).toBe(200)
    const got = await call('GET', w.workspaceA, { anchor })
    expect(got.status).toBe(200)

    // The merged runtime's store is a different runtime, so it is untouched.
    const merged = await call('GET', w.workspaceA)
    expect(merged.body.secrets.slots[0].files).toEqual([])

    const row = await prisma.workspaceRootSecret.findUnique({ where: { runtimeKey: `ws:proj:${anchor}` } })
    expect(row).not.toBeNull()
  })
})

describe('validation', () => {
  test('a payload naming a non-secret file is refused with 400', async () => {
    const res = await call('PUT', w.workspaceA, { body: payload({ 'MEMORY.md': 'mine' }) })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('root_secrets_write_failed')
  })

  test('a payload that is not JSON is a 400, not a 500', async () => {
    const res = await app.request(`/workspaces/${w.workspaceA}/root-secrets`, {
      method: 'PUT',
      headers: { 'x-runtime-token': tokenA, 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
