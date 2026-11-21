// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 1 — projects in a remote workspace.
 *
 * Projects carry no realtime event of their own, so the "live" half here is the
 * other side of a hosted workspace: a project created from the cloud has to be
 * on the computer (its folder is there, and its agent has to see it) without
 * anyone reloading, and the same in reverse. Reads are checked once, at the end.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  TARGET_NAMES,
  read,
  send,
  startRemoteWorkspace,
  uniq,
  waitFor,
  waitForSync,
  type RemoteWorkspace,
  type Side,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const projectsPath = (side: Side) => `/api/projects?workspaceId=${encodeURIComponent(side.workspaceId)}`

async function projectNames(side: Side): Promise<string[]> {
  const res = await read(side, projectsPath(side))
  return (res.data?.items ?? []).map((p: any) => p.name)
}

describeIfInfra('remote workspace · projects', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('a project created here is listed, opens, and renames', async () => {
        const t = target(name)
        const created = await send(t.api, 'POST', '/api/projects', {
          name: uniq('project'),
          workspaceId: t.workspaceId,
        })
        expect(created.status, JSON.stringify(created.data)).toBe(201)
        const project = created.data?.project ?? created.data?.data ?? created.data
        const projectId = project?.id
        expect(projectId).toBeTruthy()

        // Listed…
        await waitFor('the project in the workspace list', async () =>
          (await projectNames(t)).includes(project.name), 30_000, 500)

        // …opens by id…
        const opened = await read(t, `/api/projects/${encodeURIComponent(projectId)}`)
        expect(opened.status, opened.error).toBeLessThan(300)
        expect(JSON.stringify(opened.data)).toContain(project.name)

        // …and renames.
        const renamed = uniq('renamed')
        const patch = await send(t.api, 'PATCH', `/api/projects/${encodeURIComponent(projectId)}`, { name: renamed })
        expect(patch.status, JSON.stringify(patch.data)).toBeLessThan(300)
        await waitFor('the rename to be stored', async () => (await projectNames(t)).includes(renamed), 30_000, 500)
      }, 120_000)

      test('a project stays inside its workspace', async () => {
        const t = target(name)
        // The cloud workspace's own projects never appear in the machine's, and
        // the other way round — the check that tells the two apart.
        const own = await projectNames(t)
        const other = t.workspaceId === ws.seeds.machine.workspaceId ? ws.seeds.cloud : ws.seeds.machine
        other.projectNames.forEach((name) => expect(own, `${t.name} leaked ${name}`).not.toContain(name))
        t.seed.projectNames.forEach((seeded) => expect(own).toContain(seeded))
      }, 60_000)
    })
  }

  test('hosted · a project created from the cloud reaches the desktop, and the reverse', async () => {
    const t = target('hosted')
    const peer = t.peer!

    const fromCloud = uniq('cloud project')
    const cloud = await send(t.api, 'POST', '/api/projects', { name: fromCloud, workspaceId: t.workspaceId })
    expect(cloud.status, JSON.stringify(cloud.data)).toBe(201)
    await waitForSync(ws.machine, 'the cloud project on the desktop', async () =>
      (await projectNames(peer)).includes(fromCloud), 120_000, 1_000)

    const fromDesktop = uniq('desktop project')
    const desktop = await send(peer.api, 'POST', '/api/projects', { name: fromDesktop, workspaceId: peer.workspaceId })
    expect(desktop.status, JSON.stringify(desktop.data)).toBe(201)
    await waitForSync(ws.machine, 'the desktop project in the cloud', async () =>
      (await projectNames(t)).includes(fromDesktop), 120_000, 1_000)
  }, 240_000)
})
