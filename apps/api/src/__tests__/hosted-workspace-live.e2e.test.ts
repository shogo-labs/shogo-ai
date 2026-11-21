// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-486 — a hosted workspace, seen from the cloud, must behave like a
 * workspace that runs on the cloud.
 *
 * A hosted workspace (SHO-285) has its compute on a paired desktop, so
 * everything the desktop writes reaches Postgres through machine sync and
 * nothing on that path used to tell the clients connected to the cloud. The
 * person's report was plain: "when I send a message in a channel of a remote
 * workspace I do not see the reply unless I refresh. It works fine for a normal
 * workspace or local workspace."
 *
 * So every scenario below runs three times — a workspace on cloud compute, a
 * workspace on the desktop seen locally, and that same workspace seen from the
 * cloud — and the hosted column is the one that used to fail:
 *
 *   AC1  a channel message posted on the desktop reaches the cloud's `/rt`
 *        socket without a refetch (and the same event exists in cloud and local
 *        workspaces, which is why the same assertion runs on all three)
 *   AC2  a phone-posted message reaches a desktop that is watching the hosted
 *        workspace
 *   AC3  the cloud's `/turn` probe reports a turn running on the desktop
 *   AC4  rejoining that turn's `/stream` from the cloud streams (no 502 at 30 s)
 *   AC5  a message sent mid-turn is queued, runs after the turn, and survives a
 *        refresh
 *   AC6  a `share_file` link minted for a hosted workspace resolves from the
 *        cloud and serves a file that only exists on the desktop
 *
 * Real processes on both sides (the cloud API on Postgres + Redis, a paired
 * desktop in local mode); the only stand-in is the model, a scripted server.
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`; skipped
 * without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeLlmServer, marker, token } from '../../../desktop/e2e/streaming/fake-llm-server'
import {
  httpClient,
  pairMachine,
  read,
  REPO_ROOT,
  startCloud,
  waitFor,
  type CloudProcess,
  type PairedMachine,
} from './helpers/machine-vm-harness'
import { seedWorkspace, type Seeded } from './helpers/machine-vm-surfaces'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let cloud: CloudProcess
let machine: PairedMachine
let llm: FakeLlmServer
let hosted: Seeded
let cloudy: Seeded

const clients = () => ({
  cloud: httpClient(cloud.base, machine.cookies),
  desktop: httpClient(machine.localApiBase, machine.localCookies),
})

async function send(client: ReturnType<typeof httpClient>, method: string, path: string, body?: unknown) {
  try {
    const res: any = await client.request(path, { method, body: body as any })
    return { status: (res.status ?? 200) as number, data: res.data }
  } catch (err: any) {
    return { status: (err?.status ?? 0) as number, data: err?.details ?? err?.message ?? null }
  }
}

function logs(): string {
  return `--- cloud ---\n${cloud?.log.join('').slice(-4000)}\n--- desktop ---\n${machine?.log.join('').slice(-4000)}`
}

async function syncStatus(): Promise<string> {
  try {
    const res = await read(clients().desktop, '/api/local/instance-info')
    return JSON.stringify(res.data?.sync ?? `no sync status (HTTP ${res.status})`, null, 2)
  } catch (err) {
    return `unavailable: ${(err as Error)?.message ?? err}`
  }
}

/** `waitFor` that says why it timed out instead of just `last: false`. */
async function waitForSync<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  try {
    return await waitFor(what, fn, timeoutMs, intervalMs)
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- desktop sync ---\n${await syncStatus()}\n${logs()}`)
  }
}

/**
 * A workspace's realtime feed, read the way a client reads it: the SSE fallback
 * of `/rt` (`GET /workspaces/:id/conversations/events`), which subscribes to the
 * same conversation bus the socket does. An event arriving here without a
 * refetch is exactly "the reply appeared".
 */
async function openFeed(base: string, cookie: string, workspaceId: string) {
  const controller = new AbortController()
  const events: any[] = []
  const response = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/conversations/events`, {
    headers: { cookie, accept: 'text/event-stream', origin: base },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) {
    throw new Error(`event feed failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`)
  }
  void (async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split = buffer.indexOf('\n\n')
        while (split >= 0) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              events.push(JSON.parse(line.slice(5).trim()))
            } catch {
              /* keepalive or a partial frame */
            }
          }
          split = buffer.indexOf('\n\n')
        }
      }
    } catch {
      /* aborted at the end of a test */
    }
  })()

  await waitFor('the event feed to open', async () => events.some((event) => event.type === 'ready'), 20_000, 100)
  return {
    events,
    /** Events of one type for one conversation, newest last. */
    of: (type: string, conversationId?: string) =>
      events.filter((event) => event.type === type && (!conversationId || event.conversationId === conversationId)),
    /** Wait for a `message.created` whose text contains `text`. */
    waitForText: (text: string, timeoutMs = 20_000) =>
      waitForSync(
        `a live message.created carrying "${text}"`,
        async () =>
          events.some(
            (event) => event.type === 'message.created' && String(event.message?.text ?? '').includes(text),
          ),
        timeoutMs,
        250,
      ),
    close: () => controller.abort(),
  }
}

async function warmHostTunnel(): Promise<void> {
  const { cloud: c } = clients()
  const path = `/api/instances/${encodeURIComponent(machine.machineId)}`
  await send(c, 'POST', `${path}/request-connect`)
  await waitForSync(
    'the desktop tunnel',
    async () => {
      const res = await read(c, path)
      return res.status < 300 && res.data?.status === 'online'
    },
    120_000,
    2_000,
  )
}

/** POST a workspace chat turn from the cloud, leaving the stream open. */
async function startCloudTurn(sessionId: string, text: string, tag: string) {
  const controller = new AbortController()
  const response = await fetch(`${cloud.base}/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/chat`, {
    method: 'POST',
    headers: {
      cookie: machine.cookies,
      'content-type': 'application/json',
      origin: cloud.base,
      'X-Chat-Session-Id': sessionId,
    },
    body: JSON.stringify({
      id: sessionId,
      chatSessionId: sessionId,
      messages: [{ id: `u-${tag}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }),
    signal: controller.signal,
  })
  return { response, stop: () => controller.abort() }
}

const turnPath = (sessionId: string) =>
  `/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/chat/${encodeURIComponent(sessionId)}/turn`
const streamPath = (sessionId: string, query = '') =>
  `/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/chat/${encodeURIComponent(sessionId)}/stream${query}`

/** GET a stream from the cloud, recording how long until headers, then bytes. */
async function readStream(base: string, cookie: string, path: string, opts: { untilMs: number }) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.untilMs)
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { cookie, accept: 'text/event-stream', origin: base },
      signal: controller.signal,
    })
    const headersAt = Date.now() - startedAt
    let body = ''
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const readUntil = Date.now() + Math.max(0, opts.untilMs - headersAt)
      while (Date.now() < readUntil) {
        const { value, done } = await reader.read()
        if (done) break
        body += decoder.decode(value, { stream: true })
        if (body.includes('data:')) break
      }
      void reader.cancel().catch(() => {})
    }
    return { status: response.status, headersAt, firstByteAt: Date.now() - startedAt, body }
  } catch (err: any) {
    return { status: 0, headersAt: Date.now() - startedAt, firstByteAt: null, body: '', error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  llm = new FakeLlmServer()
  await llm.start(0)
  cloud = await startCloud({ pgServerUrl: PG_URL, redisUrl: REDIS_URL })
  machine = await pairMachine(cloud.base, {
    instanceName: `vm-${Math.random().toString(36).slice(2, 6)}`,
    repoRoot: REPO_ROOT,
    dir: mkdtempSync(join(tmpdir(), 'sho486-desktop-')),
    env: {
      AI_MODE: 'local-llm',
      LOCAL_LLM_BASE_URL: llm.url,
      LOCAL_LLM_BASIC_MODEL: 'fake-stream',
      LOCAL_LLM_ADVANCED_MODEL: 'fake-stream',
    },
  }).catch(async (err) => {
    console.log(cloud.log.join('').slice(-4000))
    throw err
  })
  const { cloud: c, desktop } = clients()
  hosted = await seedWorkspace(desktop, machine.machineWorkspaceId, 'Hosty')
  cloudy = await seedWorkspace(c, machine.cloudWorkspaceId, 'Cloudy')
  await warmHostTunnel()
}, 300_000)

afterAll(async () => {
  await machine?.stop()
  await cloud?.stop()
  await llm?.stop()
})

describeIfInfra('a hosted workspace seen from the cloud (SHO-486)', () => {
  test('AC1 · a channel message written on the desktop appears on the cloud feed, live', async () => {
    const feed = await openFeed(cloud.base, machine.cookies, machine.machineWorkspaceId)
    try {
      const text = `desktop says ${Date.now()}`
      const written = await send(
        clients().desktop,
        'POST',
        `/api/conversations/${encodeURIComponent(hosted.channelId)}/messages`,
        { text },
      )
      expect(written.status, JSON.stringify(written.data)).toBeLessThan(300)

      // No refetch, no poll: the socket has to carry it, the way it does for a
      // message posted on the cloud.
      await feed.waitForText(text, 30_000)
      const created = feed.of('message.created', hosted.channelId)
      expect(created.some((event) => String(event.message?.text ?? '').includes(text))).toBe(true)
    } finally {
      feed.close()
    }
  }, 180_000)

  test('AC1b · the same assertion holds for a cloud workspace and for a local one', async () => {
    // Cloud compute: the control that proves the feed reader is right.
    const cloudFeed = await openFeed(cloud.base, machine.cookies, machine.cloudWorkspaceId)
    const localFeed = await openFeed(machine.localApiBase, machine.localCookies, machine.machineWorkspaceId)
    try {
      const fromCloud = `posted on the cloud ${Date.now()}`
      const cloudPost = await send(
        clients().cloud,
        'POST',
        `/api/conversations/${encodeURIComponent(cloudy.channelId)}/messages`,
        { text: fromCloud },
      )
      expect(cloudPost.status, JSON.stringify(cloudPost.data)).toBeLessThan(300)
      await cloudFeed.waitForText(fromCloud, 20_000)

      // Local compute, viewed locally: `postMessage` publishes in-process.
      const fromDesktop = `posted on the desktop ${Date.now()}`
      const desktopPost = await send(
        clients().desktop,
        'POST',
        `/api/conversations/${encodeURIComponent(hosted.channelId)}/messages`,
        { text: fromDesktop },
      )
      expect(desktopPost.status, JSON.stringify(desktopPost.data)).toBeLessThan(300)
      await localFeed.waitForText(fromDesktop, 20_000)
    } finally {
      cloudFeed.close()
      localFeed.close()
    }
  }, 180_000)

  test('AC2 · a message posted from the cloud appears live on the desktop watching that workspace', async () => {
    const feed = await openFeed(machine.localApiBase, machine.localCookies, machine.machineWorkspaceId)
    try {
      const text = `phone says ${Date.now()}`
      const posted = await send(
        clients().cloud,
        'POST',
        `/api/conversations/${encodeURIComponent(hosted.channelId)}/messages`,
        { text },
      )
      expect(posted.status, JSON.stringify(posted.data)).toBeLessThan(300)
      // The cloud wrote the row; the desktop only hears about it through the
      // puller, and used to hear nothing at all (SHO-486, cloud → desktop).
      await feed.waitForText(text, 30_000)
    } finally {
      feed.close()
    }
  }, 180_000)

  test('AC3 + AC4 · the cloud sees a desktop-run turn and can rejoin its stream', async () => {
    const { cloud: c } = clients()
    const sessionId = hosted.workspaceChatId
    const tag = `live${Date.now() % 100_000}`
    // A turn that starts and then waits for us: `hold` emits nothing until
    // `release`, so everything below is measured against a genuinely live turn.
    const turn = await startCloudTurn(sessionId, marker('hold', tag, 6, { ms: 20 }), tag)
    try {
      expect(turn.response.status, `cloud send: ${turn.response.status}`).toBe(200)

      // AC3 — the probe names the turn the desktop is running.
      const snapshot = await waitForSync(
        'the cloud /turn probe to report the desktop turn as active',
        async () => {
          const res = await read(c, turnPath(sessionId))
          return res.status === 200 && res.data?.status === 'active' ? res.data : null
        },
        60_000,
        500,
      )
      expect(snapshot.status).toBe('active')
      expect(typeof snapshot.turnId).toBe('string')

      // AC3 (activity) — the panel that shows a running turn is poll-driven
      // (`GET /workspaces/:id/active-chats` and `/activity` every 5 s, see
      // `apps/mobile/lib/workspace-activity.ts`), so what it needs is the
      // desktop's `ChatSession.activeTurn*` in Postgres inside that budget —
      // not a new client event. This is Russell's "the activity doesn't show
      // properly either", measured on the surface the panel actually reads.
      const activityPath = `/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/activity`
      const listed = await waitForSync(
        'the cloud activity feed to show the desktop turn',
        async () => {
          const res = await read(c, activityPath)
          const items = Array.isArray(res.data?.activity) ? res.data.activity : []
          return items.find((item: any) => item?.type === 'chat_turn' && item.chatSessionId === sessionId) ?? null
        },
        5_000,
        250,
      )
      // Not `snapshot.turnId`: that is the runtime's stream-buffer turn, a
      // different id from the `ChatSession.activeTurnId` the panel reads. What
      // the panel needs is the session's row, which it can match to the reply.
      expect(typeof listed.turnId).toBe('string')
      expect(listed.turnId).not.toBe('')

      // AC4 — rejoining streams: headers land at once instead of the tunnel
      // holding the request for its 30 s buffered timeout and answering 502.
      const resumed = await readStream(cloud.base, machine.cookies, streamPath(sessionId, '?fromSeq=0'), {
        untilMs: 25_000,
      })
      expect(resumed.error, `resume failed: ${resumed.error}\n${logs()}`).toBeUndefined()
      expect(resumed.status, `resume status ${resumed.status} after ${resumed.headersAt} ms\n${logs()}`).toBe(200)
      expect(resumed.headersAt).toBeLessThan(5_000)

      // …and the tokens themselves arrive once the model is let go.
      llm.release(tag)
      const tokens = await waitForSync(
        'the rejoined stream to carry the turn’s tokens',
        async () => {
          const again = await readStream(cloud.base, machine.cookies, streamPath(sessionId, '?fromSeq=0'), {
            untilMs: 20_000,
          })
          return again.body.includes(token(tag, 1)) ? again : null
        },
        40_000,
        1_000,
      )
      expect(tokens.body).toContain(token(tag, 1))
      expect(tokens.body).not.toContain('host_tunnel_error')

      // …and once it finishes, the panel loses it again without a refetch.
      await waitForSync(
        'the cloud activity feed to drop the finished turn',
        async () => {
          const res = await read(c, activityPath)
          const items = Array.isArray(res.data?.activity) ? res.data.activity : []
          return !items.some((item: any) => item?.type === 'chat_turn' && item.chatSessionId === sessionId)
        },
        5_000,
        250,
      )
    } finally {
      turn.stop()
    }
  }, 300_000)

  test('AC5 · a message sent mid-turn is queued, runs after it, and survives a refresh', async () => {
    const { cloud: c } = clients()
    const sessionId = hosted.workspaceChatId
    const heldTag = `q${Date.now() % 100_000}`
    const queuedTag = `${heldTag}b`
    const queuedText = marker('long', queuedTag, 3, { ms: 10 })

    const turn = await startCloudTurn(sessionId, marker('hold', heldTag, 4, { ms: 20 }), heldTag)
    try {
      expect(turn.response.status).toBe(200)
      await waitForSync(
        'the desktop turn to be live',
        async () => {
          const res = await read(c, turnPath(sessionId))
          return res.status === 200 && res.data?.status === 'active'
        },
        60_000,
        500,
      )

      // The person keeps typing while the agent is working. The send is not
      // awaited first: the runtime holds a second POST on a busy session until
      // the live turn ends (that is the queue), so waiting for its headers here
      // would wait for the turn we are about to release.
      const queuedSend = startCloudTurn(sessionId, queuedText, queuedTag)
      await new Promise((resolve) => setTimeout(resolve, 1_500))

      llm.release(heldTag)

      const queued = await queuedSend
      const queuedStatus = queued.response.status
      queued.stop()
      expect([200, 202], `mid-turn send answered ${queuedStatus}\n${logs()}`).toContain(queuedStatus)

      // It runs on the desktop, after the held turn.
      await waitForSync(
        'the queued message to run on the desktop',
        async () => llm.requestsFor(queuedTag).length > 0,
        120_000,
        1_000,
      )

      // …and a fresh read (a refresh) still shows it, as the person's own message.
      const history = await read(c, `/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}&limit=100&offset=0`)
      expect(history.status).toBeLessThan(300)
      expect(JSON.stringify(history.data ?? '')).toContain(queuedTag)
    } finally {
      turn.stop()
    }
  }, 300_000)

  test('AC6 · a share_file link for a hosted workspace resolves from the cloud', async () => {
    const canary = `SHO486-FILE-${Date.now()}`
    const path = '.tmp/sho486-shared.txt'
    // A file that exists only on the desktop's disk: written through the cloud's
    // agent proxy, which is the desktop's runtime over the host tunnel.
    await waitForSync(
      'the desktop runtime to take a file',
      async () =>
        (
          await fetch(
            `${cloud.base}/api/workspaces/${encodeURIComponent(machine.machineWorkspaceId)}/agent-proxy/agent/workspace/files/${path}`,
            {
              method: 'PUT',
              headers: { cookie: machine.cookies, origin: cloud.base, 'content-type': 'application/json' },
              body: JSON.stringify({ content: canary }),
            },
          )
        ).status === 200,
      120_000,
      2_000,
    )

    // What the desktop's `share_file` mints: the cloud signs the link (the
    // desktop cannot — its own secret is not the cloud's) and the cloud serves
    // the bytes through the host tunnel, out of this desktop's own disk.
    const mintOnCloud = (body: Record<string, unknown>) =>
      fetch(`${cloud.base}/api/machines/${encodeURIComponent(machine.machineId)}/shared-files`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${machine.deviceKey}`,
          'content-type': 'application/json',
          origin: cloud.base,
        },
        body: JSON.stringify(body),
      })

    const minted = await mintOnCloud({ workspaceId: machine.machineWorkspaceId, path, expiresInDays: 1 })
    const mintedBody: any = await minted.json().catch(() => null)
    expect(minted.status, `mint: ${minted.status} ${JSON.stringify(mintedBody)}`).toBe(200)
    expect(String(mintedBody?.url)).toStartWith(cloud.base)
    expect(String(mintedBody?.url)).toContain('/api/f/')

    const download = await fetch(mintedBody.url, { headers: { origin: cloud.base } })
    const downloaded = await download.text()
    expect(download.status, `download: ${download.status} ${downloaded.slice(0, 300)}\n${logs()}`).toBe(200)
    expect(downloaded).toContain(canary)

    // A file in one project of the hosted workspace mints the same way (the
    // project-scoped link `share_file` makes from an agent working in a project).
    const projectMint = await mintOnCloud({ projectId: hosted.projectIds[0], path, expiresInDays: 1 })
    const projectBody: any = await projectMint.json().catch(() => null)
    expect(projectMint.status, `project mint: ${projectMint.status} ${JSON.stringify(projectBody)}`).toBe(200)
    expect(String(projectBody?.url)).toStartWith(cloud.base)
  }, 180_000)
})
