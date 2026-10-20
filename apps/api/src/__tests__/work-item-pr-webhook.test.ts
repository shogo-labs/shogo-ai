// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `POST /api/github/webhook` with the three events a card now listens to
 * (SHO-64): `pull_request`, `check_run` and `workflow_run`. Signature-verified
 * like a real delivery, so a route that stops handling one of them fails here.
 */

import { createHmac } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const WEBHOOK_SECRET = 'test-webhook-secret-sho-64'
process.env.GH_APP_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? Buffer.alloc(32, 13).toString('base64')

const { prisma } = await import('../lib/prisma')
const { encryptSecret } = await import('../lib/secret-crypto')
const boards = await import('../services/work-boards.service')
const pr = await import('../services/work-item-pr.service')
const { githubRoutes } = await import('../routes/github')

const db = prisma as any
const realFetch = globalThis.fetch
let seed: SeededWorkspace
let board: any
let card: any

interface StubPr {
  number: number
  state?: 'open' | 'closed'
  merged?: boolean
  mergeable_state?: string
  head_sha?: string
  checks?: Array<{ name: string; conclusion?: string | null; status?: string }>
}

let stub: StubPr = { number: 1900 }

function stubGitHub() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (/\/pulls\/\d+$/.test(url)) {
      return new Response(JSON.stringify({
        number: stub.number,
        html_url: `https://github.com/shogo-labs/shogo-ai/pull/${stub.number}`,
        state: stub.state ?? 'open',
        merged: stub.merged ?? false,
        merged_at: stub.merged ? '2026-10-19T12:00:00Z' : null,
        mergeable_state: stub.mergeable_state ?? 'clean',
        auto_merge: null,
        head: { sha: stub.head_sha ?? 'sha1', ref: 'sho-64-pr-aware-cards' },
        base: { ref: 'main' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (/\/check-runs/.test(url)) {
      return new Response(JSON.stringify({
        check_runs: (stub.checks ?? []).map((c) => ({
          name: c.name,
          status: c.status ?? 'completed',
          conclusion: c.conclusion ?? 'success',
          html_url: `https://github.com/shogo-labs/shogo-ai/runs/${c.name.replace(/\W/g, '')}`,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ message: 'unexpected' }), { status: 404 })
  }) as any
}

const app = new Hono()
app.route('/api', githubRoutes())

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`
  return app.request('/api/github/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature },
    body,
  })
}

beforeAll(async () => {
  // The GitHub client is cloud-only (guarded by SHOGO_LOCAL_MODE); the prisma
  // client already picked sqlite at import time, so this only enables that branch.
  process.env.SHOGO_LOCAL_MODE = 'false'
  seed = await seedWorkspace(db)
  await db.gitHubConnection.create({
    data: {
      projectId: seed.projectId,
      repoOwner: 'shogo-labs',
      repoName: 'shogo-ai',
      repoFullName: 'shogo-labs/shogo-ai',
      defaultBranch: 'main',
      authType: 'token',
      encryptedToken: encryptSecret('ghp_webhook_token'),
      tokenLogin: 'lacvapps',
    },
  })
  board = await boards.createBoard(
    seed.workspaceId,
    {
      name: 'Shogo Dev',
      keyPrefix: 'SHO',
      columns: [
        { name: 'In Development', category: 'active' },
        { name: 'PR Open', category: 'review', rules: { allowAutoMerge: true } },
        { name: 'Done', category: 'done' },
      ],
    },
    { userId: seed.member },
  )
  card = await boards.createWorkItem(board, { title: 'Watched by its PR', column: 'PR Open' }, { userId: seed.member })
  await pr.linkPullRequestToCard({
    workspaceId: seed.workspaceId,
    repoFullName: 'shogo-labs/shogo-ai',
    number: 1900,
    workItem: card.key,
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('github webhook → card', () => {
  test('pull_request opened refreshes the linked PR', async () => {
    stubGitHub()
    stub = { number: 1900, checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }] }
    const res = await deliver('pull_request', {
      action: 'opened',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      pull_request: { number: 1900, state: 'open', head: { sha: 'sha1' }, auto_merge: null },
    })
    expect(res.status).toBe(200)
    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.metadata.checks).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 })
    expect(link.syncedAt).toBeTruthy()
  })

  test('check_run completed with a red blocking check sends the card back', async () => {
    stubGitHub()
    stub = { number: 1900, mergeable_state: 'blocked', head_sha: 'sha2', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'failure' }] }
    const res = await deliver('check_run', {
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      check_run: { status: 'completed', conclusion: 'failure', pull_requests: [{ number: 1900 }] },
    })
    expect(res.status).toBe(200)
    const row = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(row.column.name).toBe('In Development')
  })

  test('workflow_run completed for a merged PR moves the card to Done', async () => {
    stubGitHub()
    stub = { number: 1900, state: 'closed', merged: true, checks: [] }
    const res = await deliver('workflow_run', {
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      workflow_run: { status: 'completed', conclusion: 'success', pull_requests: [{ number: 1900 }] },
    })
    expect(res.status).toBe(200)
    const row = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(row.column.category).toBe('done')
  })

  test('an unsigned delivery is refused, and an unknown event is ignored', async () => {
    const unsigned = await app.request('/api/github/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
      body: JSON.stringify({ action: 'opened' }),
    })
    expect(unsigned.status).toBe(401)
    expect((await deliver('deployment_status', { deployment: {} })).status).toBe(200)
  })
})
