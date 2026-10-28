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
    // Same rule as the real authMiddleware: only `Authorization: Bearer` is read.
    // Accepting `x-api-key` here is how PERF-9 (every real push refused) passed.
    const authHeader = c.req.header('authorization')
    const deviceKey = authHeader?.startsWith('Bearer shogo_sk_') ? authHeader.slice(7) : undefined
    if (deviceKey) {
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

  // The guard that turns "no access to this workspace" into "the copy is not
  // here yet" (SHO-241) is registered *before* the routes, the way `server.ts`
  // does it: it is a post-response hook, so the happy path pays nothing.
  const { machineCopyPendingGuard } = await import('../../lib/machine-copy-pending')
  app.use('/api/*', machineCopyPendingGuard())

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

  // A restart reuses the database it left behind (`MACHINE_DB_URL` is the same
  // SQLite file), which is what makes the recovery cases real: the local sync
  // state, the change log and the rows are the ones the previous process wrote.
  const restarted = process.env.MACHINE_RESTART === '1'
  const seedRows = process.env.MACHINE_SKIP_SEED !== '1'
  const orphaned = process.env.MACHINE_ORPHANED_STATE === '1'
  const pendingChanges = Number(process.env.MACHINE_PENDING_CHANGES ?? 0)

  if (seedRows) {
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
  }

  /**
   * The shape a desktop is left in when its first snapshot was refused: an epoch
   * was minted, `lastIngestAt` is null, and the change log has been filling up
   * ever since. Before SHO-241 this looked "already initialised" on the next
   * launch, so it sent deltas the cloud had no copy to apply — forever.
   */
  if (orphaned) {
    await prisma.machineSyncState.create({
      data: {
        instanceId,
        epoch: `epoch-stranded-${suffix}`,
        cursor: 0,
        enabled: true,
        lastIngestAt: null,
      },
    })
    if (pendingChanges > 0) {
      await prisma.machineSyncChange.createMany({
        data: Array.from({ length: pendingChanges }, (_unused, index) => ({
          model: 'ChatMessage',
          recordId: `m-pending-${index}`,
          op: 'upsert',
        })),
      })
    }
  }

  // The desktop's `x-api-key` header was refused before PERF-9, so a real
  // desktop's first snapshot failed at the door. `MACHINE_FIRST_PUSH_REFUSED`
  // reproduces that on the wire: the first pushes get the 401 the old cloud gave.
  const refusals = Number(process.env.MACHINE_FIRST_PUSH_REFUSED ?? 0)
  let refused = 0
  const fetchImpl: typeof fetch | undefined =
    refusals > 0
      ? ((async (input: any, init: any) => {
          if (refused < refusals) {
            refused++
            console.log(`[desktop] refusing push ${refused}/${refusals} (401)`)
            return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), {
              status: 401,
            })
          }
          return fetch(input, init)
        }) as unknown as typeof fetch)
      : undefined

  const pusher = new MachineSyncPusher({
    prisma,
    getCloudUrl: () => cloudUrl,
    getApiKey: () => deviceKey,
    getInstanceId: async () => instanceId,
    log: (line) => console.log(`[desktop] ${line}`),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  await pusher.start()
  // The first push carries the whole database (backfill); force it now rather
  // than waiting for the interval.
  await pusher.syncNow()
  console.log(
    `[desktop] sync status ${JSON.stringify({ restarted, orphaned, pendingChanges, ...pusher.status })}`,
  )

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
