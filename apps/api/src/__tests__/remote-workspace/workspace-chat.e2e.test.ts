// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 2 — the workspace chat, in a remote workspace.
 *
 * A turn started from the cloud has to run on the computer that hosts the
 * workspace, against that computer's files, and stream back to the cloud as it
 * produces tokens — the same as on a cloud workspace or the desktop's own API.
 * The probe a phone uses to find a running turn (`/turn`), the rejoin a
 * reconnecting window uses (`/stream`) and Stop (`/chat/stop`) are checked live
 * too: the probe has to answer `active` while the turn runs, a rejoin has to
 * deliver bytes while the model is still producing, and a stop has to cut the
 * turn short instead of letting it stream to the end.
 *
 * These run on `TURN_TARGETS` (the desktop and the workspace it hosts), not on
 * the cloud baseline: the harness's only model is the scripted one, and a cloud
 * workspace's turn would call a real provider (see `TURN_TARGETS` in harness.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import { marker, token } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TURN_TARGETS,
  read,
  startRemoteWorkspace,
  uniq,
  waitFor,
  type RemoteWorkspace,
  type Side,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let llm: FakeLlmServer
const target = (name: (typeof TURN_TARGETS)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const chatPath = (side: Side) => `/api/workspaces/${encodeURIComponent(side.workspaceId)}/chat`
const turnPath = (side: Side, sessionId: string) => `${chatPath(side)}/${encodeURIComponent(sessionId)}/turn`
const streamPath = (side: Side, sessionId: string, fromSeq = 0) =>
  `${chatPath(side)}/${encodeURIComponent(sessionId)}/stream?fromSeq=${fromSeq}`
const headers = (side: Side) => ({ cookie: side.cookie, origin: side.base, 'content-type': 'application/json' })

/** POST a turn and hand back the response, without consuming the stream. */
async function startTurn(side: Side, sessionId: string, text: string): Promise<Response> {
  const res = await fetch(`${side.base}${chatPath(side)}`, {
    method: 'POST',
    headers: { ...headers(side), 'X-Chat-Session-Id': sessionId },
    body: JSON.stringify({
      id: sessionId,
      chatSessionId: sessionId,
      messages: [{ id: `u-${Math.random().toString(36).slice(2, 10)}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }),
  })
  return res
}

async function bodyOf(res: Response): Promise<string> {
  return await res.text()
}

/** The session's stored messages, read fresh (never from the SDK's GET cache). */
async function history(side: Side, sessionId: string): Promise<any[]> {
  const res = await read(side, `/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}&limit=100&offset=0`)
  return res.data?.items ?? []
}

/** A file that exists on this workspace's own disk only, written through its runtime. */
async function writeCanary(side: Side, path: string, content: string): Promise<number> {
  const res = await fetch(
    `${side.base}/api/workspaces/${encodeURIComponent(side.workspaceId)}/agent-proxy/agent/workspace/files/${path}`,
    { method: 'PUT', headers: headers(side), body: JSON.stringify({ content }) },
  )
  return res.status
}

describeIfInfra('remote workspace · the workspace chat', () => {
  for (const name of TURN_TARGETS) {
    describe(name, () => {
      test('a turn runs on the workspace’s own compute, against a file only it has', async () => {
        const t = target(name)
        const canary = `SHO488-CANARY-${name}-${Date.now()}`
        const path = `.tmp/sho488-canary-${name}.txt`

        // On a hosted workspace the file is written to the desktop's disk (the
        // cloud never sees this path); elsewhere the workspace's runtime is local
        // to it anyway, which is the same claim from the other side.
        const writeSide: Side = name === 'hosted' ? t.peer! : t
        await waitFor(`the ${name} runtime to take a file`, async () => (await writeCanary(writeSide, path, canary)) === 200, 180_000, 2_000)

        const tag = `c${name.slice(0, 2)}${Date.now() % 100_000}`
        const res = await startTurn(t, t.seed.workspaceChatId, `Read it ${marker('tool', tag, 5, { ms: 5, rounds: 1, path })}`)
        expect(res.status, `${res.status} ${(await res.clone().text()).slice(0, 300)}`).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')
        const stream = await bodyOf(res)
        expect(stream, stream.slice(-1500)).toContain(token(tag, 1))
        expect(stream).not.toContain('"type":"error"')

        // The tool ran where the workspace lives: the scripted model saw the
        // canary's contents, which only that workspace's disk has.
        const requests = llm.requestsFor(tag)
        expect(requests.length).toBeGreaterThanOrEqual(2)
        expect(requests[0].toolCalled).toBe('read_file')
        expect(requests.some((r) => String(r.toolResults ?? '').includes(canary))).toBe(true)
      }, 300_000)

      test('tokens reach the client as they are produced, not all at the end', async () => {
        const t = target(name)
        const tag = `s${name.slice(0, 2)}${Date.now() % 100_000}`
        const n = 30
        const res = await startTurn(t, t.seed.workspaceChatId, `Stream please ${marker('long', tag, n, { ms: 40 })}`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let text = ''
        let firstTokenAt = 0
        let sentWhenFirstArrived = -1
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
          if (!firstTokenAt && text.includes(token(tag, 1))) {
            firstTokenAt = Date.now()
            sentWhenFirstArrived = llm.sentAt(tag).length
          }
        }
        expect(firstTokenAt, `no token ever arrived:\n${text.slice(-800)}`).toBeGreaterThan(0)
        // The turn was still producing when the first token reached the client:
        // the stream is a stream, not a buffered body.
        expect(sentWhenFirstArrived).toBeLessThan(n)
        expect(text).toContain(token(tag, n))
      }, 240_000)

      test('the /turn probe reports a running turn', async () => {
        const t = target(name)
        const tag = `h${name.slice(0, 2)}${Date.now() % 100_000}`
        const turn = startTurn(t, t.seed.workspaceChatId, `Hold ${marker('hold', tag, 5, { ms: 5 })}`)
        try {
          await llm.waitForTurn(tag, 120_000)
          const probe = await read(t, turnPath(t, t.seed.workspaceChatId))
          expect(probe.status, `${probe.error ?? ''} ${JSON.stringify(probe.data)}`).toBeLessThan(300)
          // The runtime reports a live turn as `active`; anything else (`idle`,
          // `completed`, or a 404 with no turn at all) means the phone sees no
          // turn to rejoin.
          const status = probe.data?.status ?? probe.data?.turn?.status
          expect(status === 'active' || status === 'running', `probe answered ${JSON.stringify(probe.data)}`).toBeTruthy()
        } finally {
          llm.release(tag)
          await bodyOf(await turn.catch((e) => new Response(String(e))))
        }
      }, 240_000)

      /**
       * Rejoin a running turn and require the first bytes to land while the
       * model is still producing. If the proxy hop buffered the whole body, the
       * headers only arrive once every token has been produced — the window
       * shows nothing until the turn is already over.
       */
      const rejoinMustStream = async (t: Target, name: string): Promise<void> => {
        const n = 120
        const tag = `r${name.slice(0, 2)}${Date.now() % 100_000}`
        const turn = startTurn(t, t.seed.workspaceChatId, `Long ${marker('long', tag, n, { ms: 60 })}`)
        try {
          await llm.waitForTurn(tag, 120_000)
          await llm.waitForTokens(tag, 3, 60_000)
          const started = Date.now()
          const rejoin = await fetch(`${t.base}${streamPath(t, t.seed.workspaceChatId)}`, { headers: headers(t) })
          expect(rejoin.status, `rejoin refused with ${rejoin.status}`).toBe(200)
          const reader = rejoin.body!.getReader()
          const first = await Promise.race([
            reader.read(),
            new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), 20_000)),
          ])
          expect('timeout' in (first as any), 'the rejoin sent nothing within 20 s').toBe(false)
          const elapsed = Date.now() - started
          const produced = llm.sentAt(tag).length
          expect(
            produced,
            `first bytes after ${elapsed} ms, with ${produced}/${n} markers already produced` +
              (produced >= n ? ' — the rejoin was buffered until the turn ended' : ''),
          ).toBeLessThan(n)
          await reader.cancel().catch(() => {})
        } finally {
          llm.release(tag)
          await bodyOf(await turn.catch((e) => new Response(String(e))))
        }
      }

      if (name === 'hosted') {
        // Known gap: the host tunnel buffers a proxied resume, so the first
        // bytes only arrive once every token has been produced (measured ~7.0 s
        // with 120/120 markers). `test.failing` because the assertion is the
        // behaviour the card requires: the day the tunnel streams, this goes
        // red and the marker flips to `test`.
        test.failing(
          'rejoining a running turn over /stream streams it live, not after it ends [host tunnel buffers]',
          () => rejoinMustStream(target(name), name),
          240_000,
        )
      } else {
        test(
          'rejoining a running turn over /stream streams it live, not after it ends',
          () => rejoinMustStream(target(name), name),
          240_000,
        )
      }

      // Known gap (no product change on this card — AC6): `POST /chat/stop`
      // forwards the caller's `sessionId`, while the runtime resolves a stop from
      // `chatSessionId`/`X-Chat-Session-Id`. The runtime answers 400 and the route
      // wraps it in a 200, so Stop looks like it worked and the turn streams to
      // the end. `test.failing` keeps the requirement asserted: it goes red when
      // the route propagates the refusal, and the marker flips to `test`.
      test.failing('stopping a turn from here ends it [stop answers 200 around the runtime 400]', async () => {
        const t = target(name)
        const tag = `x${name.slice(0, 2)}${Date.now() % 100_000}`
        const turn = await startTurn(t, t.seed.workspaceChatId, `Stop me ${marker('long', tag, 400, { ms: 50 })}`)
        expect(turn.status).toBe(200)
        const consumed = bodyOf(turn)
        await llm.waitForTokens(tag, 3, 120_000)

        const stopped = await fetch(`${t.base}/api/workspaces/${encodeURIComponent(t.workspaceId)}/chat/stop`, {
          method: 'POST',
          headers: { ...headers(t), 'X-Chat-Session-Id': t.seed.workspaceChatId },
          body: JSON.stringify({ sessionId: t.seed.workspaceChatId }),
        })
        expect(stopped.status, await stopped.clone().text()).toBeLessThan(300)

        const text = await consumed
        // The stream can carry more than the turn we stopped: stopping hands the
        // queue off, and a queued message runs on the same open response. Judge
        // the turn that was running when the stop landed — the first one here.
        const stoppedTurn = text.split('data-turn-start')[1] ?? ''
        expect(stoppedTurn.length, `nothing streamed at all (${text.length} bytes)`).toBeGreaterThan(0)
        expect(stoppedTurn, 'the stop cut the turn short instead of streaming all 400 tokens').not.toContain(
          token(tag, 400),
        )

        // …and the session is no longer running a turn.
        await waitFor(
          'the turn to be reported as ended',
          async () => {
            const probe = await read(t, turnPath(t, t.seed.workspaceChatId))
            const status = probe.data?.status ?? probe.data?.turn?.status
            return status !== 'running' && status !== 'active'
          },
          90_000,
          500,
        )
        },
        240_000,
      )

      test('a message queued mid-turn runs after it and survives a refetch', async () => {
        const t = target(name)
        const tag = `q${name.slice(0, 2)}${Date.now() % 100_000}`
        const queuedText = `queued ${uniq('mid turn')} ${marker('long', tag, 8, { ms: 5 })}`
        const turn = await startTurn(t, t.seed.workspaceChatId, `Hold on ${marker('long', `w${tag}`, 80, { ms: 40 })}`)
        expect(turn.status).toBe(200)
        const consumed = bodyOf(turn)
        await llm.waitForTokens(`w${tag}`, 2, 120_000)

        const enqueued = await fetch(`${t.base}/api/chat-queued-messages`, {
          method: 'POST',
          headers: headers(t),
          body: JSON.stringify({
            sessionId: t.seed.workspaceChatId,
            content: queuedText,
            body: JSON.stringify({ text: queuedText }),
          }),
        })
        expect(enqueued.status, await enqueued.clone().text()).toBe(201)

        // The turn it was queued behind finishes…
        await consumed
        // …and then the queued message runs (on the same compute) and is part
        // of the history a refreshed page reads.
        await waitFor('the queued message to run', async () => llm.requestsFor(tag).length > 0, 180_000, 1_000)
        await waitFor('the queued message in the history', async () => {
          const rows = await history(t, t.seed.workspaceChatId)
          return rows.some((m) => String(m.content ?? '').includes('queued mid turn'))
        }, 90_000, 1_000)
      }, 300_000)
    })
  }
})
