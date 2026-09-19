// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E test for hidden-project delegation ("habit tracker" scenario from the
 * plan): a personal-companion agent creates a delegate project to build
 * something (e.g. a habit-tracker mini-app) via `project_create` /
 * `project_call`. That delegate project must:
 *
 *   1. Be created `hidden: true` automatically for `kind: 'personal'`
 *      workspaces (`createProjectInWorkspace` in
 *      `apps/api/src/services/project-lifecycle.service.ts`), and be
 *      creatable `hidden: true` explicitly in `kind: 'team'` workspaces too
 *      (companion features are universal — see Phase C's module doc in
 *      `apps/api/src/routes/internal.ts`).
 *   2. Never appear in user-facing lists: history search
 *      (`searchWorkspaceHistory`) and the workspace `@`-reference summary
 *      (`enrichWorkspaceReferences`).
 *   3. Still resolve by id — the runtime's `project_call` tool looks
 *      projects up directly by id, with no `hidden` filter, so the agent
 *      can keep working the delegate project after creating it.
 *
 * A sibling non-hidden team project is created alongside as a control, so
 * this test also stands in for the "hidden filtering doesn't regress
 * ordinary team projects" pass called out in the plan.
 *
 * Run:
 *   SHOGO_LOCAL_MODE=true DATABASE_URL=file:./shogo.db \
 *     bun test e2e/personal-shell-hidden-project.test.ts
 *
 * Prerequisites: same as personal-shell-goal-flow.test.ts — `shogo.db` must
 * exist and be migrated (`bunx prisma db push` with `schema.local.prisma`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

process.env.SHOGO_LOCAL_MODE = 'true'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./shogo.db'

const { prisma } = await import('../apps/api/src/lib/prisma')
const { createProjectInWorkspace } = await import('../apps/api/src/services/project-lifecycle.service')
const { searchWorkspaceHistory } = await import('../apps/api/src/lib/history-search')
const { enrichWorkspaceReferences } = await import('../apps/api/src/lib/chat-references')

const stamp = Date.now()
const HIDDEN_TERM = `zzzhiddendelegateterm${stamp}`
const VISIBLE_TERM = `zzzvisibleprojectterm${stamp}`
const EXPLICIT_HIDDEN_TERM = `zzzexplicithiddenterm${stamp}`

let personalWorkspaceId: string
let personalUserId: string
let teamWorkspaceId: string
let teamUserId: string

let personalHiddenProjectId: string
let teamVisibleProjectId: string
let teamExplicitHiddenProjectId: string

async function chatSessionWithMessage(opts: {
  contextType: 'project'
  contextId: string
  workspaceId?: string
  content: string
}) {
  const session = await prisma.chatSession.create({
    data: {
      inferredName: 'E2E fixture session',
      contextType: opts.contextType,
      contextId: opts.contextId,
    },
  })
  await prisma.chatMessage.create({
    data: { sessionId: session.id, role: 'user', content: opts.content },
  })
  return session.id
}

describe('personal companion hidden-project delegation', () => {
  beforeAll(async () => {
    const personalUser = await prisma.user.create({
      data: { email: `e2e-hidden-project-personal-${stamp}@test.local`, name: 'Personal Owner', role: 'user' },
    })
    personalUserId = personalUser.id
    const personalWorkspace = await prisma.workspace.create({
      data: { name: 'E2E Hidden Project — Personal', slug: `e2e-hidden-personal-${stamp}`, kind: 'personal' },
    })
    personalWorkspaceId = personalWorkspace.id
    await prisma.member.create({ data: { userId: personalUserId, workspaceId: personalWorkspaceId, role: 'owner' } })

    const teamUser = await prisma.user.create({
      data: { email: `e2e-hidden-project-team-${stamp}@test.local`, name: 'Team Owner', role: 'user' },
    })
    teamUserId = teamUser.id
    const teamWorkspace = await prisma.workspace.create({
      data: { name: 'E2E Hidden Project — Team', slug: `e2e-hidden-team-${stamp}`, kind: 'team' },
    })
    teamWorkspaceId = teamWorkspace.id
    await prisma.member.create({ data: { userId: teamUserId, workspaceId: teamWorkspaceId, role: 'owner' } })

    // 1. Personal-workspace delegate — no `hidden` flag passed; the service
    // must force it to true because the workspace kind is 'personal'.
    const personalHidden = await createProjectInWorkspace({
      workspaceId: personalWorkspaceId,
      actingUserId: personalUserId,
      name: 'Habit Tracker Builder Delegate',
    })
    personalHiddenProjectId = personalHidden.id

    // 2. Ordinary team project — the control. Must default to visible.
    const teamVisible = await createProjectInWorkspace({
      workspaceId: teamWorkspaceId,
      actingUserId: teamUserId,
      name: 'Marketing Site',
    })
    teamVisibleProjectId = teamVisible.id

    // 3. Team workspace can also opt a project into hidden explicitly
    // (companion features aren't personal-only).
    const teamExplicitHidden = await createProjectInWorkspace({
      workspaceId: teamWorkspaceId,
      actingUserId: teamUserId,
      name: 'Team Builder Delegate',
      hidden: true,
    })
    teamExplicitHiddenProjectId = teamExplicitHidden.id

    await chatSessionWithMessage({
      contextType: 'project',
      contextId: personalHiddenProjectId,
      content: `Building the habit tracker: ${HIDDEN_TERM}`,
    })
    await chatSessionWithMessage({
      contextType: 'project',
      contextId: teamVisibleProjectId,
      content: `Marketing copy draft: ${VISIBLE_TERM}`,
    })
    await chatSessionWithMessage({
      contextType: 'project',
      contextId: teamExplicitHiddenProjectId,
      content: `Delegate build log: ${EXPLICIT_HIDDEN_TERM}`,
    })
  })

  afterAll(async () => {
    await prisma.workspace.delete({ where: { id: personalWorkspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: teamWorkspaceId } }).catch(() => {})
    await prisma.user.delete({ where: { id: personalUserId } }).catch(() => {})
    await prisma.user.delete({ where: { id: teamUserId } }).catch(() => {})
  })

  test('personal workspaces force hidden: true on every created project', async () => {
    const project = await prisma.project.findUnique({ where: { id: personalHiddenProjectId }, select: { hidden: true } })
    expect(project?.hidden).toBe(true)
  })

  test('team workspaces default to visible but can opt a project into hidden', async () => {
    const visible = await prisma.project.findUnique({ where: { id: teamVisibleProjectId }, select: { hidden: true } })
    expect(visible?.hidden).toBe(false)
    const hidden = await prisma.project.findUnique({ where: { id: teamExplicitHiddenProjectId }, select: { hidden: true } })
    expect(hidden?.hidden).toBe(true)
  })

  test('history search excludes hidden-project chats but finds visible-project chats', async () => {
    const hiddenSearch = await searchWorkspaceHistory({ workspaceId: personalWorkspaceId, query: HIDDEN_TERM, kind: 'chat' })
    expect(hiddenSearch.results).toHaveLength(0)

    const visibleSearch = await searchWorkspaceHistory({ workspaceId: teamWorkspaceId, query: VISIBLE_TERM, kind: 'chat' })
    expect(visibleSearch.results.length).toBeGreaterThanOrEqual(1)
    expect(visibleSearch.results[0]?.projectId).toBe(teamVisibleProjectId)

    const explicitHiddenSearch = await searchWorkspaceHistory({ workspaceId: teamWorkspaceId, query: EXPLICIT_HIDDEN_TERM, kind: 'chat' })
    expect(explicitHiddenSearch.results).toHaveLength(0)
  })

  test('workspace @-reference summaries list visible projects but never hidden ones', async () => {
    const personalBody: any = { references: [{ type: 'workspace', id: personalWorkspaceId }] }
    await enrichWorkspaceReferences(personalBody, personalUserId)
    expect(personalBody.references[0].summary).not.toContain('Habit Tracker Builder Delegate')

    const teamBody: any = { references: [{ type: 'workspace', id: teamWorkspaceId }] }
    await enrichWorkspaceReferences(teamBody, teamUserId)
    expect(teamBody.references[0].summary).toContain('Marketing Site')
    expect(teamBody.references[0].summary).not.toContain('Team Builder Delegate')
  })

  test('hidden projects still resolve directly by id (runtime project_call path)', async () => {
    const personalDelegate = await prisma.project.findUnique({ where: { id: personalHiddenProjectId } })
    expect(personalDelegate).not.toBeNull()
    expect(personalDelegate?.name).toBe('Habit Tracker Builder Delegate')

    const teamDelegate = await prisma.project.findUnique({ where: { id: teamExplicitHiddenProjectId } })
    expect(teamDelegate).not.toBeNull()
    expect(teamDelegate?.name).toBe('Team Builder Delegate')
  })
})
