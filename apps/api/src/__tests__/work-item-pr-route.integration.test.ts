// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The internal routes a PR goes through (SHO-64): creating one links the card
 * named by `workItem`, the head branch or the title, and merging one is only
 * allowed from a column whose rules allow arming.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? Buffer.alloc(32, 11).toString('base64')

// No saved "acts as" policy: writes use the project's connection.
mock.module('../services/integration-credentials', () => ({
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
const boards = await import('../services/work-boards.service')
const { runtimeInternalRoutes } = await import('../routes/internal-runtime-routes')

const db = prisma as any
let seed: SeededWorkspace
let board: any

function app() {
  const merges: any[] = []
  const creates: any[] = []
  const routes = runtimeInternalRoutes({
    authenticate: async () => ({ kind: 'sa' } as any),
    saveAgentAvatar: async () => ({}) as any,
    metalWorkspaceMember: (async () => null) as any,
    loadGitHub: async () => ({
      getConnection: async () => ({
        authType: 'token',
        installationId: null,
        encryptedToken: encryptSecret('ghp_route_token'),
        tokenLogin: 'lacvapps',
        repoOwner: 'shogo-labs',
        repoName: 'shogo-ai',
        defaultBranch: 'main',
      }),
      createPullRequest: async (options: any) => {
        creates.push(options)
        return { number: 1700 + creates.length, html_url: `https://github.com/shogo-labs/shogo-ai/pull/${1700 + creates.length}`, url: 'https://api.github.com/x' }
      },
      mergePullRequest: async (options: any) => {
        merges.push(options)
        return { merged: true, sha: 'abc123' }
      },
    }) as any,
  } as any)
  const root = new Hono()
  root.route('/api/internal', routes)
  const post = (path: string, body?: unknown) =>
    root.request(`/api/internal/projects/${seed.projectId}/github/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { post, merges, creates }
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
      encryptedToken: encryptSecret('ghp_route_token'),
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

afterAll(async () => {
  process.env.SHOGO_LOCAL_MODE = 'true'
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

async function newCard(column: string) {
  return boards.createWorkItem(board, { title: `Card in ${column}`, column }, { userId: seed.member })
}

describe('POST /projects/:id/github/pull-request links the card', () => {
  test('an explicit workItem links that card and says so in the response', async () => {
    const t = app()
    const card = await newCard('In Development')
    const res = await t.post('pull-request', { title: 'A change', head: 'feature/whatever', workItem: card.key })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workItem).toBe(card.key)
    const link = await db.workItemLink.findFirst({ where: { workItemId: card.id, kind: 'pr' } })
    expect(link.refId).toBe(String(body.number))
    expect(link.metadata.repo).toBe('shogo-labs/shogo-ai')
  })

  test('with no workItem the head branch names the card', async () => {
    const t = app()
    const card = await newCard('In Development')
    const res = await t.post('pull-request', { title: 'A change', head: `${card.key.toLowerCase()}-pr-aware-cards` })
    expect((await res.json()).workItem).toBe(card.key)
  })

  test('a PR with no card key is created without a link and without an error', async () => {
    const t = app()
    const before = await db.workItemLink.count({ where: { kind: 'pr' } })
    const res = await t.post('pull-request', { title: 'Drive-by fix', head: 'feature/no-key' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workItem).toBeUndefined()
    expect(await db.workItemLink.count({ where: { kind: 'pr' } })).toBe(before)
  })
})

describe('POST /projects/:id/github/pull-request/:number/merge respects the column', () => {
  test('409 merge_not_allowed_in_column from a column that does not allow arming', async () => {
    const t = app()
    const card = await newCard('In Development')
    await db.workItemLink.create({
      data: {
        workItemId: card.id,
        workspaceId: card.workspaceId,
        kind: 'pr',
        refId: '1801',
        reason: 'sync',
        metadata: { repo: 'shogo-labs/shogo-ai', number: 1801 },
      },
    })
    const res = await t.post('pull-request/1801/merge', {})
    expect(res.status).toBe(409)
    const error = (await res.json()).error
    expect(error.code).toBe('merge_not_allowed_in_column')
    expect(error.column).toBe('In Development')
    expect(error.allowedColumns).toEqual(['PR Open'])
    expect(error.message).toContain(card.key)
    expect(t.merges).toEqual([])
  })

  test('the same call from an arming column merges', async () => {
    const t = app()
    const card = await newCard('PR Open')
    await db.workItemLink.create({
      data: {
        workItemId: card.id,
        workspaceId: card.workspaceId,
        kind: 'pr',
        refId: '1802',
        reason: 'sync',
        metadata: { repo: 'shogo-labs/shogo-ai', number: 1802 },
      },
    })
    const res = await t.post('pull-request/1802/merge', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, merged: true })
    expect(t.merges).toHaveLength(1)
  })

  test('a PR with no card on the board merges as before', async () => {
    const t = app()
    expect((await t.post('pull-request/1803/merge', {})).status).toBe(200)
    expect(t.merges).toHaveLength(1)
  })
})
