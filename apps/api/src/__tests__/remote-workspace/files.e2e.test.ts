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
  startRemoteWorkspace,
  uniq,
  waitForSync,
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

/**
 * Write a text file into a workspace's runtime (the agent's own file tool). A
 * refused write prints the runtime's answer and both processes' logs: a 500
 * here is a runtime error, and without them CI only ever said "Received: 500"
 * (SHO-502).
 */
async function writeFile(side: Side, path: string, content: string): Promise<number> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { method: 'PUT', headers: { ...headers(side), 'content-type': 'application/json' }, body: JSON.stringify({ content }) },
  )
  if (res.status !== 200) {
    const body = await res.text().catch(() => '')
    console.error(`write ${path} via ${side.base} → ${res.status}: ${body.slice(0, 2000)}\n${ws.logs()}`)
  }
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

  // SHO-494. Two bugs stood between the upload and a stored file, both measured
  // on this stack: the API's own origin was not in the CSRF allow-list, so a
  // multipart POST from the app itself answered 403 "Forbidden" before any bytes
  // were read; and with no artifact bucket the cloud then answered 500, so the
  // harness now runs a real (in-process) S3. The requirement: the bytes are
  // stored, and the agent — whose API is the computer's — can read them.
  test(
    'hosted · a channel attachment uploaded from the cloud is stored for the agent',
    async () => {
      const t = target('hosted')
      const peer = t.peer!
      const content = `attachment ${uniq('canary')}`
      const form = new FormData()
      form.set('file', new File([content], 'sho488-canary.txt', { type: 'text/plain' }))
      const res = await fetch(
        `${t.base}/api/conversations/${encodeURIComponent(t.seed.channelId)}/attachments`,
        { method: 'POST', headers: { cookie: t.cookie, origin: t.base }, body: form },
      )
      const text = await res.text().catch(() => '')
      expect(res.status, `upload answered ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300)
      const stored = text ? JSON.parse(text) : {}
      const attachmentId = stored?.attachment?.id ?? stored?.id ?? stored?.file?.id
      expect(attachmentId, `no stored attachment in ${text.slice(0, 300)}`).toBeTruthy()
      const url = String(stored?.attachment?.url ?? '')

      // The file is really there: the cloud serves its bytes at the URL the
      // message will carry.
      expect(url, `the attachment has a URL: ${text.slice(0, 300)}`).toContain('/api/conversation-files/')
      const fromCloud = await fetch(`${t.base}${url}`)
      expect(fromCloud.status, `cloud read answered ${fromCloud.status}`).toBe(200)
      expect(await fromCloud.text()).toBe(content)

      // …and the computer the agent runs on can read it. Its row arrives with
      // the sync; the bytes stay in the cloud's store, so the desktop's own API
      // fetches them rather than answering 404 from its disk. Probed on the
      // attachment's own URL, not `/meta`: an upload that no message carries yet
      // has no `messageId`, and `/meta` hides exactly those rows (a file from a
      // deleted message) — on the cloud too, so it would prove nothing about
      // the sync.
      await waitForSync(ws.machine, 'the attachment row on the desktop', async () => {
        const probe = await fetch(`${peer.base}${url}`)
        return probe.status === 200
      }, 60_000, 1_000)
      const fromDesktop = await fetch(`${peer.base}${url}`, {
        headers: { cookie: peer.cookie, origin: peer.base },
      })
      expect(fromDesktop.status, `desktop read answered ${fromDesktop.status}`).toBe(200)
      expect(await fromDesktop.text()).toBe(content)
    },
    180_000,
  )
})
