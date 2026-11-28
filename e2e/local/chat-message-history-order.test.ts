// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A paged chat read on the desktop returns the newest page (SHO-610).
 *
 * Russell's report: a reply streamed in, then vanished from the screen when the
 * turn ended; reopening the chat showed an older part of the conversation, and
 * long replies came back blank (the desktop transcript asks
 * `?sessionId=…&agent=technical&limit=50&offset=0`, and the local API had no
 * default `ORDER BY`, so SQLite answered in primary-key order — a slice that
 * never contained the current day).
 *
 * This drives the real local API: 60 messages through `POST /api/chat-messages`,
 * then the desktop's page shape and `limit=1` must agree on the newest row, and
 * the second page must continue from the first with no overlap. On `main` the
 * first page is the oldest slice, so the first two assertions fail.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts chat-message-history-order --project chromium
 */
import { expect, test, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || process.env.STAGING_API_URL || "http://localhost:8002"
const MESSAGE_COUNT = 60
const PAGE = 50

test.skip(
  process.env.E2E_LOCAL_START_STACK !== "1" && !process.env.E2E_API_URL,
  "needs a running local API (start it with E2E_LOCAL_START_STACK=1 or set E2E_API_URL)",
)

test.setTimeout(180_000)

let request: APIRequestContext
let sessionId: string
const createdIds: string[] = []

async function post<T = any>(path: string, data: unknown): Promise<T> {
  const res = await request.post(`${API}${path}`, { data })
  if (!res.ok()) throw new Error(`POST ${path} ${res.status()}: ${await res.text()}`)
  return (await res.json()) as T
}

async function listMessages(query: string): Promise<{ items: any[]; total: number }> {
  const res = await request.get(`${API}/api/chat-messages?${query}`)
  if (!res.ok()) throw new Error(`GET /api/chat-messages?${query} ${res.status()}: ${await res.text()}`)
  return (await res.json()) as { items: any[]; total: number }
}

test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext({ baseURL: API })

  const signIn = await request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await request.post(`${API}/api/onboarding/complete`)

  const workspaces = (await (await request.get(`${API}/api/workspaces`)).json()) as any
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? []
  const workspace = list.find((w) => w?.kind !== "personal") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace to create the chat in: ${JSON.stringify(workspaces).slice(0, 300)}`)

  // The generated CRUD route answers `{ ok: true, data: { id } }`, not the row.
  const session = await post<{ data: { id: string } }>("/api/chat-sessions", {
    inferredName: `history order ${Date.now()}`,
    contextType: "workspace",
    workspaceId: workspace.id,
  })
  sessionId = session.data.id
  if (!sessionId) throw new Error("POST /api/chat-sessions returned no id")

  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    // `createdAt` is assigned by the API, so insert order and createdAt order
    // agree — exactly the shape the desktop writes.
    const created = await post<{ data: { id: string } }>("/api/chat-messages", {
      sessionId,
      role: i % 2 === 0 ? "user" : "assistant",
      agent: "technical",
      content: `history order message ${i}`,
    })
    createdIds.push(created.data.id)
  }
})

test.afterAll(async () => {
  // Deleting the session cascades its messages, so the stack is left as found.
  if (sessionId) await request.delete(`${API}/api/chat-sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined)
  await request?.dispose()
})

test("the desktop's first page is the newest 50, newest first", async () => {
  const page = await listMessages(`sessionId=${sessionId}&agent=technical&limit=${PAGE}&offset=0`)

  expect(page.total).toBe(MESSAGE_COUNT)
  expect(page.items).toHaveLength(PAGE)
  expect(page.items[0].id).toBe(createdIds[createdIds.length - 1])
  expect(page.items[0].content).toBe(`history order message ${MESSAGE_COUNT - 1}`)

  const times = page.items.map((item) => new Date(item.createdAt).getTime())
  expect(times).toEqual([...times].sort((a, b) => b - a))
})

test("limit=1 agrees with the first page on the newest row", async () => {
  const one = await listMessages(`sessionId=${sessionId}&agent=technical&limit=1&offset=0`)
  const page = await listMessages(`sessionId=${sessionId}&agent=technical&limit=${PAGE}&offset=0`)

  expect(one.items).toHaveLength(1)
  expect(one.items[0].id).toBe(page.items[0].id)
  expect(one.total).toBe(MESSAGE_COUNT)
})

test("the next page continues without overlap", async () => {
  const first = await listMessages(`sessionId=${sessionId}&agent=technical&limit=${PAGE}&offset=0`)
  const second = await listMessages(`sessionId=${sessionId}&agent=technical&limit=${PAGE}&offset=${PAGE}`)

  expect(second.items).toHaveLength(MESSAGE_COUNT - PAGE)
  const firstIds = new Set(first.items.map((item) => item.id))
  expect(second.items.filter((item) => firstIds.has(item.id))).toEqual([])
  // The oldest seeded row (message 0) closes the paging: nothing was skipped.
  expect(second.items[second.items.length - 1].id).toBe(createdIds[0])
})
