// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cards that know their PR (SHO-64), against a real database and a stubbed
 * GitHub API.
 *
 * The failure this prevents: a PR nobody is watching. #1519 was armed before
 * QA and merged with four open blockers, #1537 was armed ten minutes before QA
 * passed, #1531 sat red in *PR Open* until a person noticed. So: the PR links
 * itself to the card, the card carries its own checks/armed state, a merge
 * from a column that does not allow arming is refused, and a red required
 * check sends the card back with the run URL.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64')

const { prisma } = await import('../lib/prisma')
const { encryptSecret } = await import('../lib/secret-crypto')
const boards = await import('../services/work-boards.service')
const pr = await import('../services/work-item-pr.service')

const db = prisma as any
const realFetch = globalThis.fetch
let seed: SeededWorkspace
let board: any
let cardCounter = 0

/** The GitHub API, as much of it as a card needs: one PR, its check-runs. */
interface StubPr {
  number: number
  state?: 'open' | 'closed'
  draft?: boolean
  merged?: boolean
  mergeable_state?: string
  auto_merge?: unknown
  head_sha?: string
  head_ref?: string
  checks?: Array<{ name: string; status?: string; conclusion?: string | null }>
}

let stub: StubPr = { number: 1519 }
const fetchCalls: string[] = []

function stubFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    fetchCalls.push(url)
    const prMatch = url.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/)
    if (prMatch) {
      return new Response(JSON.stringify({
        number: stub.number,
        node_id: `PR_${stub.number}`,
        html_url: `https://github.com/${prMatch[1]}/${prMatch[2]}/pull/${stub.number}`,
        state: stub.state ?? 'open',
        draft: stub.draft ?? false,
        merged: stub.merged ?? false,
        merged_at: stub.merged ? '2026-10-19T12:00:00Z' : null,
        mergeable_state: stub.mergeable_state ?? 'clean',
        auto_merge: stub.auto_merge ?? null,
        head: { sha: stub.head_sha ?? 'sha1', ref: stub.head_ref ?? 'sho-64-pr-aware-cards' },
        base: { ref: 'main' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const runsMatch = url.match(/\/commits\/([^/]+)\/check-runs/)
    if (runsMatch) {
      return new Response(JSON.stringify({
        check_runs: (stub.checks ?? []).map((c) => ({
          name: c.name,
          status: c.status ?? 'completed',
          conclusion: c.conclusion ?? 'success',
          html_url: `https://github.com/shogo-labs/shogo-ai/runs/${c.name.replace(/\W/g, '')}`,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 404 })
  }) as any
}

beforeAll(async () => {
  // The GitHub client is a cloud-only island, guarded by SHOGO_LOCAL_MODE so the
  // desktop bundle stays free of it. These tests exercise that cloud path
  // against the sqlite test database; the prisma client was chosen at import
  // time by setupChannelsTestDb, so flipping the flag here only re-enables the
  // GitHub branch.
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
      encryptedToken: encryptSecret('ghp_test_token'),
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
        { name: 'PR Open', category: 'review', rules: { allowAutoMerge: true } },
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

async function makeCard(column = 'In Development', extra: { title?: string; fields?: Record<string, any> } = {}) {
  cardCounter += 1
  const title = extra.title ?? 'Cards that know their PR'
  return boards.createWorkItem(
    board,
    { title: `${title} ${cardCounter}`, column, ...(extra.fields ? { fields: extra.fields } : {}) },
    { userId: seed.member },
  )
}

async function freshBoard() {
  return db.board.findUnique({ where: { id: board.id }, include: { columns: true } })
}

async function cardRow(itemId: string) {
  return db.workItem.findUnique({ where: { id: itemId }, include: { column: true } })
}

function columnId(name: string): string {
  return board.columns.find((c: any) => c.name === name).id
}

async function moveCard(itemId: string, columnName: string) {
  const item = await boards.getItemRow(seed.workspaceId, itemId)
  await boards.moveWorkItem(item, { column: columnId(columnName) }, { userId: seed.member })
}

// ─── Linking ─────────────────────────────────────────────────────────────────

describe('a PR links itself to its card', () => {
  test('an explicit card key wins, and the link carries the repo and number', async () => {
    const card = await makeCard()
    const result = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1501,
      url: 'https://github.com/shogo-labs/shogo-ai/pull/1501',
      title: 'SHO-999 not this card',
      head: 'sho-999-other',
      workItem: card.key,
    })
    expect(result?.key).toBe(card.key)
    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.refId).toBe('1501')
    expect(link.metadata).toMatchObject({ repo: 'shogo-labs/shogo-ai', number: 1501 })
    expect(link.url).toBe('https://github.com/shogo-labs/shogo-ai/pull/1501')
  })

  test('with no key the head branch names the card, and the title is the last resort', async () => {
    const viaBranch = await makeCard()
    const branchLink = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1502,
      head: `${viaBranch.key.toLowerCase()}-pr-aware-cards`,
      title: 'Something with no key at all',
    })
    expect(branchLink?.key).toBe(viaBranch.key)

    const viaTitle = await makeCard()
    const titleLink = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1503,
      head: 'feature/no-key-here',
      title: `${viaTitle.key}: cards that know their PR`,
    })
    expect(titleLink?.key).toBe(viaTitle.key)
  })

  test('a PR with no card key links nothing and is not an error', async () => {
    const result = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1504,
      head: 'feature/no-key-here',
      title: 'Just a drive-by fix',
    })
    expect(result).toBeNull()
    expect(await db.workItemLink.count({ where: { kind: 'pr', refId: '1504' } })).toBe(0)
  })

  test('a key that names no card in the workspace is skipped, not linked to a stranger', async () => {
    const other = await db.workspace.findFirst({ where: { id: seed.otherWorkspaceId } })
    const result = await pr.linkPullRequestToCard({
      workspaceId: other.id,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1505,
      workItem: (await makeCard()).key,
    })
    expect(result).toBeNull()
  })
})

// ─── Refresh + rules ─────────────────────────────────────────────────────────

describe('the link keeps GitHub’s own state', () => {
  test('checks, armed and merge-queue stickiness are read from GitHub', async () => {
    const card = await makeCard()
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1510,
      workItem: card.key,
    })
    stubFetch()
    stub = {
      number: 1510,
      auto_merge: { enabled_by: { login: 'lacvapps' } },
      checks: [
        { name: 'Lint, Typecheck, Test', conclusion: 'success' },
        { name: 'cla', conclusion: 'success' },
        { name: 'e2e', status: 'in_progress', conclusion: null },
      ],
    }
    const first = await pr.refreshPrLink(linked!.link)
    expect(first?.metadata.armed).toBe(true)
    expect(first?.metadata.checks).toEqual({ total: 3, passing: 2, failing: 0, pending: 1 })

    // GitHub drops `auto_merge` once the PR is in the queue — still armed.
    const saved = await db.workItemLink.findUnique({ where: { id: linked!.link.id } })
    stub = { ...stub, auto_merge: null }
    const second = await pr.refreshPrLink(saved)
    expect(second?.metadata.armed).toBe(true)
    expect(second?.metadata.queued).toBe(true)
  })

  test('a red blocking check sends the card back with the failing check and its run URL', async () => {
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1519,
      workItem: card.key,
    })
    stubFetch()
    stub = {
      number: 1519,
      mergeable_state: 'blocked',
      head_sha: 'bad1',
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'failure' }],
    }
    const refreshed = await pr.refreshPrLink(linked!.link)
    const action = await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)
    expect(action).toBe('regressed')

    const after = await cardRow(card.id)
    expect(after.column.name).toBe('In Development')

    const comment = await db.workItemEvent.findFirst({ where: { workItemId: card.id, type: 'commented' } })
    expect(comment.eventData.text).toContain('Lint, Typecheck, Test')
    expect(comment.eventData.text).toContain('/runs/LintTypecheckTest')

    // A second webhook for the same head SHA does not move it again.
    const again = await pr.refreshPrLink(await db.workItemLink.findUnique({ where: { id: linked!.link.id } }))
    expect(await pr.applyPrRules(again!.link, again!.metadata, again!.previous)).toBe('none')
  })

  test('a red non-required check (cla, an emulator job) leaves the card where it is', async () => {
    // Live shape of #1533: `unstable`, required "Lint, Typecheck, Test" green,
    // only `cla` and `Android (emulator)` red. Russell's rule is that a red
    // `cla` never holds a card (SHO-43), so `unstable` must not move it.
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1533,
      workItem: card.key,
    })
    stubFetch()
    stub = {
      number: 1533,
      mergeable_state: 'unstable',
      head_sha: 'unstable1',
      checks: [
        { name: 'Lint, Typecheck, Test', conclusion: 'success' },
        { name: 'cla', conclusion: 'failure' },
        { name: 'Android (emulator)', conclusion: 'failure' },
      ],
    }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(refreshed?.metadata.checks).toEqual({ total: 3, passing: 1, failing: 2, pending: 0 })
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('none')

    const after = await cardRow(card.id)
    expect(after.column.name).toBe('PR Open')
    expect(await db.workItemEvent.count({ where: { workItemId: card.id, type: 'commented' } })).toBe(0)

    // The card still shows the failing checks; it just is not red enough to move.
    const block = pr.prBlock(await db.workItemLink.findUnique({ where: { id: linked!.link.id } }))
    expect(block?.red).toBe(false)
    expect(block?.checks.failing).toBe(2)
  })

  test('a PR armed from a column that does not allow it is reported, never un-armed', async () => {
    // `gh pr merge --auto` and GitHub's UI never pass through the merge route.
    // The board reports the stray arm once and flags the card; a person may
    // have armed deliberately, so cancelling it would be worse than the hole.
    const card = await makeCard('In Development')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1537,
      workItem: card.key,
    })
    stubFetch()
    stub = {
      number: 1537,
      mergeable_state: 'clean',
      head_sha: 'armed1',
      auto_merge: { enabled_by: { login: 'russell' } },
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }],
    }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('none')

    // Never a write to GitHub from the sync.
    expect(fetchCalls.some((u) => u.endsWith('/graphql'))).toBe(false)
    const link = await db.workItemLink.findUnique({ where: { id: linked!.link.id } })
    expect(link.metadata.armed).toBe(true)
    expect(link.metadata.armingWarning).toBe(true)
    expect(pr.prBlock(link)?.armingWarning).toBe(true)

    const comment = await db.workItemEvent.findFirst({ where: { workItemId: card.id, type: 'commented' } })
    expect(comment.eventData.text).toContain('Left armed')
    expect(comment.eventData.text).toContain('"PR Open"')
    // It stays where it is: a stray arm is not a reason to yank the card.
    expect((await cardRow(card.id)).column.name).toBe('In Development')

    // A second sync reports it once, not again.
    const again = await pr.refreshPrLink(await db.workItemLink.findUnique({ where: { id: linked!.link.id } }))
    await pr.applyPrRules(again!.link, again!.metadata, again!.previous)
    expect(await db.workItemEvent.count({ where: { workItemId: card.id, type: 'commented' } })).toBe(1)
  })

  test('a PR armed from PR Open is not flagged', async () => {
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1538,
      workItem: card.key,
    })
    stubFetch()
    stub = {
      number: 1538,
      mergeable_state: 'clean',
      head_sha: 'armed2',
      auto_merge: { enabled_by: { login: 'shogoagent' } },
      checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }],
    }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('none')
    const link = await db.workItemLink.findUnique({ where: { id: linked!.link.id } })
    expect(link.metadata.armed).toBe(true)
    expect(link.metadata.armingWarning).toBe(false)
    expect(pr.prBlock(link)?.armingWarning).toBe(false)
  })

  test('the sweep adopts a card that only carries its PR in fields.pr', async () => {
    // Every card that existed before PR links has `fields.pr` and no link, so
    // the sweep has to link them before it can keep them current.
    const card = await makeCard('PR Open', { fields: { pr: 'https://github.com/shogo-labs/shogo-ai/pull/1700' } })
    expect(await db.workItemLink.count({ where: { workItemId: card.id, kind: 'pr' } })).toBe(0)
    stubFetch()
    stub = { number: 1700, mergeable_state: 'clean', head_sha: 'adopted1', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }] }

    const { runSyncPrLinks } = await import('../jobs/sync-pr-links')
    await runSyncPrLinks()

    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link).toBeTruthy()
    expect(link.refId).toBe('1700')
    expect(link.syncedAt).toBeTruthy()
  })

  test('a merge moves the card to Done and comments the merge', async () => {
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1537,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1537, state: 'closed', merged: true, checks: [] }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('merged')

    const after = await cardRow(card.id)
    expect(after.column.category).toBe('done')
    expect(after.completedAt).toBeTruthy()
    const comment = await db.workItemEvent.findFirst({ where: { workItemId: card.id, type: 'commented' } })
    expect(comment.eventData.text).toContain('merged')
  })

  test('a close without merging comments and leaves the column alone', async () => {
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1531,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1531, state: 'closed', merged: false, checks: [] }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('closed')

    const after = await cardRow(card.id)
    expect(after.column.category).toBe('review')
    const comment = await db.workItemEvent.findFirst({ where: { workItemId: card.id, type: 'commented' } })
    expect(comment.eventData.text).toContain('closed without merging')
  })

  test('a card still in development is not moved by a red check, and a card without a PR is untouched', async () => {
    const card = await makeCard('In Development')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1520,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1520, mergeable_state: 'blocked', head_sha: 'bad2', checks: [{ name: 'ci', conclusion: 'failure' }] }
    const refreshed = await pr.refreshPrLink(linked!.link)
    expect(await pr.applyPrRules(refreshed!.link, refreshed!.metadata, refreshed!.previous)).toBe('none')

    const unlinked = await makeCard('PR Open')
    const detail = await boards.getWorkItemDetail(await boards.getItemRow(seed.workspaceId, unlinked.id), { kind: 'user', userId: seed.member })
    expect(detail.item.pr).toBeUndefined()
  })

  test('the card detail and board view carry the PR block', async () => {
    const card = await makeCard('PR Open')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1540,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1540, checks: [{ name: 'ci', conclusion: 'success' }] }
    await pr.refreshPrLink(linked!.link)

    const detail = await boards.getWorkItemDetail(await boards.getItemRow(seed.workspaceId, card.id), { kind: 'user', userId: seed.member })
    expect(detail.item.pr).toMatchObject({ number: 1540, repo: 'shogo-labs/shogo-ai', ok: true, red: false })

    const view = await boards.getBoardView(await freshBoard())
    expect(view.items.find((i: any) => i.id === card.id)?.pr?.number).toBe(1540)
  })
})

// ─── Merge guard ─────────────────────────────────────────────────────────────

describe('only an arming column may merge', () => {
  test('a card in In Development refuses, naming the column and the ones that allow it', async () => {
    const card = await makeCard('In Development')
    await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1550,
      workItem: card.key,
    })
    const guard = await pr.mergeGuard(seed.projectId, 1550)
    expect(guard.ok).toBe(false)
    if (guard.ok) throw new Error('unreachable')
    expect(guard.code).toBe('merge_not_allowed_in_column')
    expect(guard.column).toBe('In Development')
    expect(guard.allowedColumns).toEqual(['PR Open'])
    expect(guard.message).toContain(card.key)
    expect(guard.message).toContain('PR Open')
  })

  test('the same PR from PR Open is allowed', async () => {
    const card = await makeCard('PR Open')
    await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1541,
      workItem: card.key,
    })
    expect(await pr.mergeGuard(seed.projectId, 1541)).toEqual({ ok: true })
  })

  test('a PR with no card on the board is not blocked', async () => {
    expect(await pr.mergeGuard(seed.projectId, 99999)).toEqual({ ok: true })
  })

  test('existing boards have no arming column until someone turns one on', async () => {
    const plain = await boards.createBoard(seed.workspaceId, { name: 'Support', columns: [{ name: 'New', category: 'backlog' }] }, { userId: seed.member })
    expect(plain.columns.every((c: any) => c.rules?.allowAutoMerge !== true)).toBe(true)

    const turnedOn = await boards.updateColumn(await boards.resolveBoard(seed.workspaceId, plain.id), plain.columns[0].id, {
      rules: { allowAutoMerge: true },
    })
    expect(turnedOn.column.rules).toEqual({ allowAutoMerge: true })
    const turnedOff = await boards.updateColumn(await boards.resolveBoard(seed.workspaceId, plain.id), plain.columns[0].id, {
      rules: { allowAutoMerge: false },
    })
    expect(turnedOff.column.rules).toEqual({ allowAutoMerge: false })
  })
})

// ─── Webhooks and the sweep ──────────────────────────────────────────────────

describe('webhooks keep the board current without polling', () => {
  test('pull_request opened refreshes the link; closed+merged moves the card to Done', async () => {
    const card = await makeCard('PR Open')
    await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1600,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1600, checks: [{ name: 'ci', conclusion: 'success' }] }

    await pr.handlePullRequestWebhook({
      action: 'opened',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      pull_request: { number: 1600, state: 'open', head: { sha: 'ok1' }, auto_merge: null },
    })
    let link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.syncedAt).toBeTruthy()
    expect(link.metadata.checks).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 })

    stub = { number: 1600, state: 'closed', merged: true, checks: [] }
    await pr.handlePullRequestWebhook({
      action: 'closed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      pull_request: { number: 1600, state: 'closed', merged: true, head: { sha: 'ok1' } },
    })
    link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.metadata.merged).toBe(true)
    expect((await cardRow(card.id)).column.category).toBe('done')
  })

  test('check_run and workflow_run carry the PR number and refresh it; an unfinished run is ignored', async () => {
    const card = await makeCard('PR Open')
    await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1601,
      workItem: card.key,
    })
    stubFetch()
    stub = { number: 1601, mergeable_state: 'blocked', head_sha: 'bad3', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'failure' }] }

    const callsBefore = fetchCalls.length
    await pr.handleCheckRunWebhook({
      action: 'created',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      check_run: { status: 'in_progress', conclusion: null, pull_requests: [{ number: 1601 }] },
    })
    expect(fetchCalls.length).toBe(callsBefore)

    await pr.handleCheckRunWebhook({
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      check_run: { status: 'completed', conclusion: 'failure', pull_requests: [{ number: 1601 }] },
    })
    expect((await cardRow(card.id)).column.name).toBe('In Development')

    await moveCard(card.id, 'PR Open')
    stub = { number: 1601, head_sha: 'ok2', checks: [{ name: 'Lint, Typecheck, Test', conclusion: 'success' }] }
    await pr.handleWorkflowRunWebhook({
      action: 'completed',
      repository: { full_name: 'shogo-labs/shogo-ai' },
      workflow_run: { status: 'completed', conclusion: 'success', pull_requests: [{ number: 1601 }] },
    })
    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.metadata.checks.failing).toBe(0)
  })

  test('the sweep refreshes stale links for a workspace', async () => {
    const card = await makeCard('In Development')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1602,
      workItem: card.key,
    })
    await db.workItemLink.update({ where: { id: linked!.link.id }, data: { syncedAt: null } })
    stubFetch()
    stub = { number: 1602, checks: [{ name: 'ci', conclusion: 'success' }] }
    expect(await pr.syncPrLinksForWorkspace(seed.workspaceId)).toBeGreaterThan(0)
    const link = await db.workItemLink.findUnique({ where: { id: linked!.link.id } })
    expect(link.syncedAt).toBeTruthy()
  })
  test('the scheduled sweep is wired and refreshes a stale link', async () => {
    const card = await makeCard('In Development')
    const linked = await pr.linkPullRequestToCard({
      workspaceId: seed.workspaceId,
      repoFullName: 'shogo-labs/shogo-ai',
      number: 1603,
      workItem: card.key,
    })
    await db.workItemLink.update({ where: { id: linked!.link.id }, data: { syncedAt: null } })
    stubFetch()
    stub = { number: 1603, checks: [{ name: 'ci', conclusion: 'success' }] }

    // The job, not just the service: `syncPrLinksForWorkspace` used to have no
    // caller, so a token-connected repo never moved a card.
    const { runSyncPrLinks } = await import('../jobs/sync-pr-links')
    const summary = await runSyncPrLinks()
    expect(summary.lockSkipped).toBeUndefined()
    expect(summary.refreshed).toBeGreaterThan(0)
    expect((await db.workItemLink.findUnique({ where: { id: linked!.link.id } })).syncedAt).toBeTruthy()
  })
})

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('helpers', () => {
  test('card keys come out of branches and titles, upper-cased', () => {
    expect(pr.cardKeyFromText('sho-57-skills…')).toBe('SHO-57')
    expect(pr.cardKeyFromText('SHO-42: arm only from review')).toBe('SHO-42')
    expect(pr.cardKeyFromText('no key here')).toBeNull()
    expect(pr.cardKeyFromText(null)).toBeNull()
  })

  test('PR URLs give a repo and number', () => {
    expect(pr.parsePullRequestUrl('https://github.com/shogo-labs/shogo-ai/pull/1519')).toEqual({ repo: 'shogo-labs/shogo-ai', number: 1519 })
    expect(pr.parsePullRequestUrl('https://example.com/x')).toBeNull()
  })

  test('red needs a failing check that GitHub blocks on, not a red non-required one', () => {
    // `blocked` = a required check is failing, so the card goes back.
    expect(pr.isRed({ checks: { total: 2, passing: 1, failing: 1, pending: 0 }, mergeableState: 'blocked' })).toBe(true)
    // `unstable` = only a non-required check (cla, an emulator job) is red.
    expect(pr.isRed({ checks: { total: 2, passing: 1, failing: 1, pending: 0 }, mergeableState: 'unstable' })).toBe(false)
    expect(pr.isRed({ checks: { total: 2, passing: 1, failing: 1, pending: 0 }, mergeableState: 'clean' })).toBe(false)
    expect(pr.isRed({ checks: { total: 2, passing: 2, failing: 0, pending: 0 }, mergeableState: 'blocked' })).toBe(false)
  })
})
