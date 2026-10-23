// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One process of the machine-workspace test (SHO-185), for the integration suite
 * that runs a real desktop against two real cloud API processes.
 *
 *   bun machine-workspace-pod.ts cloud <port>            a cloud API pod
 *   bun machine-workspace-pod.ts desktop <port>          a paired desktop
 *
 * Both load the *real* modules — `routes/machines`, the generated CRUD routes,
 * `lib/prisma`, the SQLite triggers and `MachineSyncPusher` — so the test
 * exercises the path a person's workspace actually takes, not a mock of it.
 * That distinction is the point: mocked relay tests passed while prod-US said
 * "Machine is offline" for two hours.
 *
 * The cloud pod runs on Postgres (`SHOGO_APP_DATABASE_URL`), the desktop on
 * SQLite, exactly like production.
 */

import { Hono } from 'hono'

const role = process.argv[2]
const port = Number(process.argv[3] || 0)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// ─── Cloud pod ──────────────────────────────────────────────────────────────

if (role === 'cloud') {
  const { machineRoutes } = await import('../../routes/machines')
  const { instanceRoutes } = await import('../../routes/instances')
  const { createGeneratedRoutes } = await import('../../generated/routes')
  const { resolveApiKey } = await import('../../routes/api-keys')
  const { workspaceAgentRoutes, sessionAuthorize } = await import('../../routes/workspace-agent')
  const { prisma } = await import('../../lib/prisma')

  const app = new Hono()

  /**
   * The harness's only stand-in for real auth: a person is whoever the caller
   * says, so a test can act as an owner or as an outsider, and a machine is
   * whoever its device key resolves to. Everything after this line —
   * memberships, workspace access, the relay, the ingest — is the production
   * code path.
   */
  app.use('/api/*', async (c, next) => {
    const deviceKey = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (deviceKey?.startsWith('shogo_sk_')) {
      const resolved = await resolveApiKey(deviceKey)
      if (resolved) {
        c.set('auth', {
          userId: resolved.userId,
          email: null,
          name: null,
          isAuthenticated: true,
          via: 'apiKey',
          workspaceId: resolved.workspaceId,
        })
        await next()
        return
      }
    }
    const userId = c.req.header('x-test-user-id')
    if (userId) {
      c.set('auth', {
        userId,
        email: c.req.header('x-test-email') ?? null,
        name: null,
        isAuthenticated: true,
        via: c.req.header('x-test-via') ?? 'session',
        workspaceId: c.req.header('x-test-workspace-id') ?? null,
      })
    }
    await next()
  })

  app.route('/api', machineRoutes())
  // The Studio's normal read routes: a machine workspace's GETs are served here,
  // from the copied rows, with the usual membership checks.
  app.route('/api', createGeneratedRoutes({ prisma }))
  // Pairing's own routes: `DELETE /instances/:id` is the unpair path, which has
  // to take the copy with it (SHO-185, AC8).
  app.route('/api', instanceRoutes())
  // The workspace companion profile's own route: its GET creates a row on a
  // cloud workspace, which is exactly what must not happen on a machine copy.
  app.route(
    '/api',
    workspaceAgentRoutes({
      authorize: sessionAuthorize(async (c: any) => c.get('auth')?.userId ?? null),
    }),
  )

  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 })
  console.log(`READY ${port}`)
  setInterval(() => {}, 1_000)
}

// ─── Desktop ────────────────────────────────────────────────────────────────

if (role === 'desktop') {
  const cloudUrl = process.env.SHOGO_CLOUD_URL
  const instanceId = process.env.MACHINE_INSTANCE_ID
  if (!cloudUrl || !instanceId) fail('desktop needs SHOGO_CLOUD_URL and MACHINE_INSTANCE_ID')
  const deviceKey = process.env.MACHINE_DEVICE_KEY
  if (!deviceKey) fail('desktop needs MACHINE_DEVICE_KEY')

  const { prisma } = await import('../../lib/prisma')
  const { MachineSyncPusher } = await import('../../lib/machine-sync/pusher')
  const { currentSyncSeq } = await import('../../lib/machine-sync/local-sync')

  const suffix = process.env.MACHINE_SEED_SUFFIX ?? 'a'
  const localUserId = `u-local-${suffix}`
  const localWorkspaceId = `ws-local-${suffix}`
  const projectId = `p-local-${suffix}`

  // What a fresh desktop has: one person, their personal workspace, a project
  // and one chat. The cloud has never seen any of it.
  await prisma.user.create({
    data: { id: localUserId, name: 'Local Person', email: 'local@shogo.local' },
  })
  await prisma.workspace.create({
    // The same name on every desktop — this is the collision the rewrites exist for.
    data: { id: localWorkspaceId, name: 'Samsara', slug: 'samsara', kind: 'personal' },
  })
  await prisma.member.create({
    data: { userId: localUserId, workspaceId: localWorkspaceId, role: 'owner' },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'Local Project', workspaceId: localWorkspaceId },
  })

  const pusher = new MachineSyncPusher({
    prisma,
    getCloudUrl: () => cloudUrl,
    getApiKey: () => deviceKey,
    getInstanceId: async () => instanceId,
    log: (line) => console.log(`[desktop] ${line}`),
  })
  await pusher.start()
  // The first push carries the whole database (backfill); force it now rather
  // than waiting for the interval.
  await pusher.syncNow()

  // A desktop-side write, the way a route would do it: mutate, then report the
  // change-log position. The header is what makes read-your-writes work.
  const app = new Hono()
  app.patch('/api/projects/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const row = await prisma.project.update({
      where: { id: c.req.param('id') },
      data: { name: body.name ?? 'Renamed' },
    })
    await pusher.syncNow()
    c.header('x-shogo-sync-seq', String(await currentSyncSeq()))
    return c.json(row)
  })
  app.post('/api/test/agent-profile', async (c) => {
    const row = await prisma.workspaceAgentProfile.create({
      data: { workspaceId: localWorkspaceId, name: 'Shogo on the desktop', tagline: 'Local' },
    })
    await pusher.syncNow()
    return c.json(row)
  })
  app.get('/health', (c) => c.json({ ok: true, instanceId }))

  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 })
  console.log(`READY ${port}`)
  setInterval(() => {}, 1_000)
}

if (role !== 'cloud' && role !== 'desktop') fail('usage: machine-workspace-pod.ts cloud|desktop <port>')
