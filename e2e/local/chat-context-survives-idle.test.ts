// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A one-message turn arrives with the conversation (SHO-137, AC8).
 *
 * Russell's report: an overnight chat lost the thread — a background job
 * finished, the agent woke on a one-line wake note and had no idea what the
 * conversation was about. Two things caused it: the idle pruner deleted the
 * *persisted* session, and a server-initiated turn (one message) had nothing to
 * re-seed an evicted session from.
 *
 * The unit tests cover the pruner and the cold-pod load. This spec covers the
 * hop they cannot: a queued/wake turn goes API → runtime → model, and the model
 * request must still contain the conversation. It is the worst case — a chat
 * whose history the API has, and which this runtime has *never* seen (exactly
 * what a pod that lost the session looks like).
 *
 * Runs the real local API + agent runtime against the scripted fake model:
 *
 *   AGENT_RUNTIME_ENTRY= LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 \
 *   LOCAL_LLM_BASIC_MODEL=fake-stream LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *     npx playwright test --config e2e/local/playwright.config.ts \
 *       chat-context-survives-idle --project chromium --retries 0
 *
 * `AGENT_RUNTIME_ENTRY` must be unset: with it set the API spawns the runtime
 * bundled inside the installed app instead of this checkout's source, and the
 * assertions run against the old runtime.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { FakeLlmServer } from '../../apps/desktop/e2e/streaming/fake-llm-server'

const API = process.env.E2E_API_URL || 'http://localhost:8002'
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
/** A string that only exists in the stored conversation, never in the wake. */
const CANARY = 'codeword-pelican-41'

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== '1',
  'needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1',
)

test.setTimeout(180_000)

let llm: FakeLlmServer
let request: APIRequestContext
let workspaceId: string
let userId: string

async function post<T = any>(path: string, data: unknown): Promise<T> {
  const res = await request.post(`${API}${path}`, { data })
  if (!res.ok()) throw new Error(`POST ${path} ${res.status()}: ${await res.text()}`)
  return (await res.json()) as T
}

test.beforeAll(async ({ playwright }, info) => {
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  request = await playwright.request.newContext({ baseURL: String(info.project.use.baseURL ?? API) })

  const signIn = await request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  const session = (await (await request.get(`${API}/api/auth/get-session`)).json()) as any
  userId = session?.user?.id ?? session?.session?.userId
  if (!userId) throw new Error('auto-sign-in returned no user id')

  const models = (await (await request.get(`${API}/api/local/models`)).json()) as any
  if (!(models?.models ?? []).some((m: any) => m?.id === 'fake-stream')) {
    throw new Error('the API is not pointed at the fake model; see this file header')
  }

  const workspaces = (await (await request.get(`${API}/api/workspaces`)).json()) as any
  const items = (workspaces?.items ?? workspaces?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  workspaceId = items.find((w) => w.kind !== 'personal')?.id ?? items[0]?.id ?? ''
  if (!workspaceId) throw new Error('no workspace to run the chat in')
})

test.afterAll(async () => {
  await request?.dispose()
  await llm?.stop()
})

test('a wake turn carries the conversation the runtime no longer has', async () => {
  // The chat and its conversation, written straight to the API database: this
  // is the history a pod that lost the session cannot see.
  // The generated CRUD route answers `{ ok: true, data: { id } }`, not the row.
  const created = await post<{ ok: boolean; data: { id: string } }>('/api/chat-sessions', {
    inferredName: 'deploy triage',
    contextType: 'workspace',
    workspaceId,
  })
  const sessionId = created.data.id
  if (!sessionId) throw new Error('POST /api/chat-sessions returned no id')
  for (const [role, content] of [
    ['user', `Remember the ${CANARY} before you start.`],
    ['assistant', 'Noted — the deploy stays blocked until the migration runs.'],
    ['user', 'And the rollback plan is the previous image tag.'],
  ] as const) {
    await post('/api/chat-messages', { sessionId, role, content })
  }

  // A background task finishing wakes the chat with exactly one message —
  // this is the queue path a wake takes.
  const wakeText = 'Background task finished: migration applied.'
  await post('/api/chat-queued-messages', {
    sessionId,
    userId,
    position: 0,
    status: 'pending',
    kind: 'message',
    content: wakeText,
    parts: JSON.stringify([{ type: 'text', text: wakeText }]),
    body: JSON.stringify({ text: wakeText }),
  })

  const turn = await waitForWakeTurn(wakeText)
  const sent = JSON.stringify(turn.body?.messages ?? [])

  // The wake itself arrived…
  expect(turn.userText).toContain('Background task finished')
  // …and so did the conversation it is about.
  expect(sent).toContain(CANARY)
  expect(sent).toContain('the rollback plan is the previous image tag')
})

/** The model request the wake turn produced. */
async function waitForWakeTurn(text: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = llm.turns.find((t) => t.userText.includes(text))
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no model request carried the wake text within ${timeoutMs}ms`)
}
