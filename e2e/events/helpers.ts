// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Harness for the workspace-event e2e suites (`e2e/events/*.integration.test.ts`).
 *
 * Each suite gets a throwaway SQLite database built from the desktop
 * migrations (call `setupEventsDb()` before anything imports `lib/prisma`),
 * the real API routers mounted on one Hono app, a fake Composio client that
 * keeps trigger state in memory but verifies webhooks with the real SDK, and
 * the scripted event agent so deliveries are deterministic.
 *
 *   bun run test:e2e:events
 */

import { createHmac, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { setupChannelsTestDb, waitFor } from '../../apps/api/src/__tests__/helpers/channels-test-db'

export { waitFor }

export const COMPOSIO_WEBHOOK_SECRET = 'whsec_e2e_events'

export function setupEventsDb(): { dir: string; scriptPath: string } {
  const { dir } = setupChannelsTestDb()
  const scriptPath = join(dir, 'event-agent-script.json')
  writeFileSync(scriptPath, JSON.stringify({ triggers: {} }))
  process.env.SHOGO_EVENT_AGENT_SCRIPT = scriptPath
  process.env.COMPOSIO_WEBHOOK_SECRET = COMPOSIO_WEBHOOK_SECRET
  delete process.env.SHOGO_API_KEY
  process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
  return { dir, scriptPath }
}

/** Rewrite the scripted agent's rules (re-read on every delivery). */
export function writeEventScript(scriptPath: string, triggers: Record<string, unknown[]>): void {
  writeFileSync(scriptPath, JSON.stringify({ triggers }))
}

export interface SeededEventsWorkspace {
  workspaceId: string
  owner: string
  ownerEmail: string
  member: string
  viewer: string
  newcomer: string
  newcomerEmail: string
  outsider: string
  projectId: string
}

/** Workspace with an owner, member, viewer, a not-yet-joined newcomer, and one project. */
export async function seedWorkspace(db: any): Promise<SeededEventsWorkspace> {
  const suffix = randomUUID().slice(0, 8)
  const mkUser = (name: string) => db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [owner, member, viewer, newcomer, outsider] = await Promise.all([
    mkUser('owner'), mkUser('member'), mkUser('viewer'), mkUser('Newcomer'), mkUser('outsider'),
  ])
  const ws = await db.workspace.create({ data: { name: 'Acme', slug: `acme-${suffix}`, kind: 'team' } })
  await db.member.create({ data: { userId: owner.id, workspaceId: ws.id, role: 'owner' } })
  await db.member.create({ data: { userId: member.id, workspaceId: ws.id, role: 'member' } })
  await db.member.create({ data: { userId: viewer.id, workspaceId: ws.id, role: 'viewer' } })
  const project = await db.project.create({ data: { name: 'Triage Bot', workspaceId: ws.id } })
  return {
    workspaceId: ws.id,
    owner: owner.id,
    ownerEmail: owner.email,
    member: member.id,
    viewer: viewer.id,
    newcomer: newcomer.id,
    newcomerEmail: newcomer.email,
    outsider: outsider.id,
    projectId: project.id,
  }
}

// ─── Fake Composio ──────────────────────────────────────────────────────

export interface FakeComposio {
  client: any
  calls: Array<{ method: string; args: unknown[] }>
  /** entityId → connected accounts */
  accounts: Map<string, Array<{ id: string; toolkit: string; status?: string }>>
  /** triggerId → state */
  triggers: Map<string, { slug: string; entityId: string; connectedAccountId?: string; config: unknown; disabled: boolean }>
  connect(entityId: string, toolkit: string, id?: string): string
}

const TRIGGER_TYPES = [
  {
    slug: 'GITHUB_ISSUE_ADDED_EVENT',
    name: 'Issue added',
    description: 'A new issue was opened in a repository',
    toolkit: { slug: 'github', name: 'GitHub' },
    config: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    payload: { type: 'object', properties: { title: { type: 'string' }, number: { type: 'number' } } },
  },
  {
    slug: 'SLACK_RECEIVE_MESSAGE',
    name: 'Message received',
    description: 'A message was posted in a channel',
    toolkit: { slug: 'slack', name: 'Slack' },
    config: { type: 'object', properties: {} },
    payload: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

export async function createFakeComposio(): Promise<FakeComposio> {
  const { Composio } = await import(Bun.resolveSync('@composio/core', join(import.meta.dir, '../../apps/api')))
  const real: any = new Composio({ apiKey: 'e2e-fake' } as any)
  const calls: FakeComposio['calls'] = []
  const accounts: FakeComposio['accounts'] = new Map()
  const triggers: FakeComposio['triggers'] = new Map()
  const record = (method: string, args: unknown[]) => calls.push({ method, args })

  const client = {
    triggers: {
      async create(entityId: string, slug: string, body?: { connectedAccountId?: string; triggerConfig?: unknown }) {
        record('create', [entityId, slug, body])
        const triggerId = `ti_${randomUUID().slice(0, 12)}`
        triggers.set(triggerId, { slug, entityId, connectedAccountId: body?.connectedAccountId, config: body?.triggerConfig, disabled: false })
        return { triggerId }
      },
      async delete(id: string) {
        record('delete', [id])
        triggers.delete(id)
        return {}
      },
      async disable(id: string) {
        record('disable', [id])
        const t = triggers.get(id)
        if (t) t.disabled = true
        return {}
      },
      async enable(id: string) {
        record('enable', [id])
        const t = triggers.get(id)
        if (t) t.disabled = false
        return {}
      },
      async listActive(query?: { triggerIds?: string[] }) {
        record('listActive', [query])
        const items = [...triggers.entries()]
          .filter(([id]) => !query?.triggerIds || query.triggerIds.includes(id))
          .map(([id, t]) => ({ id, disabledAt: t.disabled ? new Date().toISOString() : null }))
        return { items }
      },
      async listTypes(query?: { toolkits?: string[] }) {
        record('listTypes', [query])
        return { items: TRIGGER_TYPES.filter((t) => !query?.toolkits || query.toolkits.includes(t.toolkit.slug)) }
      },
      async getType(slug: string) {
        const found = TRIGGER_TYPES.find((t) => t.slug === slug)
        if (!found) throw new Error(`Unknown trigger type ${slug}`)
        return found
      },
      verifyWebhook: (params: any) => real.triggers.verifyWebhook(params),
    },
    connectedAccounts: {
      async list(query: { userIds?: string[]; toolkitSlugs?: string[] }) {
        const items = (query.userIds ?? []).flatMap((entity) => (accounts.get(entity) ?? [])
          .filter((a) => !query.toolkitSlugs || query.toolkitSlugs.includes(a.toolkit))
          .map((a) => ({ id: a.id, status: a.status ?? 'ACTIVE', toolkit: { slug: a.toolkit } })))
        return { items }
      },
      async delete(id: string) {
        record('connectedAccounts.delete', [id])
        for (const [entity, list] of accounts) accounts.set(entity, list.filter((a) => a.id !== id))
        return {}
      },
    },
  }

  return {
    client,
    calls,
    accounts,
    triggers,
    connect(entityId, toolkit, id = `ca_${randomUUID().slice(0, 10)}`) {
      accounts.set(entityId, [...(accounts.get(entityId) ?? []), { id, toolkit }])
      return id
    },
  }
}

/** A V3 Composio trigger webhook, signed the way Composio signs it. */
export function signComposioWebhook(input: {
  triggerId: string
  triggerSlug: string
  connectedAccountId?: string
  entityId?: string
  data: Record<string, unknown>
  webhookId?: string
  secret?: string
  timestamp?: string
}): { body: string; headers: Record<string, string>; webhookId: string } {
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    type: 'composio.trigger.message',
    metadata: {
      log_id: `log_${randomUUID().slice(0, 8)}`,
      trigger_slug: input.triggerSlug,
      trigger_id: input.triggerId,
      connected_account_id: input.connectedAccountId ?? 'ca_unknown',
      auth_config_id: 'ac_e2e',
      user_id: input.entityId ?? 'shogo_e2e',
    },
    data: input.data,
  })
  const webhookId = input.webhookId ?? `msg_${randomUUID()}`
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString()
  const signature = `v1,${createHmac('sha256', input.secret ?? COMPOSIO_WEBHOOK_SECRET).update(`${webhookId}.${timestamp}.${body}`).digest('base64')}`
  return {
    body,
    webhookId,
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    },
  }
}

// ─── App ────────────────────────────────────────────────────────────────

/**
 * The real routers, mounted like `server.ts` does: session routes under
 * `/api` (the acting user comes from `x-user`), the runtime's internal routes
 * under `/api/internal` (trusted as the workspace), and the public Composio
 * webhook.
 */
export async function buildEventsApp(): Promise<Hono> {
  const { prisma } = await import('../../apps/api/src/lib/prisma')
  const { workspaceAgentRoutes, sessionAuthorize } = await import('../../apps/api/src/routes/workspace-agent')
  const { conversationRoutes, agentChannelRoutes } = await import('../../apps/api/src/routes/conversations')
  const { inviteLinkAcceptRoutes } = await import('../../apps/api/src/routes/invite-link-accept')
  const { handleComposioWebhook } = await import('../../apps/api/src/services/composio-triggers.service')
  const { createMemberRoutes, setPrisma, setMemberHooks } = await import('../../apps/api/src/generated/member.routes')
  const { memberHooks } = await import('../../apps/api/src/generated/member.hooks')
  setPrisma(prisma as any)
  setMemberHooks(memberHooks)

  const userOf = async (c: any) => c.req.header('x-user') ?? null
  const app = new Hono()
  app.use('/api/*', async (c, next) => {
    const userId = c.req.header('x-user')
    if (userId) c.set('auth' as never, { userId, isAuthenticated: true, email: `${userId}@example.com` } as never)
    await next()
  })
  app.post('/api/webhooks/composio', async (c) => {
    const result = await handleComposioWebhook({
      rawBody: await c.req.text(),
      headers: {
        id: c.req.header('webhook-id'),
        timestamp: c.req.header('webhook-timestamp'),
        signature: c.req.header('webhook-signature'),
      },
    })
    return c.json(result.body, result.status)
  })
  app.route('/api', inviteLinkAcceptRoutes({ resolveUserId: userOf }))
  app.route('/api/members', createMemberRoutes())
  app.route('/api', conversationRoutes({ resolveUserId: userOf }))
  app.route('/api', workspaceAgentRoutes({ authorize: sessionAuthorize(userOf) }))
  app.route('/api/internal', workspaceAgentRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId') }),
  }))
  app.route('/api/internal', agentChannelRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param('workspaceId') }),
  }))
  const { integrationRoutes } = await import('../../apps/api/src/routes/integrations')
  app.route('/api', integrationRoutes())
  const { appActionsRoutes } = await import('../../apps/api/src/routes/app-actions')
  app.route('/api/v1', appActionsRoutes())
  return app
}

export function caller(app: Hono) {
  return async function call(user: string | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(user ? { 'x-user': user } : {}),
        ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
}

// ─── Worker ─────────────────────────────────────────────────────────────

/** One dispatcher pass, then wait for every delivery it started. */
export async function runWorkerTick(): Promise<number> {
  const worker = await import('../../apps/api/src/jobs/run-event-delivery-dispatch')
  const started = await worker.runEventDeliveryDispatch()
  await worker.waitForEventDeliveries()
  return started
}

/** Make failed deliveries due again immediately. */
export async function freezeBackoff(): Promise<void> {
  const worker = await import('../../apps/api/src/jobs/run-event-delivery-dispatch')
  worker.setEventDeliveryBackoff([0, 0, 0, 0])
}

export async function waitForDelivery(db: any, subscriptionId: string, status: string | string[], timeoutMs = 5_000) {
  const statuses = Array.isArray(status) ? status : [status]
  return waitFor(async () => {
    await runWorkerTick()
    return db.eventDelivery.findFirst({ where: { subscriptionId, status: { in: statuses } }, orderBy: { createdAt: 'desc' } })
  }, timeoutMs)
}

/** Waits for a fire-and-forget emit (e.g. from a generated-route hook) to land. */
export async function waitForEvent(db: any, workspaceId: string, type: string, timeoutMs = 5_000) {
  return waitFor(() => db.workspaceEvent.findFirst({ where: { workspaceId, type }, orderBy: { occurredAt: 'desc' } }), timeoutMs)
}
