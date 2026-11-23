// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 11 — who may reach a remote workspace.
 *
 * Opening a workspace through the cloud must not widen it: an account that does
 * not own the computer gets nothing from it — no machine row, no workspace row,
 * no runtime file, no surface content, no write — and the same is true of a
 * plain cloud workspace. The negative control at the end is the other half: the
 * checks can tell two workspaces apart, so passing the "no leak" half means
 * something.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SURFACES } from '../helpers/machine-vm-surfaces'
import {
  channelMessages,
  read,
  send,
  startRemoteWorkspace,
  strangerSession,
  uniq,
  type RemoteWorkspace,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let stranger: { cookie: string; api: any; side: { base: string; cookie: string; workspaceId: string } }

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  const session = await strangerSession(ws.cloud)
  stranger = {
    ...session,
    side: { base: ws.cloud.base, cookie: session.cookie, workspaceId: ws.target('hosted').workspaceId },
  }
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const target = (name: 'cloud' | 'hosted'): Target => ws.target(name)

describeIfInfra('remote workspace · access', () => {
  test('a stranger gets nothing from the hosted workspace, through the cloud', async () => {
    const t = target('hosted')

    const machineRow = await read(stranger.side, `/api/machines/${encodeURIComponent(ws.machine.machineId)}`)
    expect([401, 403, 404]).toContain(machineRow.status)

    const workspaceRow = await read(stranger.side, `/api/workspaces/${encodeURIComponent(t.workspaceId)}`)
    expect([401, 403, 404]).toContain(workspaceRow.status)

    const runtime = await fetch(
      `${stranger.side.base}/api/workspaces/${encodeURIComponent(t.workspaceId)}/agent-proxy/agent/workspace/files/AGENTS.md`,
      { headers: { cookie: stranger.cookie, origin: stranger.side.base } },
    )
    expect([401, 403, 404]).toContain(runtime.status)

    // Every surface a screen reads, asked as the stranger: no seeded content.
    for (const surface of SURFACES) {
      const res = await read(stranger.side, surface.path(t.seed))
      expect(
        JSON.stringify(res.data ?? '').includes(t.seed.tag),
        `${surface.name} (${res.status}) leaked: ${JSON.stringify(res.data).slice(0, 200)}`,
      ).toBe(false)
    }

    // And no write.
    const text = uniq('stranger write')
    const write = await send(stranger.api, 'POST', `/api/conversations/${encodeURIComponent(t.seed.channelId)}/messages`, { text })
    expect(write.status).toBeGreaterThanOrEqual(400)
    expect((await channelMessages(t, t.seed.channelId)).map((m) => m.text)).not.toContain(text)
  }, 120_000)

  test('a stranger gets nothing from a cloud workspace either', async () => {
    const t = target('cloud')
    const listed = await read(stranger.side, `/api/workspaces/${encodeURIComponent(t.workspaceId)}`)
    expect([401, 403, 404]).toContain(listed.status)
    for (const surface of SURFACES) {
      const res = await read(stranger.side, surface.path(t.seed))
      expect(
        JSON.stringify(res.data ?? '').includes(t.seed.tag),
        `${surface.name} (${res.status}) leaked: ${JSON.stringify(res.data).slice(0, 200)}`,
      ).toBe(false)
    }
  }, 120_000)

  test('negative control: the surfaces tell one workspace from the other', async () => {
    const cloud = target('cloud')
    const hosted = target('hosted')
    let distinguished = 0
    for (const surface of SURFACES) {
      const res = await read(hosted, surface.path(hosted.seed))
      let passForCloud = true
      try {
        surface.shows(surface.view(res.data, hosted.seed), cloud.seed)
      } catch {
        passForCloud = false
      }
      if (!passForCloud) distinguished++
    }
    // Every surface with seeded content except the agent profile (a name).
    expect(distinguished).toBe(SURFACES.length - 1)
  }, 120_000)
})
