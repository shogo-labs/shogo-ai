// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E test for the personal-companion goal lifecycle ("training plan"
 * scenario from the plan): create a goal, log a check-in, raise an
 * approval, resolve it, and attach a deliverable — all through the real
 * `workspaceAgentRoutes` router against the local SQLite database.
 *
 * This exercises the SAME router that is mounted twice in production
 * (`server.ts` under `/api` for the web/mobile client, `internal.ts` under
 * `/api/internal` for the agent runtime pod) — see the module doc in
 * `apps/api/src/routes/workspace-agent.ts`. Here we mount it once with a
 * `sessionAuthorize` strategy backed by a real `Member` row, so the test
 * also exercises the real membership-authorization path (not a mock).
 *
 * Run:
 *   SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db \
 *     bun test e2e/personal-shell-goal-flow.test.ts
 *
 * Prerequisites:
 *   `shogo.db` must exist and be migrated to the current schema — run
 *   `bun run db:generate:all` (or `SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db
 *   bunx prisma db push`) once first.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

// Force local mode for SQLite — must run before importing prisma.
process.env.SHOGO_LOCAL_MODE = 'true'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./shogo.db'

const { prisma } = await import('../apps/api/src/lib/prisma')
const { workspaceAgentRoutes, sessionAuthorize } = await import('../apps/api/src/routes/workspace-agent')
const { isApprovalPending } = await import('../apps/api/src/services/workspace-agent.service')
const { markTurnEnded, markTurnStarted } = await import('../apps/api/src/services/chat-turn-state.service')

let workspaceId: string
let teamWorkspaceId: string
let userId: string
let foreignUserId: string
let memberId: string

const app = new Hono()
app.route(
  '/api',
  workspaceAgentRoutes({
    authorize: sessionAuthorize(async (c) => {
      const header = c.req.header('x-test-user-id')
      if (header === undefined) return userId
      return header || null
    }),
  }),
)

function req(path: string, opts: { method?: string; body?: unknown; userId?: string } = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.userId !== undefined ? { 'x-test-user-id': opts.userId } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

describe('personal companion goal flow — training plan', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `e2e-goal-flow-${Date.now()}@test.local`, name: 'Goal Flow Test User', role: 'user' },
    })
    userId = user.id

    const foreignUser = await prisma.user.create({
      data: { email: `e2e-goal-flow-foreign-${Date.now()}@test.local`, name: 'Foreign Test User', role: 'user' },
    })
    foreignUserId = foreignUser.id

    const workspace = await prisma.workspace.create({
      data: { name: 'E2E Personal Goal Flow', slug: `e2e-goal-flow-${Date.now()}`, kind: 'personal' },
    })
    workspaceId = workspace.id

    const member = await prisma.member.create({ data: { userId, workspaceId, role: 'owner' } })
    memberId = member.id

    const teamWorkspace = await prisma.workspace.create({
      data: { name: 'E2E Team Activity', slug: `e2e-team-activity-${Date.now()}`, kind: 'team' },
    })
    teamWorkspaceId = teamWorkspace.id
    await prisma.member.create({ data: { userId, workspaceId: teamWorkspaceId, role: 'owner' } })
  })

  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: teamWorkspaceId } }).catch(() => {})
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
    await prisma.user.delete({ where: { id: foreignUserId } }).catch(() => {})
  })

  test('authorization: unauthenticated and non-member callers are rejected', async () => {
    const unauth = await app.request(req(`/api/workspaces/${workspaceId}/goals`, { userId: '' }))
    expect(unauth.status).toBe(401)

    const foreign = await app.request(req(`/api/workspaces/${workspaceId}/goals`, { userId: foreignUserId }))
    expect(foreign.status).toBe(403)
  })

  test('full lifecycle: create -> check-in -> approval -> resolve -> deliverable', async () => {
    // 1. Create the goal — mirrors the companion creating a training plan
    // after the user says "help me train for a 5K".
    const createRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals`, {
        method: 'POST',
        body: {
          title: 'Run a 5K in 8 weeks',
          why: 'User wants to run their first 5K race pain-free.',
          plan: [
            { title: 'Week 1: base-building runs', done: false },
            { title: 'Week 2: add interval work', done: false },
          ],
          nextCheckInAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    )
    expect(createRes.status).toBe(201)
    const { goal } = (await createRes.json()) as { goal: { id: string; status: string; plan: unknown } }
    expect(goal.status).toBe('active')
    const goalId = goal.id

    // 2. Log a check-in (progress event) — the heartbeat digest reporting
    // week 1 completed.
    const checkInRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}/events`, {
        method: 'POST',
        body: { kind: 'progress', message: 'Completed week 1: three base-building runs logged.' },
      }),
    )
    expect(checkInRes.status).toBe(201)

    // 3. Raise an approval ("Needs your OK") — e.g. before emailing the user
    // a printable plan, per the trust-ramp policy in AGENTS.md.
    const approvalRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}/events`, {
        method: 'POST',
        body: {
          kind: 'approval',
          message: 'OK to email you a printable copy of the week 3 plan?',
          metadata: { action: 'send_email' },
        },
      }),
    )
    expect(approvalRes.status).toBe(201)
    const { event: approvalEvent } = (await approvalRes.json()) as { event: { id: string; kind: string; metadata: unknown } }
    expect(isApprovalPending(approvalEvent as any)).toBe(true)

    // 4. Goal detail should surface the pending approval among its events.
    const detailBeforeRes = await app.request(req(`/api/workspaces/${workspaceId}/goals/${goalId}`))
    expect(detailBeforeRes.status).toBe(200)
    const { goal: detailBefore } = (await detailBeforeRes.json()) as {
      goal: { events: Array<{ id: string; kind: string; metadata: unknown }> }
    }
    const pendingBefore = detailBefore.events.filter((e) => isApprovalPending(e as any))
    expect(pendingBefore.map((e) => e.id)).toContain(approvalEvent.id)

    // 5. Resolve the approval.
    const resolveRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}/events/${approvalEvent.id}/resolve`, {
        method: 'POST',
        body: { decision: 'approved' },
      }),
    )
    expect(resolveRes.status).toBe(200)
    const { event: resolvedEvent } = (await resolveRes.json()) as { event: { metadata: any } }
    expect(resolvedEvent.metadata.decision).toBe('approved')
    expect(isApprovalPending(resolvedEvent as any)).toBe(false)

    // Resolving an already-resolved / non-approval event 404s (no-op by design).
    const doubleResolveRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}/events/${approvalEvent.id}/resolve`, {
        method: 'POST',
        body: { decision: 'declined' },
      }),
    )
    expect(doubleResolveRes.status).toBe(200) // still resolvable — re-stamps the decision.

    // 6. Attach a deliverable: log a `deliverable` event AND update the
    // goal's `deliverables` array (GoalDetailScreen renders both — the
    // timeline entry and the artifact card).
    const deliverableEventRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}/events`, {
        method: 'POST',
        body: { kind: 'deliverable', message: 'Generated a printable week 3 training plan PDF.' },
      }),
    )
    expect(deliverableEventRes.status).toBe(201)

    const attachRes = await app.request(
      req(`/api/workspaces/${workspaceId}/goals/${goalId}`, {
        method: 'PATCH',
        body: {
          deliverables: [
            { type: 'file', title: 'Week 3 Training Plan.pdf', url: 'https://files.example.com/week3.pdf' },
          ],
        },
      }),
    )
    expect(attachRes.status).toBe(200)
    const { goal: patched } = (await attachRes.json()) as { goal: { deliverables: unknown } }
    expect(patched.deliverables).toEqual([
      { type: 'file', title: 'Week 3 Training Plan.pdf', url: 'https://files.example.com/week3.pdf' },
    ])

    // 7. Final goal detail: no pending approvals, deliverable + progress +
    // approval + deliverable-log events all present, activity feed sees it.
    const finalDetailRes = await app.request(req(`/api/workspaces/${workspaceId}/goals/${goalId}`))
    const { goal: final } = (await finalDetailRes.json()) as {
      goal: { events: Array<{ kind: string; metadata: unknown }>; deliverables: unknown[] }
    }
    expect(final.events.length).toBeGreaterThanOrEqual(3)
    expect(final.events.some((e) => isApprovalPending(e as any))).toBe(false)
    expect(final.deliverables).toHaveLength(1)

    const activityRes = await app.request(req(`/api/workspaces/${workspaceId}/activity`))
    expect(activityRes.status).toBe(200)
    const { activity } = (await activityRes.json()) as { activity: unknown[] }
    expect(activity.length).toBeGreaterThan(0)
  })

  test('rejects malformed goal creation and unknown goal ids', async () => {
    const missingTitle = await app.request(req(`/api/workspaces/${workspaceId}/goals`, { method: 'POST', body: {} }))
    expect(missingTitle.status).toBe(400)

    const notFound = await app.request(req(`/api/workspaces/${workspaceId}/goals/does-not-exist`))
    expect(notFound.status).toBe(404)
  })

  test('activity includes active chats in personal and team workspaces and removes stale turns', async () => {
    const session = await prisma.chatSession.create({
      data: {
        inferredName: 'Active chat fixture',
        contextType: 'workspace',
        workspaceId,
      },
    })
    const turnId = await markTurnStarted(session.id, 'e2e-active-turn')

    const activeRes = await app.request(req(`/api/workspaces/${workspaceId}/activity`))
    expect(activeRes.status).toBe(200)
    const activeBody = (await activeRes.json()) as { activity: Array<{ type: string; chatSessionId?: string }> }
    expect(activeBody.activity).toContainEqual(expect.objectContaining({
      type: 'chat_turn',
      chatSessionId: session.id,
    }))

    const chatsRes = await app.request(req(`/api/workspaces/${workspaceId}/active-chats`))
    expect(chatsRes.status).toBe(200)
    expect(await chatsRes.json()).toMatchObject({
      chats: [expect.objectContaining({ chatSessionId: session.id, turnId })],
    })

    await markTurnEnded(session.id, turnId)
    const endedRes = await app.request(req(`/api/workspaces/${workspaceId}/active-chats`))
    expect(await endedRes.json()).toEqual({ chats: [] })

    const teamSession = await prisma.chatSession.create({
      data: {
        inferredName: 'Team active chat fixture',
        contextType: 'workspace',
        workspaceId: teamWorkspaceId,
      },
    })
    const teamTurnId = await markTurnStarted(teamSession.id, 'e2e-team-active-turn')
    const teamChatsRes = await app.request(req(`/api/workspaces/${teamWorkspaceId}/active-chats`))
    expect(teamChatsRes.status).toBe(200)
    expect(await teamChatsRes.json()).toMatchObject({
      chats: [expect.objectContaining({ chatSessionId: teamSession.id, turnId: teamTurnId })],
    })
    const personalAfterTeamRes = await app.request(req(`/api/workspaces/${workspaceId}/active-chats`))
    expect(await personalAfterTeamRes.json()).toEqual({ chats: [] })

    await prisma.chatSession.update({
      where: { id: teamSession.id },
      data: { activeTurnStartedAt: new Date(Date.now() - 31 * 60 * 1000) },
    })
    expect(await (await app.request(req(`/api/workspaces/${teamWorkspaceId}/active-chats`))).json()).toEqual({ chats: [] })
  })
})
