// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Install tokens and the workspace actions API (`/api/v1/<method>`): an
 * installed app's code hook, running in a real spawned agent runtime, uses its
 * install token to DM a new member and add them to #onboarding, attributed to
 * the app. Tokens are limited to their granted scopes and workspace, refused
 * everywhere else, and stop working the moment the app is revoked or
 * uninstalled.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEventsApp, caller, runWorkerTick, seedWorkspace, setupEventsDb, waitFor, type SeededEventsWorkspace } from './helpers'

const { dir } = setupEventsDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-events-app-actions-'))
process.env.WORKSPACES_DIR = workspacesDir
process.env.NODE_ENV = 'test'

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { marketplaceRoutes } = await import('../../apps/api/src/routes/marketplace')
const { resolveApiKey } = await import('../../apps/api/src/routes/api-keys')
const { generateApiKey } = await import('../../apps/api/src/lib/api-keys-mint')
const { setProjectRuntimeUrlResolver } = await import('../../apps/api/src/services/agent-call.service')
const { deriveProjectRuntimeToken } = await import('../../apps/api/src/lib/project-runtime-token')
const { onWorkspaceMemberJoined } = await import('../../apps/api/src/services/workspace-events')
const grants = await import('../../apps/api/src/services/app-install-grants.service')

const db = prisma as any
const app = await buildEventsApp()
app.route('/api/marketplace', marketplaceRoutes())
const call = caller(app)
const api = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => app.fetch(req) })
const apiUrl = `http://127.0.0.1:${api.port}`
const FIXTURES = join(import.meta.dir, 'fixtures/apps')

let seed: SeededEventsWorkspace
let creatorUserId: string
let creatorWorkspaceId: string
let onboardingId: string
let runtime: ReturnType<typeof Bun.spawn> | null = null
let runtimeUrl = ''
const greeter = { installId: '', projectId: '', slug: '', token: '' }
const notifier = { installId: '', projectId: '', slug: '', token: '' }

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  return port
}

async function action(token: string, method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${apiUrl}/api/v1/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function publishApp(fixture: string, title: string) {
  const source = await db.project.create({ data: { name: title, workspaceId: creatorWorkspaceId } })
  const dest = join(workspacesDir, source.id)
  mkdirSync(dest, { recursive: true })
  cpSync(join(FIXTURES, fixture), dest, { recursive: true })
  const profile = await db.creatorProfile.findFirst({ where: { userId: creatorUserId } })
  const listing = await db.marketplaceListing.create({
    data: {
      projectId: source.id,
      creatorId: profile.id,
      slug: `${fixture}-${Date.now()}`,
      title,
      shortDescription: `${title} e2e app`,
      status: 'published',
      currentVersion: '0.0.0',
    },
  })
  const res = await call(creatorUserId, 'POST', `/marketplace/creator/listings/${listing.id}/versions`, { version: '1.0.0', changelog: 'v1' })
  expect(res.status).toBe(200)
  return listing.slug as string
}

async function install(slug: string) {
  const res = await call(seed.owner, 'POST', `/marketplace/${slug}/install`, { workspaceId: seed.workspaceId, consent: { accept: true } })
  expect(res.status).toBe(200)
  const token = await grants.appTokenForProject(res.json.projectId)
  expect(token).toMatch(/^shogo_sk_/)
  return { installId: res.json.installId as string, projectId: res.json.projectId as string, slug, token: token! }
}

async function joinMember(name: string) {
  const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com` } })
  const member = await db.member.create({ data: { userId: user.id, workspaceId: seed.workspaceId, role: 'member' } })
  await onWorkspaceMemberJoined({ workspaceId: seed.workspaceId, userId: user.id, memberId: member.id, role: 'member', source: 'invitation' })
  return user
}

async function spawnRuntime(projectId: string) {
  const workspaceDir = join(workspacesDir, projectId)
  cpSync(join(FIXTURES, 'greeter'), workspaceDir, { recursive: true })
  const port = freePort()
  runtimeUrl = `http://127.0.0.1:${port}`
  const runtimeToken = await deriveProjectRuntimeToken(projectId, { workspaceId: seed.workspaceId })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.DATABASE_URL
  delete env.SHOGO_APP_TOKEN
  runtime = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '../../packages/agent-runtime/src/server.ts')], {
    env: {
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      WORKSPACE_DIR: workspaceDir,
      RUNTIME_AUTH_SECRET: runtimeToken,
      PROJECT_ID: projectId,
      WORKSPACE_ID: seed.workspaceId,
      SHOGO_API_URL: apiUrl,
      NODE_ENV: 'test',
    },
    stdout: process.env.E2E_RUNTIME_LOGS ? 'inherit' : 'ignore',
    stderr: process.env.E2E_RUNTIME_LOGS ? 'inherit' : 'ignore',
  })
  await waitFor(async () => {
    const res = await fetch(`${runtimeUrl}/agent/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken },
      body: JSON.stringify({ envelope: { id: 'probe', type: 'probe' } }),
    }).catch(() => null)
    return res?.status === 200 ? res : null
  }, 90_000)
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const creator = await db.user.create({ data: { name: 'Creator', email: `creator-${Date.now()}@example.com` } })
  creatorUserId = creator.id
  const creatorWs = await db.workspace.create({ data: { name: 'Creator Co', slug: `creator-${Date.now()}`, kind: 'team' } })
  creatorWorkspaceId = creatorWs.id
  await db.member.create({ data: { userId: creator.id, workspaceId: creatorWs.id, role: 'owner' } })
  await db.creatorProfile.create({ data: { userId: creator.id, displayName: 'Creator' } })
  const onboarding = await db.conversation.create({
    data: { workspaceId: seed.workspaceId, kind: 'public', name: 'onboarding', slug: 'onboarding', createdById: seed.owner },
  })
  onboardingId = onboarding.id

  Object.assign(greeter, await install(await publishApp('greeter', 'Greeter')))
  Object.assign(notifier, await install(await publishApp('notifier', 'Notifier')))
  await spawnRuntime(greeter.projectId)
  setProjectRuntimeUrlResolver((projectId) => (projectId === greeter.projectId ? runtimeUrl : null))
}, 150_000)

afterAll(async () => {
  setProjectRuntimeUrlResolver(null)
  runtime?.kill()
  await runtime?.exited
  api.stop(true)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workspacesDir, { recursive: true, force: true })
})

describe('install tokens and the actions API', () => {
  test('installing mints a scoped app token that the rest of the API refuses', async () => {
    const key = await db.apiKey.findFirst({ where: { installId: greeter.installId } })
    expect(key).toMatchObject({ kind: 'app', workspaceId: seed.workspaceId, userId: seed.owner })
    expect([...key.grantedScopes].sort()).toEqual(['channels:manage', 'chat:write', 'members:read'])

    expect(await resolveApiKey(greeter.token)).toBeNull()
    expect(await resolveApiKey(greeter.token, { allowAppTokens: true })).toMatchObject({ kind: 'app', installId: greeter.installId })

    const view = await call(seed.owner, 'GET', `/marketplace/installs/${greeter.installId}/grant`)
    expect(view.json.grant.hasToken).toBe(true)
    expect(view.json.grant.encryptedToken).toBeUndefined()
  })

  test("a new member gets the app's DM and joins #onboarding through the app hook", async () => {
    const user = await joinMember('Ada')
    const sub = await db.eventSubscription.findFirst({ where: { installId: greeter.installId } })
    const delivery = await waitFor(async () => {
      await runWorkerTick()
      return db.eventDelivery.findFirst({ where: { subscriptionId: sub.id, status: { in: ['ok', 'failed', 'dead'] } } })
    }, 30_000)
    expect(delivery).toMatchObject({ status: 'ok' })
    expect(delivery.summary).toContain('1 hook')

    const dm = await db.conversation.findFirst({
      where: { workspaceId: seed.workspaceId, kind: 'dm', members: { some: { userId: user.id } } },
      include: { messages: true },
    })
    expect(dm).toBeTruthy()
    expect(dm.messages).toHaveLength(1)
    const [message] = dm.messages
    expect(message.text).toBe('Welcome to the team, Ada!')
    expect(message.authorType).toBe('agent')
    expect(message.authorAgentRef).toMatchObject({ projectId: greeter.projectId, name: 'Greeter' })

    const membership = await db.conversationMember.findFirst({ where: { conversationId: onboardingId, userId: user.id } })
    expect(membership).toBeTruthy()
  })

  test('tokens only reach what their grant allows', async () => {
    const members = await action(greeter.token, 'members.list')
    expect(members.status).toBe(200)
    expect(members.json.members.some((m: any) => m.userId === seed.owner)).toBe(true)
    expect(members.json.members.every((m: any) => m.email === undefined)).toBe(true)

    const channels = await action(greeter.token, 'channels.list')
    expect(channels.status).toBe(403)
    expect(channels.json).toMatchObject({ ok: false, error: 'missing_scope', needed: 'channels:read' })

    const noMembers = await action(notifier.token, 'members.list')
    expect(noMembers.status).toBe(403)
    expect(noMembers.json.needed).toBe('members:read')

    const posted = await action(notifier.token, 'chat.postMessage', { channel: 'onboarding', text: 'Deploy finished' })
    expect(posted.status).toBe(200)
    const row = await db.conversationMessage.findUnique({ where: { id: posted.json.message.id } })
    expect(row.authorAgentRef).toMatchObject({ projectId: notifier.projectId, name: 'Notifier' })

    const other = await action(greeter.token, 'members.list', { workspaceId: creatorWorkspaceId })
    expect(other.status).toBe(403)
    expect(other.json.error).toBe('wrong_workspace')

    const anonymous = await fetch(`${apiUrl}/api/v1/members.list`, { method: 'POST' })
    expect(anonymous.status).toBe(401)
  })

  test('a personal API key acts with its owner\u2019s full access', async () => {
    const { fullKey: key, keyHash, keyPrefix } = await generateApiKey()
    await db.apiKey.create({ data: { name: 'e2e', keyHash, keyPrefix, workspaceId: seed.workspaceId, userId: seed.owner } })
    const members = await action(key, 'members.list')
    expect(members.status).toBe(200)
    expect(members.json.members.find((m: any) => m.userId === seed.owner).email).toBeTruthy()
    const channels = await action(key, 'channels.list')
    expect(channels.json.channels.map((c: any) => c.slug)).toContain('onboarding')
  })

  test('settings list the workspace grants, and a failed delivery can be redelivered', async () => {
    const list = await call(seed.member, 'GET', `/workspaces/${seed.workspaceId}/app-grants`)
    expect(list.status).toBe(200)
    const byTitle = Object.fromEntries(list.json.grants.map((g: any) => [g.app.title, g]))
    expect(byTitle.Greeter).toMatchObject({ status: 'active', hasToken: true, projectId: greeter.projectId, grantedBy: { id: seed.owner } })
    expect(byTitle.Notifier.grantedScopes).toEqual(['chat:write'])
    expect(byTitle.Greeter.encryptedToken).toBeUndefined()

    const sub = await db.eventSubscription.findFirst({ where: { installId: greeter.installId } })
    const done = await db.eventDelivery.findFirst({ where: { subscriptionId: sub.id, status: 'ok' } })
    await db.eventDelivery.update({ where: { id: done.id }, data: { status: 'dead', attempts: 5, error: 'boom' } })
    const path = `/workspaces/${seed.workspaceId}/triggers/${sub.id}/deliveries/${done.id}/redeliver`
    expect((await call(seed.viewer, 'POST', path)).status).toBe(403)
    const res = await call(seed.owner, 'POST', path)
    expect(res.status).toBe(202)
    expect(res.json.delivery).toMatchObject({ status: 'pending', attempts: 0, error: null })
    const again = await waitFor(async () => {
      await runWorkerTick()
      const row = await db.eventDelivery.findUnique({ where: { id: done.id } })
      return row.status === 'ok' ? row : null
    }, 30_000)
    expect(again.attempts).toBe(1)
    expect((await call(seed.owner, 'POST', `/workspaces/${seed.workspaceId}/triggers/${sub.id}/deliveries/nope/redeliver`)).status).toBe(404)
  })

  test('revoking or uninstalling cuts the token off immediately', async () => {
    expect((await call(seed.member, 'POST', `/marketplace/installs/${greeter.installId}/revoke`)).status).toBe(403)
    await db.member.updateMany({ where: { workspaceId: seed.workspaceId, userId: seed.member }, data: { role: 'admin' } })
    const revoked = await call(seed.member, 'POST', `/marketplace/installs/${greeter.installId}/revoke`)
    expect(revoked.status).toBe(200)
    const afterRevoke = await action(greeter.token, 'members.list')
    expect(afterRevoke.status).toBe(401)

    const uninstalled = await call(seed.owner, 'DELETE', `/marketplace/installs/${notifier.installId}`)
    expect(uninstalled.status).toBe(200)
    const afterUninstall = await action(notifier.token, 'chat.postMessage', { channel: 'onboarding', text: 'still here?' })
    expect(afterUninstall.status).toBe(401)
    expect(await grants.appTokenForProject(notifier.projectId)).toBeNull()
  })
})
