// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Marketplace apps with a `shogo.app.json`: publish validates the manifest,
 * install asks for consent and provisions a grant plus install-owned
 * subscriptions (a Composio trigger under the installer's entity), deliveries
 * are redacted to the granted scopes, an update that asks for more access
 * waits for re-consent, and uninstall revokes everything.
 *
 * The installed project's runtime is a recording stub; the real runtime path
 * for hooks is covered by code-hook.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildEventsApp,
  caller,
  createFakeComposio,
  runWorkerTick,
  seedWorkspace,
  setupEventsDb,
  signComposioWebhook,
  waitFor,
  waitForDelivery,
  writeEventScript,
  type FakeComposio,
  type SeededEventsWorkspace,
} from './helpers'

const { dir, scriptPath } = setupEventsDb()
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-events-apps-'))
process.env.WORKSPACES_DIR = workspacesDir
process.env.NODE_ENV = 'test'

const { prisma } = await import('../../apps/api/src/lib/prisma')
const { marketplaceRoutes } = await import('../../apps/api/src/routes/marketplace')
const { setComposioTriggersClient } = await import('../../apps/api/src/services/composio-triggers.service')
const { setProjectRuntimeUrlResolver } = await import('../../apps/api/src/services/agent-call.service')
const { onWorkspaceMemberJoined } = await import('../../apps/api/src/services/workspace-events')
const { installScriptedEventAgentFromEnv, scriptedEventRuns } = await import('../../apps/api/src/services/event-agent-script')

const db = prisma as any
const app = await buildEventsApp()
app.route('/api/marketplace', marketplaceRoutes())
const call = caller(app)
const FIXTURES = join(import.meta.dir, 'fixtures/apps')

let fake: FakeComposio
let seed: SeededEventsWorkspace
let creatorUserId: string
let listing: { id: string; slug: string; projectId: string }
let installId: string
let installedProjectId: string

const hookCalls: Array<{ projectId: string; token: string | null; body: any }> = []
const runtimeStub = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const projectId = url.pathname.split('/')[1]
    if (url.pathname.endsWith('/agent/events')) {
      hookCalls.push({ projectId, token: req.headers.get('x-runtime-token'), body: await req.json() })
      return Response.json({ ok: true, handled: 1, messages: [] })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  },
})

function useFixture(name: string) {
  const dest = join(workspacesDir, listing.projectId)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(join(FIXTURES, name), dest, { recursive: true })
}

async function publish(version: string) {
  return call(creatorUserId, 'POST', `/marketplace/creator/listings/${listing.id}/versions`, { version, changelog: `v${version}` })
}

async function joinMember(name: string) {
  const user = await db.user.create({ data: { name, email: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}@example.com` } })
  const member = await db.member.create({ data: { userId: user.id, workspaceId: seed.workspaceId, role: 'member' } })
  await onWorkspaceMemberJoined({ workspaceId: seed.workspaceId, userId: user.id, memberId: member.id, role: 'member', source: 'invitation' })
  return user
}

async function hookDeliveryFor(userId: string) {
  return waitFor(async () => {
    await runWorkerTick()
    return hookCalls.find((h) => h.body.envelope.payload.member.userId === userId) ?? null
  })
}

const entityOf = (userId: string, workspaceId: string) => `shogo_${userId}_${workspaceId}`

beforeAll(async () => {
  installScriptedEventAgentFromEnv()
  writeEventScript(scriptPath, { '*': [{ reply: 'Handled {{event.type}} for the app.' }] })
  fake = await createFakeComposio()
  setComposioTriggersClient(fake.client)
  setProjectRuntimeUrlResolver((projectId) => `http://127.0.0.1:${runtimeStub.port}/${projectId}`)

  seed = await seedWorkspace(db)
  const creator = await db.user.create({ data: { name: 'Creator', email: `creator-${Date.now()}@example.com` } })
  creatorUserId = creator.id
  const creatorWs = await db.workspace.create({ data: { name: 'Creator Co', slug: `creator-${Date.now()}`, kind: 'team' } })
  await db.member.create({ data: { userId: creator.id, workspaceId: creatorWs.id, role: 'owner' } })
  const source = await db.project.create({ data: { name: 'Welcome Bot', workspaceId: creatorWs.id } })
  const profile = await db.creatorProfile.create({ data: { userId: creator.id, displayName: 'Creator' } })
  const row = await db.marketplaceListing.create({
    data: {
      projectId: source.id,
      creatorId: profile.id,
      slug: `welcome-bot-${Date.now()}`,
      title: 'Welcome Bot',
      shortDescription: 'Greets new members and triages GitHub issues',
      status: 'published',
      currentVersion: '0.0.0',
    },
  })
  listing = { id: row.id, slug: row.slug, projectId: source.id }
})

afterAll(async () => {
  setProjectRuntimeUrlResolver(null)
  setComposioTriggersClient(null)
  runtimeStub.stop(true)
  await db.$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workspacesDir, { recursive: true, force: true })
})

describe('marketplace app lifecycle', () => {
  test('publishing an invalid manifest fails with every problem listed', async () => {
    useFixture('invalid')
    const res = await publish('0.9.0')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('invalid_app_manifest')
    const errors: string[] = res.json.errors
    expect(errors.some((e) => e.includes('Unknown scope "files:delete"'))).toBe(true)
    expect(errors.some((e) => e.includes('prompt is required'))).toBe(true)
    expect(errors.some((e) => e.includes('exact type'))).toBe(true)
    expect(errors.some((e) => e.includes('"slack" in requiredToolkits'))).toBe(true)
    expect(await db.marketplaceListingVersion.count({ where: { listingId: listing.id } })).toBe(0)
  })

  test('publishing a valid app stores its manifest and exposes a consent request', async () => {
    useFixture('welcome-bot/v1')
    const res = await publish('1.0.0')
    expect(res.status).toBe(200)
    const version = await db.marketplaceListingVersion.findFirst({ where: { listingId: listing.id, version: '1.0.0' } })
    expect(version.appManifest).toMatchObject({ requiredToolkits: ['github'], scopes: ['members:read'] })

    const consent = await call(seed.owner, 'GET', `/marketplace/${listing.slug}/consent`)
    expect(consent.status).toBe(200)
    expect(consent.json.consent).toMatchObject({
      version: '1.0.0',
      scopes: [{ scope: 'members:read' }],
      optionalScopes: [{ scope: 'members:read.email' }],
      requiredToolkits: ['github'],
    })
    expect(consent.json.consent.events).toHaveLength(2)
  })

  test('installing without consent, or without the required toolkit, creates nothing', async () => {
    const noConsent = await call(seed.owner, 'POST', `/marketplace/${listing.slug}/install`, { workspaceId: seed.workspaceId })
    expect(noConsent.status).toBe(409)
    expect(noConsent.json.error).toBe('consent_required')
    expect(noConsent.json.consent.requiredToolkits).toEqual(['github'])

    const notConnected = await call(seed.owner, 'POST', `/marketplace/${listing.slug}/install`, {
      workspaceId: seed.workspaceId, consent: { accept: true },
    })
    expect(notConnected.status).toBe(409)
    expect(notConnected.json).toMatchObject({ error: 'needs_connection', toolkits: ['github'] })

    expect(await db.marketplaceInstall.count({ where: { listingId: listing.id } })).toBe(0)
    expect(await db.project.count({ where: { workspaceId: seed.workspaceId, name: 'Welcome Bot' } })).toBe(0)
    expect(await db.appInstallGrant.count()).toBe(0)
    expect(fake.calls.filter((c) => c.method === 'create')).toHaveLength(0)
  })

  test('installing with consent creates the grant, subscriptions and a Composio trigger for the installer', async () => {
    fake.connect(entityOf(seed.owner, seed.workspaceId), 'github')
    const res = await call(seed.owner, 'POST', `/marketplace/${listing.slug}/install`, {
      workspaceId: seed.workspaceId, consent: { accept: true },
    })
    expect(res.status).toBe(200)
    installId = res.json.installId
    installedProjectId = res.json.projectId
    expect(res.json.grantedScopes.sort()).toEqual(['composio:github:read', 'members:read'])

    const grant = await db.appInstallGrant.findUnique({ where: { installId } })
    expect(grant).toMatchObject({ status: 'active', version: '1.0.0', grantedByUserId: seed.owner, grantedToolkits: ['github'] })

    const subs = await db.eventSubscription.findMany({ where: { installId }, orderBy: { createdAt: 'asc' } })
    expect(subs).toHaveLength(2)
    for (const sub of subs) expect(sub).toMatchObject({ ownerKind: 'app', ownerUserId: seed.owner, target: 'project', targetProjectId: installedProjectId })
    expect(subs.map((s: any) => [s.eventType, s.targetMode])).toEqual([
      ['member.joined', 'hook'],
      ['composio.github.GITHUB_ISSUE_ADDED_EVENT', 'agent'],
    ])
    const create = fake.calls.find((c) => c.method === 'create')!
    expect(create.args[0]).toBe(entityOf(seed.owner, seed.workspaceId))
    expect(create.args[1]).toBe('GITHUB_ISSUE_ADDED_EVENT')
    expect((create.args[2] as any).triggerConfig).toEqual({ owner: 'acme', repo: 'app' })
  })

  test('app-owned triggers cannot be deleted or rewired from the triggers API', async () => {
    const sub = await db.eventSubscription.findFirst({ where: { installId, eventType: 'member.joined' } })
    const del = await call(seed.owner, 'DELETE', `/workspaces/${seed.workspaceId}/triggers/${sub.id}`)
    expect(del.status).toBe(409)
    expect(del.json.error.code).toBe('app_managed')
    const rewire = await call(seed.owner, 'PATCH', `/workspaces/${seed.workspaceId}/triggers/${sub.id}`, { filter: { 'member.role': 'admin' } })
    expect(rewire.status).toBe(409)
  })

  test('a join reaches the app hook without the email it was not granted', async () => {
    const user = await joinMember('Grace')
    const hit = await hookDeliveryFor(user.id)
    expect(hit.projectId).toBe(installedProjectId)
    expect(hit.token).toMatch(/^wrt_v1_/)
    expect(hit.body.envelope.type).toBe('member.joined')
    expect(hit.body.envelope.payload.member).toMatchObject({ userId: user.id, name: 'Grace', role: 'member' })
    expect(hit.body.envelope.payload.member.email).toBeUndefined()
  })

  test('a GitHub issue reaches the app agent through its Composio trigger', async () => {
    const sub = await db.eventSubscription.findFirst({ where: { installId, source: 'composio' } })
    const webhook = signComposioWebhook({
      triggerId: sub.composioTriggerId,
      triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT',
      connectedAccountId: sub.composioConnectedAccountId,
      entityId: sub.composioEntityId,
      data: { title: 'Login is broken', number: 42 },
    })
    const res = await app.request('/api/webhooks/composio', { method: 'POST', headers: webhook.headers, body: webhook.body })
    expect(res.status).toBe(200)
    const delivery = await waitForDelivery(db, sub.id, 'ok')
    expect(delivery.summary).toContain('Handled composio.github.GITHUB_ISSUE_ADDED_EVENT')
    const run = scriptedEventRuns.find((r) => r.subscriptionId === sub.id)!
    expect(run.projectId).toBe(installedProjectId)
    expect(run.prompt).toContain('Login is broken')
  })

  test('granting the optional email scope adds the email to later deliveries', async () => {
    const res = await call(seed.owner, 'POST', `/marketplace/installs/${installId}/consent`, { accept: true, optionalScopes: ['members:read.email'] })
    expect(res.status).toBe(200)
    expect(res.json.grant.grantedScopes).toContain('members:read.email')

    const byOther = await call(seed.member, 'POST', `/marketplace/installs/${installId}/consent`, { accept: true })
    expect(byOther.status).toBe(403)

    const user = await joinMember('Linus')
    const hit = await hookDeliveryFor(user.id)
    expect(hit.body.envelope.payload.member.email).toBe(user.email)
  })

  test('an update asking for a new scope waits for re-consent; deliveries keep the old grant', async () => {
    useFixture('welcome-bot/v2')
    expect((await publish('2.0.0')).status).toBe(200)
    const updated = await call(seed.owner, 'POST', `/marketplace/installs/${installId}/update`, { force: true })
    expect(updated.status).toBe(200)
    expect(updated.json).toMatchObject({ ok: true, installedVersion: '2.0.0', pendingScopes: ['chat:write'] })

    const grant = await db.appInstallGrant.findUnique({ where: { installId } })
    expect(grant).toMatchObject({ version: '1.0.0', pendingVersion: '2.0.0', pendingScopes: ['chat:write'] })
    expect(grant.grantedScopes).not.toContain('chat:write')
    expect(await db.eventSubscription.count({ where: { installId } })).toBe(2)

    const user = await joinMember('Ken')
    const hit = await hookDeliveryFor(user.id)
    expect(hit.body.envelope.payload.member.email).toBe(user.email)
    expect(await db.eventSubscription.count({ where: { installId, name: { contains: 'Greeter' } } })).toBe(0)

    const view = await call(seed.owner, 'GET', `/marketplace/installs/${installId}/grant`)
    expect(view.json.consent.scopes.map((s: any) => s.scope)).toContain('chat:write')

    const consent = await call(seed.owner, 'POST', `/marketplace/installs/${installId}/consent`, { accept: true, optionalScopes: ['members:read.email'] })
    expect(consent.status).toBe(200)
    expect(consent.json.grant).toMatchObject({ version: '2.0.0', pendingScopes: [], pendingVersion: null })
    expect(consent.json.grant.grantedScopes).toContain('chat:write')
    expect(await db.eventSubscription.count({ where: { installId } })).toBe(3)
  })

  test('uninstalling revokes the grant, deletes the subscriptions and the Composio trigger', async () => {
    const composioSub = await db.eventSubscription.findFirst({ where: { installId, source: 'composio' } })
    const res = await call(seed.owner, 'DELETE', `/marketplace/installs/${installId}`)
    expect(res.status).toBe(200)

    expect(await db.eventSubscription.count({ where: { installId } })).toBe(0)
    expect(await db.appInstallGrant.findUnique({ where: { installId } })).toMatchObject({ status: 'revoked' })
    expect(fake.calls.some((c) => c.method === 'delete' && c.args[0] === composioSub.composioTriggerId)).toBe(true)
    expect(fake.triggers.has(composioSub.composioTriggerId)).toBe(false)

    const before = hookCalls.length
    await joinMember('After')
    await runWorkerTick()
    expect(hookCalls.length).toBe(before)
  })
})
