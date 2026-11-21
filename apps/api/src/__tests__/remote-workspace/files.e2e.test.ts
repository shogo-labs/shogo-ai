// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 6 — files in a remote workspace.
 *
 * A workspace's files live with the workspace's compute. Opened from the cloud,
 * a file has to be readable there, and a `share_file` link has to serve its
 * bytes through the proxy connection (never the desktop's own address). A
 * channel attachment uploaded from the cloud has to land where the agent that
 * reads it can see it.
 *
 * The link token is minted here the way the `share_file` tool mints it — the
 * capability HMAC with the deployment's `BETTER_AUTH_SECRET`, which this suite
 * sets for both processes, so the link is a real link and the download really
 * goes through `GET /api/f/:token`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { signSharedFileToken } from '../../lib/shared-file-token'
import {
  TARGET_NAMES,
  read,
  startRemoteWorkspace,
  uniq,
  type RemoteWorkspace,
  type Side,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

/** The secret both processes were started with (see `startRemoteWorkspace`). */
const AUTH_SECRET = process.env.BETTER_AUTH_SECRET!

let ws: RemoteWorkspace
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const headers = (side: Side) => ({ cookie: side.cookie, origin: side.base })

/** Write a text file into a workspace's runtime (the agent's own file tool). */
async function writeFile(side: Side, path: string, content: string): Promise<number> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { method: 'PUT', headers: { ...headers(side), 'content-type': 'application/json' }, body: JSON.stringify({ content }) },
  )
  return res.status
}

async function readFile(side: Side, path: string): Promise<string> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { headers: headers(side) },
  )
  expect(res.status, `read ${path}: ${res.status}`).toBe(200)
  return String((await res.json().catch(() => ({}))).content ?? '')
}

describeIfInfra('remote workspace · files', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('a workspace file reads back here, and its share_file link serves the bytes', async () => {
        const t = target(name)
        const path = `.tmp/sho488-share-${name}.md`
        const content = `# ${uniq('shared')}\n`
        await expect(writeFile(t, path, content)).resolves.toBe(200)
        expect(await readFile(t, path)).toBe(content)

        // The link a `share_file` result carries: a capability token, never a
        // runtime URL (channel rule SHO-80).
        const token = signSharedFileToken({
          workspaceId: t.workspaceId,
          path,
          exp: Math.floor(Date.now() / 1000) + 600,
        })
        const link = `${t.base}/api/f/${token}`
        expect(link).not.toContain('agent-proxy')
        const download = await fetch(link)
        expect(download.status, `link ${link.slice(0, 40)}… refused`).toBe(200)
        expect(await download.text()).toBe(content)
      }, 120_000)
    })
  }

  test('hosted · a file written on the desktop is readable from the cloud, and its link opens from the cloud', async () => {
    const t = target('hosted')
    const peer = t.peer!
    const path = '.tmp/sho488-desktop-only.txt'
    const content = `desktop only ${uniq('canary')}`

    // Written through the desktop's own API: the bytes are on its disk.
    await expect(writeFile(peer, path, content)).resolves.toBe(200)
    // Read from the cloud, through the proxy connection.
    expect(await readFile(t, path)).toBe(content)

    const token = signSharedFileToken({
      workspaceId: t.workspaceId,
      path,
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    const download = await fetch(`${t.base}/api/f/${token}`)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe(content)
  }, 180_000)
})
