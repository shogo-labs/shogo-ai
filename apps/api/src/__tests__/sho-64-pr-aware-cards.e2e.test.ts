// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-64 acceptance, driven through the HTTP routes a person and an agent
 * actually call — not the service functions under them.
 *
 * The card has to know its PR on every surface: the agent reads it back from
 * `agent-work-items/:key` (so it stops shelling out to `gh`), the person's
 * inbox and card pane read it from the work-item routes, the board's column
 * toggle is what decides whether an agent merge is allowed, and a red
 * required check has to send the card back with the run URL in its thread.
 */

import { createHmac } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
const WEBHOOK_SECRET = 'sho-64-e2e-webhook-secret'
process.env.GH_APP_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? Buffer.alloc(32, 17).toString('base64')

// No saved "acts as" policy: GitHub writes use the project's own connection.
// Everything else in the module stays real — the GitHub routes need it.
const realCredentials = await import('../services/integration-credentials')
mock.module('../services/integration-credentials', () => ({
  ...realCredentials,
  getPolicy: async () => ({
    writeChain: ['shared'],
    readChain: ['shared'],
    writeMode: 'shared',
    readMode: 'shared',
    fallback: 'ask',
    sharedUserId: null,
    delegateUserId: null,
  }),
}))

const { prisma } = await import('../lib/prisma')
const { encryptSecret } = await import('../lib/secret-crypto')
const { workBoardRoutes, agentBoardRoutes } = await import('../routes/work-boards')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')
const { githubRoutes } = await import('../routes/github')
const boards = await import('../services/work-boards.service')
const pr = await import('../services/work-item-pr.service')

const db = prisma as any
const realFetch = globalThis.fetch
let seed: SeededWorkspace
let board: any
let createNumber = 2100

interface StubPr {
  number: number
  state?: 'open' | 'closed'
  merged?: boolean
  mergeable_state?: string
  auto_merge?: unknown
  head_sha?: string
  checks?: Array<{ name: string; conclusion?: string | null; status?: string }>
}

let stub: StubPr = { number: 2100 }

function stubGitHub() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    if (url.endsWith('/graphql')) {
      // The sync reports a stray arm; it must never un-arm one. Anything that
      // reaches GraphQL here is a regression, so record it and fail loudly.
      graphqlCalls.push(url)
      return new Response(JSON.stringify({ errors: [{ message: 'no writes from the sync' }] }), { status: 200 })
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return new Response(JSON.stringify({
        number: stub.number,
        html_url: `https://github.com/shogo-labs/shogo-ai/pull/${stub.number}`,
        state: stub.state ?? 'open',
        draft: false,
        merged: stub.merged ?? false,
        merged_at: stub.merged ? '2026-10-19T12:00:00Z' : null,
        mergeable_state: stub.mergeable_state ?? 'clean',
        auto_merge: stub.auto_merge ?? null,
        head: { sha: stub.head_sha ?? 'sha-clean', ref: 'sho-64-pr-aware-cards' },
        base: { ref: 'main' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (/\/check-runs/.test(url)) {
      return new Response(JSON.stringify({
        check_runs: (stub.checks ?? []).map((c) => ({
          name: c.name,
          status: c.status ?? 'completed',
          conclusion: c.conclusion ?? 'success',
          html_url: `https://github.com/shogo-labs/shogo-ai/actions/runs/${c.name.replace(/\W/g, '')}`,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 404 })
  }) as any
}

const merges: any[] = []
const created: any[] = []
/** Requests the code made to GitHub's GraphQL API — the sync must make none. */
const graphqlCalls: string[] = []

const app = new Hono()
app.route('/api', workBoardRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))
app.route('/api', githubRoutes())
app.route('/api/internal', agentBoardRoutes({
  authorize: async (c) => ({ workspaceId: c.req.param('workspaceId'), projectId: c.req.header('x-project') || undefined }),
}))
app.route('/api/internal', runtimeInternalRoutes({
  authenticate: async () => ({ kind: 'sa' } as any),
  saveAgentAvatar: async () => ({}) as any,
  metalWorkspaceMember: (async () => null) as any,
  loadGitHub: async () => ({
    getConnection: async () => ({
      authType: 'token',
      installationId: null,
      encryptedToken: encryptSecret('ghp_e2e_token'),
      tokenLogin: 'lacvapps',
      repoOwner: 'shogo-labs',
      repoName: 'shogo-ai',
      defaultBranch: 'main',
    }),
    createPullRequest: async (options: any) => {
      created.push(options)
      createNumber += 1
      return {
        number: createNumber,
        html_url: `https://github.com/shogo-labs/shogo-ai/pull/${createNumber}`,
        url: 'https://api.github.com/x',
      }
    },
    mergePullRequest: async (options: any) => {
      merges.push(options)
      return { merged: true, sha: 'e2esh' }
    },
  }) as any,
} as any))

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`
  return app.request('/api/github/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature },
    body,
  })
}

const asUser = (path: string, method = 'GET', body?: unknown) =>
  api(method, path, body, { 'x-user': seed.member })

async function newCard(column: string) {
  return boards.createWorkItem(board, { title: `Card in ${column}`, column }, { userId: seed.member })
}

async function linkPr(card: any, number: number) {
  const result = await pr.linkPullRequestToCard({
    workspaceId: seed.workspaceId,
    repoFullName: 'shogo-labs/shogo-ai',
    number,
    workItem: card.key,
  })
  expect(result?.link).toBeTruthy()
  return result!.link
}

beforeAll(async () => {
  // The GitHub client is a cloud-only island (guarded by SHOGO_LOCAL_MODE);
  // these routes exercise that cloud path against the sqlite test database.
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
      encryptedToken: encryptSecret('ghp_e2e_token'),
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
        { name: 'QA & Review', category: 'active' },
        // Arming starts off for every existing board: nobody turned it on here.
        { name: 'PR Open', category: 'review' },
        { name: 'Done', category: 'done' },
      ],
    },
    { userId: seed.member },
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SHO-64: the card carries its PR on the surfaces people and agents read', () => {
  test('an agent creates a PR naming its card, then reads the PR state back from the card', async () => {
    const card = await newCard('PR Open')

    const create = await api('POST', `/internal/projects/${seed.projectId}/github/pull-request`, {
      title: 'A change that names no key in its title',
      head: 'feature/no-key-here',
      workItem: card.key,
    })
    expect(create.status).toBe(200)
    expect(create.json.workItem).toBe(card.key)

    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.refId).toBe(String(create.json.number))

    stubGitHub()
    stub = {
      number: create.json.number,
      head_sha: 'sha-one',
      auto_merge: { enabled_by: { login: 'lacvapps' } },
      checks: [
        { name: 'Lint, Typecheck, Test', conclusion: 'success' },
        { name: 'cla', conclusion: 'success' },
      ],
    }
    await pr.refreshPrLink(await db.workItemLink.findUnique({ where: { id: link.id } }))

    // The agent's own read: no `gh` call, no guessing from comments.
    const detail = await api('GET', `/internal/workspaces/${seed.workspaceId}/agent-work-items/${card.key}`, undefined, {
      'x-project': seed.projectId,
    })
    expect(detail.status).toBe(200)
    const block = detail.json.item.pr
    expect(block.number).toBe(create.json.number)
    expect(block.armed).toBe(true)
    expect(block.queued).toBe(false)
    expect(block.red).toBe(false)
    expect(block.checks).toEqual({ total: 2, passing: 2, failing: 0, pending: 0 })
    expect(block.syncedAt).toBeTruthy()
  })

  test('the workspace item list carries the same PR block, so the inbox and board agree', async () => {
    const card = await newCard('PR Open')
    await linkPr(card, 2150)
    stubGitHub()
    stub = { number: 2150, head_sha: 'sha-list', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }] }
    await pr.refreshPrLink(await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } }))

    const list = await asUser(`/workspaces/${seed.workspaceId}/work-items`)
    expect(list.status).toBe(200)
    const row = list.json.items.find((i: any) => i.id === card.id)
    expect(row.pr.number).toBe(2150)
    expect(row.pr.checks.total).toBe(1)

    const detail = await asUser(`/work-items/${card.id}`)
    expect(detail.status).toBe(200)
    expect(detail.json.item.pr.url).toBe('https://github.com/shogo-labs/shogo-ai/pull/2150')
  })
})

describe('SHO-64: only a column that allows arming may merge', () => {
  test('a merge from a column with no rules is refused, and the board toggle is what allows it', async () => {
    const card = await newCard('PR Open')
    await linkPr(card, 2200)

    const refused = await api('POST', `/internal/projects/${seed.projectId}/github/pull-request/2200/merge`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('merge_not_allowed_in_column')
    expect(refused.json.error.card).toBe(card.key)
    expect(refused.json.error.column).toBe('PR Open')
    expect(refused.json.error.allowedColumns).toEqual([])
    expect(merges).toHaveLength(0)

    const columns = await asUser(`/boards/${board.id}`)
    const prOpen = columns.json.board.columns.find((c: any) => c.name === 'PR Open')
    expect(prOpen.rules).toEqual({})

    const patched = await asUser(`/boards/${board.id}/columns/${prOpen.id}`, 'PATCH', { rules: { allowAutoMerge: true } })
    expect(patched.status).toBe(200)
    expect(patched.json.board.columns.find((c: any) => c.id === prOpen.id).rules.allowAutoMerge).toBe(true)

    const allowed = await api('POST', `/internal/projects/${seed.projectId}/github/pull-request/2200/merge`)
    expect(allowed.status).toBe(200)
    expect(allowed.json.merged).toBe(true)
    expect(merges).toHaveLength(1)

    // Leave the board as we found it for the next test file.
    await asUser(`/boards/${board.id}/columns/${prOpen.id}`, 'PATCH', { rules: null })
  })

  test('a second board that never turned arming on still refuses, and says so', async () => {
    const plain = await boards.createBoard(
      seed.workspaceId,
      {
        name: 'Plain Board',
        keyPrefix: 'PLN',
        columns: [
          { name: 'Todo', category: 'active' },
          { name: 'Doing', category: 'review' },
        ],
      },
      { userId: seed.member },
    )
    const card = await boards.createWorkItem(plain, { title: 'Waiting on its PR', column: 'Doing' }, { userId: seed.member })
    await linkPr(card, 2201)

    const before = merges.length
    const refused = await api('POST', `/internal/projects/${seed.projectId}/github/pull-request/2201/merge`)
    expect(refused.status).toBe(409)
    expect(refused.json.error.code).toBe('merge_not_allowed_in_column')
    expect(refused.json.error.message).toContain('no column on Plain Board allows arming')
    expect(merges).toHaveLength(before)
  })
})

describe('SHO-64: a red check sends the card back, with its run in the thread', () => {
  test('a failing required check moves the card to the first active column and comments the run URL', async () => {
    const card = await boards.createWorkItem(board, { title: 'Watched by its PR', column: 'PR Open' }, { userId: seed.member })
    await linkPr(card, 2300)

    stubGitHub()
    stub = {
      number: 2300,
      head_sha: 'sha-red',
      mergeable_state: 'blocked',
      checks: [
        { name: 'Lint, Typecheck, Test', conclusion: 'failure' },
        { name: 'cla', conclusion: 'success' },
      ],
    }

    const res = await deliver('check_run', {
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      check_run: { status: 'completed', pull_requests: [{ number: 2300 }] },
    })
    expect(res.status).toBe(200)

    const moved = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true, board: { include: { columns: true } } } })
    expect(moved.column.name).toBe('In Development')

    const detail = await asUser(`/work-items/${card.id}`)
    expect(detail.status).toBe(200)
    // A board with no channel keeps the comment as an event on the card.
    const commented = detail.json.events.find((e: any) => e.type === 'commented')
    expect(commented.data.text).toContain('Lint, Typecheck, Test')
    expect(commented.data.text).toContain('/actions/runs/LintTypecheckTest')
    expect(detail.json.events.some((e: any) => e.type === 'commented')).toBe(true)
    // The move itself is on the timeline, from the review column back to dev.
    const movedEvent = detail.json.events.find((e: any) => e.type === 'moved')
    expect(movedEvent.data.from.column).toBe('PR Open')
    expect(movedEvent.data.to.column).toBe('In Development')
    // The card keeps the red state it was moved for, so the chip is honest.
    expect(detail.json.item.pr.red).toBe(true)
    expect(detail.json.item.pr.checks.failing).toBe(1)
  })

  test('the same failing check delivered twice does not move the card again', async () => {
    const card = await newCard('PR Open')
    await linkPr(card, 2301)
    stubGitHub()
    stub = {
      number: 2301,
      head_sha: 'sha-red-2',
      mergeable_state: 'blocked',
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'failure' }],
    }
    const payload = {
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      check_run: { status: 'completed', pull_requests: [{ number: 2301 }] },
    }
    await deliver('check_run', payload)
    const once = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(once.column.name).toBe('In Development')

    // Put it back where a re-delivery would visibly move it from, then replay.
    const row = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true, board: { include: { columns: true } } } })
    await boards.moveWorkItem(row, { column: 'PR Open' }, { userId: seed.member })
    await deliver('check_run', payload)
    const twice = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(twice.column.name).toBe('PR Open')
  })

  test('a merge moves the card to Done and comments the merge', async () => {
    const card = await newCard('PR Open')
    await linkPr(card, 2302)
    stubGitHub()
    stub = { number: 2302, state: 'closed', merged: true, head_sha: 'sha-merged', checks: [] }

    await deliver('pull_request', {
      action: 'closed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      pull_request: { number: 2302, state: 'closed', merged: true, auto_merge: null },
    })

    const moved = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(moved.column.name).toBe('Done')
    const detail = await asUser(`/work-items/${card.id}`)
    const commented = detail.json.events.find((e: any) => e.type === 'commented')
    expect(commented.data.text).toContain('merged')
    expect(detail.json.item.pr.merged).toBe(true)
  })
})

describe('SHO-64: a stray arm is reported, never undone', () => {
  test('a PR a person armed by hand from a column that may not arm stays armed across sweeps', async () => {
    // The rule only bites on a board that has an arming column.
    const guarded = await boards.createBoard(
      seed.workspaceId,
      {
        name: 'Guarded Board',
        keyPrefix: 'GRD',
        columns: [
          { name: 'In Development', category: 'active' },
          { name: 'PR Open', category: 'review', rules: { allowAutoMerge: true } },
          { name: 'Done', category: 'done' },
        ],
      },
      { userId: seed.member },
    )
    const card = await boards.createWorkItem(guarded, { title: 'Armed by hand', column: 'In Development' }, { userId: seed.member })
    await linkPr(card, 2400)

    stubGitHub()
    stub = {
      number: 2400,
      head_sha: 'sha-stray',
      auto_merge: { enabled_by: { login: 'russell' } },
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }],
    }
    graphqlCalls.length = 0
    const { runSyncPrLinks } = await import('../jobs/sync-pr-links')
    await runSyncPrLinks()

    // Nothing wrote to GitHub: the person's arming survives the sweep.
    expect(graphqlCalls).toEqual([])
    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.metadata.armed).toBe(true)
    expect(link.metadata.armingWarning).toBe(true)

    const detail = await asUser(`/work-items/${card.id}`)
    const comments = detail.json.events.filter((e: any) => e.type === 'commented')
    expect(comments).toHaveLength(1)
    expect(comments[0].data.text).toContain('Left armed')
    expect(comments[0].data.text).toContain('"PR Open"')
    expect(detail.json.item.pr.armed).toBe(true)
    expect(detail.json.item.pr.armingWarning).toBe(true)

    // Age the link so the next tick re-reads it: the warning is not repeated.
    await db.workItemLink.update({ where: { id: link.id }, data: { syncedAt: new Date(Date.now() - 60 * 60_000) } })
    await runSyncPrLinks()
    const after = await db.workItemLink.findUnique({ where: { id: link.id } })
    expect(after.metadata.armed).toBe(true)
    const again = await asUser(`/work-items/${card.id}`)
    expect(again.json.events.filter((e: any) => e.type === 'commented')).toHaveLength(1)
    expect(graphqlCalls).toEqual([])
  })
})

describe('SHO-64: the sweep adopts cards that only carry their PR in `fields.pr`', () => {
  test('a legacy card is linked by the job, then moves on a red required check', async () => {
    const card = await boards.createWorkItem(
      board,
      {
        title: 'Legacy card with a PR',
        column: 'PR Open',
        fields: { pr: 'https://github.com/shogo-labs/shogo-ai/pull/2410' },
      },
      { userId: seed.member },
    )
    expect(await db.workItemLink.count({ where: { workItemId: card.id, kind: 'pr' } })).toBe(0)

    stubGitHub()
    stub = { number: 2410, head_sha: 'sha-legacy', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }] }
    const { runSyncPrLinks } = await import('../jobs/sync-pr-links')
    await runSyncPrLinks()

    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.refId).toBe('2410')
    expect(link.syncedAt).toBeTruthy()

    // The point of adopting it: the next tick can act on the card.
    stub = {
      number: 2410,
      head_sha: 'sha-legacy-red',
      mergeable_state: 'blocked',
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'failure' }],
    }
    await db.workItemLink.update({ where: { id: link.id }, data: { syncedAt: new Date(Date.now() - 60 * 60_000) } })
    await runSyncPrLinks()

    const moved = await db.workItem.findUnique({ where: { id: card.id }, include: { column: true } })
    expect(moved.column.name).toBe('In Development')
  })
})
