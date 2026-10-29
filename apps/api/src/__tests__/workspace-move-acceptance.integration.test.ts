// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A move, end to end, against a real database and real files.
 *
 * The unit tests beside the service stub the database and the filesystem, which
 * is why three real blockers shipped past them:
 *
 *   • the records phase streamed a `Workspace` row that `collectWorkspaceSnapshot`
 *     projects only `{ id, name, kind }` from, so the first chunk failed on the
 *     required `slug` and the whole move landed `failed`;
 *   • a resumed job rebuilt its identity from an absent request and streamed a
 *     different row set than the plan showed;
 *   • `__workspace_root__` was only translated in the HTTP routes, so root files
 *     never appeared in the plan and a cloud -> desktop move wrote them into a
 *     stray `<base>/__workspace_root__`.
 *
 * None of those are visible without a real schema, real rows and real paths, so
 * this suite runs the actual migrations into a temp SQLite file and drives
 * `runMove` with `LocalMoveSource`/`LocalMoveTarget` over a temp `workspaces/`
 * directory. It is the companion to QA's HTTP-level test: same service, same
 * code path, no stubs.
 *
 *   bun test apps/api/src/__tests__/workspace-move-acceptance.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from '@shogo/shared-runtime/child-process'
import { setupChannelsTestDb } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../lib/prisma')
const { buildMovePlan, collectMoveRows } = await import('../services/workspace-move/plan')
const { LocalMoveSource, LocalMoveTarget } = await import('../services/workspace-move/link')
const { runMove } = await import('../services/workspace-move/runner')
const { moveJobContext } = await import('../services/workspace-move/index')
const { deriveMoveId } = await import('../services/workspace-move/ids')
const { WORKSPACE_ROOT_ID, moveDirFor } = await import('../services/workspace-move/types').then(
  async (types: any) => ({ ...types, moveDirFor: (await import('../services/workspace-move/files')).moveDirFor }),
)

const db = prisma as any
const BASE = join(dir, 'workspaces')

const OWNER = 'u-sho246-owner'
const ADMIN = 'u-sho246-admin'

let sourceWorkspaceId: string
let projectId: string
let channelId: string
let dmId: string

/** Files a move should carry, relative to the temp `workspaces/` root. */
const PROJECT_FILE = 'src/index.ts'
const PROJECT_BYTES = 'export const hello = 1\n'
const ROOT_FILE = 'CLAUDE.md'
const ROOT_BYTES = '# the workspace root\n'

beforeAll(async () => {
  mkdirSync(BASE, { recursive: true })

  await db.user.createMany({
    data: [
      { id: OWNER, email: 'owner-sho246@example.com', name: 'Owner' },
      { id: ADMIN, email: 'admin-sho246@example.com', name: 'Admin' },
    ],
  })

  const workspace = await db.workspace.create({
    data: { name: 'Sho246 source', slug: `sho246-src-${Date.now().toString(36)}`, kind: 'team', instanceSize: 'small' },
  })
  sourceWorkspaceId = workspace.id

  await db.member.createMany({
    data: [
      { userId: OWNER, workspaceId: sourceWorkspaceId, role: 'owner', isBillingAdmin: true },
      { userId: ADMIN, workspaceId: sourceWorkspaceId, role: 'admin' },
    ],
  })

  // A channel both can see, and a DM only the owner is in. This is the pair the
  // resume bug turned into a divergence: the plan excluded the DM for an admin,
  // and a resumed job with no identity included it.
  const channel = await db.conversation.create({
    data: { workspaceId: sourceWorkspaceId, name: 'general', kind: 'channel', createdById: OWNER },
  })
  channelId = channel.id
  const dm = await db.conversation.create({
    data: { workspaceId: sourceWorkspaceId, name: 'owner-dm', kind: 'dm', createdById: OWNER },
  })
  dmId = dm.id
  await db.conversationMember.createMany({
    data: [
      { conversationId: channelId, userId: OWNER, role: 'member' },
      { conversationId: channelId, userId: ADMIN, role: 'member' },
      { conversationId: dmId, userId: OWNER, role: 'member' },
    ],
  })

  const project = await db.project.create({ data: { workspaceId: sourceWorkspaceId, name: 'site' } })
  projectId = project.id

  // A customised agent identity: the move must carry it over the placeholder
  // `initTargetWorkspace` writes.
  await db.workspaceAgentProfile.create({
    data: { workspaceId: sourceWorkspaceId, name: 'Sho246 Agent', tagline: 'carried over' },
  })

  // Files on disk: one project file and one at the workspace root.
  const projectDir = join(BASE, projectId)
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(join(projectDir, PROJECT_FILE), PROJECT_BYTES)

  const rootDir = join(BASE, '.workspace-roots', sourceWorkspaceId)
  mkdirSync(rootDir, { recursive: true })
  writeFileSync(join(rootDir, ROOT_FILE), ROOT_BYTES)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
})

const planInput = () => ({
  workspaceId: sourceWorkspaceId,
  requesterId: ADMIN,
  isOwner: false,
  selection: { mode: 'all' as const },
  direction: 'desktop_to_cloud' as const,
  targetKind: 'cloud' as const,
  targetName: 'Sho246 target',
  db,
})

describe('a move against a real database', () => {
  test('the plan counts the workspace root, which used to be invisible', async () => {
    const { plan } = await buildMovePlan({ ...planInput(), projectsDirOverride: BASE } as any)
    const root = plan.projects.find((p: any) => p.id === WORKSPACE_ROOT_ID)
    expect({ listed: !!root, bytes: root?.bytes ?? 0 }).toEqual({ listed: true, bytes: ROOT_BYTES.length })
    // And the totals the quota check uses include it.
    const projectBytes = plan.projects.find((p: any) => p.id === projectId)?.bytes ?? 0
    expect(plan.totals.bytes).toBeGreaterThanOrEqual(ROOT_BYTES.length + projectBytes)
  })

  test('the plan excludes a DM the requester is not in', async () => {
    const { rows } = await collectMoveRows({
      workspaceId: sourceWorkspaceId,
      requesterId: ADMIN,
      isOwner: false,
      selection: { mode: 'all' },
      db,
    })
    const ids = (rows.get('Conversation') ?? []).map((row: any) => row.id).sort()
    expect(ids).toEqual([channelId])
    expect(ids).not.toContain(dmId)
  })

  test('the records phase finishes: no partial Workspace row is streamed', async () => {
    const { plan, rows } = await buildMovePlan({ ...planInput(), projectsDirOverride: BASE } as any)

    const source = new LocalMoveSource(db, BASE)
    const target = new LocalMoveTarget(db, BASE)
    const logs: string[] = []
    const result = await runMove({
      moveId: 'move-sho246-1',
      direction: 'desktop_to_cloud',
      source,
      target,
      sourceWorkspaceId,
      targetWorkspaceId: null,
      requesterId: ADMIN,
      isOwner: false,
      ownerUserId: ADMIN,
      instanceSize: plan.target.instanceSize ?? null,
      selection: { mode: 'all' },
      plan,
      progress: {},
      handover: { schedules: [], triggers: [] },
      log: (line: string) => logs.push(line),
    })

    // The whole point: it ran to the end instead of failing on `slug`.
    expect(result.stopped).toBeNull()
    expect(result.targetWorkspaceId).toBeTruthy()

    // Exactly one target workspace, with a real slug — not a duplicate insert of
    // the source row's partial projection.
    const targets = await db.workspace.findMany({
      where: { name: 'Sho246 target' },
      select: { id: true, slug: true, movedToWorkspaceId: true },
    })
    expect(targets.length).toBe(1)
    expect(targets[0].slug).toBeTruthy()
    // The target must not point at itself as "moved".
    expect(targets[0].movedToWorkspaceId).toBeNull()

    // ── the target keeps the source's instance size ──
    // `buildMovePlan` selected only `{id,name,kind}`, so the frozen size was
    // always null and every move landed on the `micro` column default while the
    // plan's own quota check still read the real size.
    const targetRow = await db.workspace.findUnique({
      where: { id: result.targetWorkspaceId },
      select: { instanceSize: true },
    })
    expect(targetRow.instanceSize).toBe('small')
    expect(plan.target.instanceSize).toBe('small')

    // ── the workspace root is walked once, not twice ──
    // It is in `plan.projects` (its bytes count against the quota) *and* added
    // explicitly by the runner, so the second pass only re-hashed what it had
    // just written.
    const rootLines = logs.filter((line) => line.startsWith('(workspace root)'))
    expect(rootLines.length).toBe(1)
    expect(rootLines.some((line) => line.includes('already at the target'))).toBe(false)

    // The rows that were in the plan are there.
    expect(rows.size).toBeGreaterThan(0)

    // ── memberships: one row per user, and the mover is not demoted ──
    // `initTargetWorkspace` writes the mover's own `Member` row, so a plain
    // insert of the source row collided on `members_workspace_scope_key` (P2002
    // on SQLite, silently skipped on Postgres).
    const members = await db.member.findMany({
      where: { workspaceId: result.targetWorkspaceId },
      select: { userId: true, role: true },
      orderBy: { userId: 'asc' },
    })
    expect(members).toEqual([
      { userId: ADMIN, role: 'owner' },
      { userId: OWNER, role: 'owner' },
    ])

    // ── the agent profile: the moved copy wins over the placeholder ──
    const profile = await db.workspaceAgentProfile.findUnique({
      where: { workspaceId: result.targetWorkspaceId },
      select: { name: true, tagline: true },
    })
    expect(profile).toEqual({ name: 'Sho246 Agent', tagline: 'carried over' })

    // ── the workspace root landed in the *target's* root ──
    const landedRoot = join(BASE, '.workspace-roots', result.targetWorkspaceId, ROOT_FILE)
    expect(readFileSync(landedRoot, 'utf8')).toBe(ROOT_BYTES)
    // And nothing was written to the sentinel as if it were a directory.
    expect(existsSync(join(BASE, WORKSPACE_ROOT_ID))).toBe(false)
    expect(moveDirFor({ projectId: WORKSPACE_ROOT_ID, workspaceId: result.targetWorkspaceId, base: BASE })).toBe(
      join(BASE, '.workspace-roots', result.targetWorkspaceId),
    )

    // ── the project's bytes land where its *target* row points ──
    // The records phase gives the target `Project` a derived id, so the files
    // must live at `workspaces/<derivedId>`. Asserting the source id here (as
    // this test first did) passes whether or not the files phase remapped, which
    // is how a move that wrote every file into an orphan directory stayed green.
    const targetProjects = await db.project.findMany({
      where: { workspaceId: result.targetWorkspaceId },
      select: { id: true, name: true },
    })
    expect(targetProjects).toEqual([{ id: deriveMoveId('move-sho246-1', projectId), name: 'site' }])
    expect(readFileSync(join(BASE, targetProjects[0]!.id, PROJECT_FILE), 'utf8')).toBe(PROJECT_BYTES)
    // The source keeps its own copy, untouched.
    expect(readFileSync(join(BASE, projectId, PROJECT_FILE), 'utf8')).toBe(PROJECT_BYTES)
    expect(targetProjects[0]!.id).not.toBe(projectId)
  }, 60_000)

  test('a folder-linked project is re-linked, and the plan says what stays behind', async () => {
    // AC7's second half: the decision (clone vs copy) and the warning that the
    // user must push first, both made from a real checkout.
    const repo = join(dir, 'folder-linked')
    const bare = join(dir, 'folder-linked-remote.git')
    mkdirSync(repo, { recursive: true })
    const git = (cwd: string, args: string[]) => {
      const res = spawnSync('git', ['-c', 'user.email=sho246@example.com', '-c', 'user.name=Sho246', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(res.stderr ?? '')}`)
    }
    git(dir, ['init', '--bare', bare])
    git(dir, ['init', '-b', 'main', repo])
    writeFileSync(join(repo, 'README.md'), '# linked\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'first'])
    git(repo, ['remote', 'add', 'origin', bare])
    git(repo, ['push', '-u', 'origin', 'main'])
    // One commit the remote does not have, and one uncommitted file.
    writeFileSync(join(repo, 'unpushed.txt'), 'x\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'local only'])
    writeFileSync(join(repo, 'scratch.txt'), 'y\n')

    const linked = await db.project.create({ data: { workspaceId: sourceWorkspaceId, name: 'linked site' } })
    await db.projectFolder.create({ data: { projectId: linked.id, path: repo, isPrimary: true } })
    try {
      const { plan } = await buildMovePlan({ ...planInput(), projectsDirOverride: BASE } as any)
      const entry = plan.projects.find((p: any) => p.id === linked.id)
      expect({ mode: entry?.mode, git: entry?.git }).toEqual({
        mode: 'git-relink',
        git: { remote: bare, branch: 'main', dirty: 1, unpushed: 1 },
      })
      // Re-linked, so no files are copied and no bytes are counted.
      expect({ files: entry?.files, bytes: entry?.bytes }).toEqual({ files: 0, bytes: 0 })
      expect(plan.warnings.some((w: string) => /1 uncommitted change\(s\)/.test(w))).toBe(true)
      expect(plan.warnings.some((w: string) => /1 commit\(s\).*not pushed/.test(w))).toBe(true)
    } finally {
      await db.projectFolder.deleteMany({ where: { projectId: linked.id } })
      await db.project.delete({ where: { id: linked.id } })
    }
  })

  test('a folder-linked project with no remote is copied, and the plan says so', async () => {
    const plain = join(dir, 'no-remote-folder')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'a.txt'), 'copied\n')

    const linked = await db.project.create({ data: { workspaceId: sourceWorkspaceId, name: 'plain site' } })
    await db.projectFolder.create({ data: { projectId: linked.id, path: plain, isPrimary: true } })
    try {
      const { plan } = await buildMovePlan({ ...planInput(), projectsDirOverride: BASE } as any)
      const entry = plan.projects.find((p: any) => p.id === linked.id)
      expect({ mode: entry?.mode, git: entry?.git, files: entry?.files }).toEqual({
        mode: 'copy',
        git: undefined,
        files: 1,
      })
      expect(plan.warnings.some((w: string) => /no git remote, so its files are copied/.test(w))).toBe(true)
    } finally {
      await db.projectFolder.deleteMany({ where: { projectId: linked.id } })
      await db.project.delete({ where: { id: linked.id } })
    }
  })

  test('a resumed job carries exactly the rows its plan showed', async () => {
    // The plan an admin was shown.
    const { rows: planRows } = await collectMoveRows({
      workspaceId: sourceWorkspaceId,
      requesterId: ADMIN,
      isOwner: false,
      selection: { mode: 'all' },
      db,
    })
    const planned = (planRows.get('Conversation') ?? []).map((row: any) => row.id).sort()

    // A resume: the row as the database holds it, with no request context at all
    // — which is what `POST /:id/resume` and the crash sweep do.
    const row = {
      requesterId: ADMIN,
      isOwner: false,
      ownerUserId: ADMIN,
      plan: { target: { name: 'Sho246 target', instanceSize: 'small' } },
    }
    const ctx = moveJobContext(row, undefined)
    const { rows: resumedRows } = await collectMoveRows({
      workspaceId: sourceWorkspaceId,
      requesterId: ctx.requesterId,
      isOwner: ctx.isOwner,
      selection: { mode: 'all' },
      db,
    })
    const resumed = (resumedRows.get('Conversation') ?? []).map((row: any) => row.id).sort()

    expect(resumed).toEqual(planned)
    // And specifically: the DM did not sneak in.
    expect(resumed).not.toContain(dmId)
    // The target size is the approved one, not a default.
    expect(ctx.instanceSize).toBe('small')
  })
})
