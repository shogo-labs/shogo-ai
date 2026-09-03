// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Standalone smoke test for the A2A protocol server — plays the role of an
 * "external" caller talking to a locally-running `apps/api` over plain HTTP
 * (localhost), the same way a real third-party A2A client would. Nothing in
 * this script imports shogo internals; it only speaks the wire protocol via
 * `@a2a-js/sdk/client`, exactly like `apps/api/src/routes/__tests__/a2a.test.ts`
 * does, minus the mocking — this one hits a real, running server.
 *
 * Prereqs (see docs/a2a.md and apps/desktop/README.md "Browser Debugging"):
 *   1. `apps/api` running locally with `A2A_ENABLED=true` (SQLite/local mode
 *      is fine — no cloud infra needed for the protocol surface itself).
 *   2. A project + a `shogo_a2a_*` key minted for it — either through the
 *      product UI (Settings → integrations, once that ships) or directly:
 *
 *        bun -e '
 *          import { prisma } from "./src/lib/prisma";
 *          import { mintA2aApiKey } from "./src/lib/a2a/auth";
 *          const p = await prisma.project.create({ data: { name: "A2A smoke test", workspaceId: "<ws-id>" } });
 *          console.log(JSON.stringify(await mintA2aApiKey({ projectId: p.id, workspaceId: "<ws-id>", createdBy: "you" })));
 *        '
 *
 * Usage:
 *   A2A_BASE_URL=http://localhost:8091 \
 *   A2A_PROJECT_ID=<projectId> \
 *   A2A_KEY=shogo_a2a_<keyId>.<secret> \
 *     bun apps/api/scripts/test-a2a-external-client.ts
 *
 * Flags: --no-stream skips the message/stream section (useful without a
 * configured LLM key, where the turn fails fast and streaming has little
 * to show); --skip-turn skips message/send AND message/stream entirely,
 * testing only card discovery, auth, and JSON-RPC error shapes.
 */

import { TaskState, type SendMessageRequest, type StreamResponse } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'

const BASE_URL = (process.env.A2A_BASE_URL ?? 'http://localhost:8091').replace(/\/$/, '')
const PROJECT_ID = process.env.A2A_PROJECT_ID
const KEY = process.env.A2A_KEY
const SKIP_STREAM = process.argv.includes('--no-stream')
const SKIP_TURN = process.argv.includes('--skip-turn')

if (!PROJECT_ID || !KEY) {
  console.error('Usage: A2A_BASE_URL=... A2A_PROJECT_ID=... A2A_KEY=shogo_a2a_... bun apps/api/scripts/test-a2a-external-client.ts')
  process.exit(1)
}

const CARD_URL = `/a2a/projects/${PROJECT_ID}/.well-known/agent-card.json`
const RPC_URL_PATH = `/a2a/projects/${PROJECT_ID}/rpc`

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failed++
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/** Bearer-injecting fetch — this is the ENTIRE client-side auth story; a
 * real external caller wires this up the same way against their own HTTP
 * client. Also demonstrates the authenticated-card-fetch requirement
 * documented in docs/a2a.md — most A2A client libraries assume an
 * unauthenticated card and need this same treatment. */
function authedFetch(token: string | null): typeof fetch {
  return (async (input: any, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }) as typeof fetch
}

async function main() {
  console.log(`A2A external-client smoke test against ${BASE_URL}`)
  console.log(`  project: ${PROJECT_ID}`)

  // ---------------------------------------------------------------------
  section('1. Auth is enforced on the card route')
  // ---------------------------------------------------------------------
  {
    const res = await fetch(`${BASE_URL}${CARD_URL}`)
    ok('unauthenticated card fetch -> 401', res.status === 401, `got ${res.status}`)
    ok('WWW-Authenticate: Bearer header present', res.headers.get('www-authenticate') === 'Bearer')

    const wrongProjectKeyRes = await fetch(`${BASE_URL}${CARD_URL}`, {
      headers: { authorization: 'Bearer shogo_a2a_deadbeefdeadbeefdeadbeef.' + '0'.repeat(64) },
    })
    ok('malformed/unknown key -> 401 (not a 500)', wrongProjectKeyRes.status === 401, `got ${wrongProjectKeyRes.status}`)
  }

  // ---------------------------------------------------------------------
  section('2. Agent card (authenticated)')
  // ---------------------------------------------------------------------
  const cardRes = await fetch(`${BASE_URL}${CARD_URL}`, { headers: { authorization: `Bearer ${KEY}` } })
  ok('authenticated card fetch -> 200', cardRes.status === 200, `got ${cardRes.status}`)
  const card = await cardRes.json()
  console.log(`  name:        ${card.name}`)
  console.log(`  description: ${String(card.description).slice(0, 100)}`)
  ok('protocolVersion is "1.0"', card.supportedInterfaces?.[0]?.protocolVersion === '1.0')
  ok('tenant matches projectId', card.supportedInterfaces?.[0]?.tenant === PROJECT_ID)
  ok('rpc url points back at this server', card.supportedInterfaces?.[0]?.url === `${BASE_URL}${RPC_URL_PATH}`)
  ok('capabilities.streaming is true', card.capabilities?.streaming === true)
  ok('bearerAuth security scheme declared', !!card.securitySchemes?.bearerAuth)

  // ---------------------------------------------------------------------
  section('3. JSON-RPC error shape for an unknown method')
  // ---------------------------------------------------------------------
  {
    const res = await fetch(`${BASE_URL}${RPC_URL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'probe-1', method: 'totally/bogus', params: {} }),
    })
    const body = await res.json()
    ok('unknown method returns a JSON-RPC error envelope', !!body.error, JSON.stringify(body))
    console.log(`  error: ${JSON.stringify(body.error)}`)
  }

  if (SKIP_TURN) {
    console.log('\n--skip-turn set: not exercising message/send or message/stream.')
    summarize()
    return
  }

  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authedFetch(KEY) })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authedFetch(KEY) }),
  })
  const client = await factory.createFromUrl(BASE_URL, CARD_URL)

  function sendRequest(text: string, contextId = ''): SendMessageRequest {
    return {
      tenant: '',
      message: {
        messageId: crypto.randomUUID(),
        contextId,
        taskId: '',
        role: 1, // ROLE_USER
        parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    } as SendMessageRequest
  }

  // ---------------------------------------------------------------------
  section('4. message/send with returnImmediately + tasks/get poll')
  // ---------------------------------------------------------------------
  {
    const req = sendRequest('Say hello in exactly three words.')
    req.configuration = { returnImmediately: true } as any
    const result = await client.sendMessage(req)
    ok('sendMessage(returnImmediately) returns a Task, not a Message', 'status' in result)
    if ('status' in result) {
      console.log(`  taskId: ${result.id}  initial state: ${TaskState[result.status!.state!]}`)
      ok(
        'initial state is SUBMITTED or WORKING (not blocked on the full turn)',
        result.status!.state === TaskState.TASK_STATE_SUBMITTED || result.status!.state === TaskState.TASK_STATE_WORKING,
        TaskState[result.status!.state!],
      )

      let last = result
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        last = await client.getTask({ id: result.id, historyLength: 0 })
        const state = TaskState[last.status!.state!]
        console.log(`  [poll ${i + 1}] tasks/get -> ${state}`)
        if (
          [
            TaskState.TASK_STATE_COMPLETED,
            TaskState.TASK_STATE_FAILED,
            TaskState.TASK_STATE_CANCELED,
            TaskState.TASK_STATE_INPUT_REQUIRED,
            TaskState.TASK_STATE_AUTH_REQUIRED,
          ].includes(last.status!.state!)
        ) {
          break
        }
      }
      console.log(`  final state: ${TaskState[last.status!.state!]}`)
      if (last.status?.message?.parts?.length) {
        const text = last.status.message.parts.map((p: any) => p.content?.value ?? '').join(' ')
        console.log(`  status message: ${text.slice(0, 300)}`)
      }
      const terminalOrInteractive = [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED,
      ].includes(last.status!.state!)
      ok(
        'task reached a terminal or interactive state within 30s',
        terminalOrInteractive,
        terminalOrInteractive ? undefined : `still ${TaskState[last.status!.state!]} — likely still spawning the project runtime; this is a slow-first-run cost, not a protocol bug`,
      )
    }
  }

  if (SKIP_STREAM) {
    console.log('\n--no-stream set: not exercising message/stream.')
    summarize()
    return
  }

  // ---------------------------------------------------------------------
  section('5. message/stream (SSE) — full event lifecycle')
  // ---------------------------------------------------------------------
  {
    const contextId = `smoke-${crypto.randomUUID()}`
    const received: StreamResponse['payload'][] = []
    for await (const event of client.sendMessageStream(sendRequest('Reply with a short haiku about testing software.', contextId))) {
      const p = event.payload
      received.push(p)
      if (p?.$case === 'task') console.log(`  [stream] task created: ${p.value.id}`)
      else if (p?.$case === 'artifactUpdate') {
        const text = p.value.artifact?.parts?.map((part: any) => part.content?.value ?? '').join('')
        console.log(`  [stream] artifactUpdate: ${JSON.stringify(text)}`)
      } else if (p?.$case === 'statusUpdate') {
        console.log(`  [stream] statusUpdate: ${TaskState[p.value.status!.state!]}`)
      }
    }
    ok('stream yielded at least one event', received.length > 0)
    ok('first event is a task', received[0]?.$case === 'task')
    const last = received[received.length - 1]
    ok('last event is a terminal/interactive statusUpdate', last?.$case === 'statusUpdate')

    // -------------------------------------------------------------------
    section('6. One in-flight turn per contextId')
    // -------------------------------------------------------------------
    // Fire two message/stream calls on a fresh shared contextId back to
    // back; the runtime pod call for the first is in flight long enough
    // (a real HTTP round trip, unlike the mocked integration test) that
    // the second should reliably observe the guard.
    const sharedCtx = `smoke-concurrent-${crypto.randomUUID()}`
    const drain = async (text: string) => {
      const events: StreamResponse['payload'][] = []
      for await (const event of client.sendMessageStream(sendRequest(text, sharedCtx))) events.push(event.payload)
      return events
    }
    const [firstEvents, secondEvents] = await Promise.all([drain('first concurrent message'), drain('second concurrent message')])
    const messageText = (evts: StreamResponse['payload'][]): string => {
      const l = evts[evts.length - 1]
      if (l?.$case !== 'statusUpdate') return ''
      return (l.value.status?.message?.parts ?? []).map((p: any) => p.content?.value ?? '').join(' ')
    }
    const terminalStates = [firstEvents, secondEvents].map((evts) => {
      const l = evts[evts.length - 1]
      return l?.$case === 'statusUpdate' ? TaskState[l.value.status!.state!] : l?.$case
    })
    const texts = [messageText(firstEvents), messageText(secondEvents)]
    console.log(`  concurrent call outcomes: [${terminalStates.join(', ')}]`)
    texts.forEach((t, i) => t && console.log(`  [${i === 0 ? 'first' : 'second'}] status message: ${t.slice(0, 200)}`))
    const guardFired = texts.some((t) => t.includes('already in progress'))
    ok(
      'the one-turn-per-contextId guard rejected one of the two sends (status message mentions "already in progress")',
      guardFired,
      guardFired ? undefined : `no status message mentioned the guard — outcomes were [${terminalStates.join(', ')}]`,
    )
  }

  summarize()
}

function summarize(): void {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
