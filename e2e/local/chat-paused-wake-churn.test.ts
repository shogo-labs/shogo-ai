// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A paused session holds one paused wake row and stops retrying it (SHO-92,
 * superseding SHO-32's "one row per retry").
 *
 * When a session's wakes are paused, `dispatchNext` fails the claimed row with
 * `Paused: …` and *holds* its tasks (`holdTaskWakes`), so the sweep leaves them
 * gone until a person writes. Before this, each wake was released back to the
 * sweep and retried every five minutes for the task's whole 24 h TTL: one
 * failed queue row per attempt (1,150 of them across 9 chats) and an `attempts`
 * counter that climbed to 292.
 *
 * Runs against the real local stack (`E2E_LOCAL_START_STACK=1` boots it with
 * the chat-queue worker on its 15 s tick). The pause is seeded straight into
 * the stack's SQLite file, so the spec does not spend three wake turns creating
 * one; each retry window is forced due instead of waited out.
 *
 * The delivery half — a person's message hands the held update back and it
 * arrives exactly once — is pinned in `background-tasks.integration.test.ts`,
 * because delivering it here needs a live model.
 *
 *   E2E_LOCAL_START_STACK=1 npx playwright test \
 *     --config e2e/local/playwright.config.ts chat-paused-wake-churn --project chromium
 */
import { expect, test, type BrowserContext } from "@playwright/test"
import { existsSync } from "fs"
import { resolve } from "path"
import { DatabaseSync } from "node:sqlite"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const REPO_ROOT = resolve(__dirname, "../..")
/** `run-chat-queue-drain`'s tick, and how long one retry window may take. */
const TICK_MS = 15_000
const CYCLE_DEADLINE_MS = 90_000

function localDbPath(): string | null {
  if (process.env.E2E_LOCAL_DB) return process.env.E2E_LOCAL_DB
  const bundled = resolve(REPO_ROOT, "test-results/e2e-local.db")
  // E2E_LOCAL_START_STACK boots the API against this file; an inherited
  // DATABASE_URL from an agent shell would point at a different database.
  if (process.env.E2E_LOCAL_START_STACK === "1") return bundled
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv?.startsWith("file:")) return fromEnv.slice("file:".length)
  return existsSync(bundled) ? bundled : null
}

const DB_PATH = localDbPath()

test.skip(!DB_PATH, "no local SQLite database to inspect (set E2E_LOCAL_DB)")
test.setTimeout(300_000)

let context: BrowserContext
let workspaceId = ""
let userId = ""
let projectId = ""
let db: DatabaseSync

async function apiJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await context.request.fetch(`${API}${route}`, {
    method,
    data: body,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

/** Prisma writes SQLite DateTime as ISO text with a `+00:00` offset. */
function prismaDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00")
}

function at(ms: number): string {
  return prismaDate(new Date(ms))
}

function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as any[]))
}

/**
 * Three wake turns, each reporting a task created after the previous wake
 * message, so `consecutiveWakeWaits` reads three waits and the session pauses.
 * Then one finished, unseen task whose wake the sweep will keep retrying.
 */
function seedPausedSession(): { sessionId: string; taskId: string } {
  const stamp = Date.now()
  const sessionId = `e2e-sho32-${stamp}`
  const taskId = `${sessionId}-waiting`
  const base = stamp - 20 * 60_000

  run(
    `INSERT INTO chat_sessions (id, inferredName, contextType, contextId, createdByUserId, createdAt, updatedAt, lastActiveAt)
     VALUES (?, ?, 'project', ?, ?, ?, ?, ?)`,
    sessionId,
    "SHO-32 paused wake",
    projectId,
    userId,
    at(base),
    at(base),
    at(base),
  )

  for (let i = 0; i < 3; i++) {
    const earlierTaskId = `${sessionId}-earlier-${i}`
    const taskAt = base + i * 2 * 60_000
    const messageAt = taskAt + 30_000
    run(
      `INSERT INTO background_tasks (id, chatSessionId, source, targetRef, title, status, output, notify, consumed, createdAt, finishedAt, expiresAt)
       VALUES (?, ?, 'shell', ?, ?, 'completed', '', 0, 1, ?, ?, ?)`,
      earlierTaskId,
      sessionId,
      earlierTaskId,
      `earlier ${i}`,
      at(taskAt),
      at(taskAt),
      at(taskAt + 60 * 60_000),
    )
    run(
      `INSERT INTO chat_messages (id, sessionId, role, content, parts, createdAt)
       VALUES (?, ?, 'user', ?, ?, ?)`,
      `${sessionId}-m${i}`,
      sessionId,
      `[Task update] earlier ${i}`,
      JSON.stringify([
        { type: "text", text: `[Task update] earlier ${i}` },
        { type: "data-task-notification", data: { taskIds: [earlierTaskId] } },
      ]),
      at(messageAt),
    )
  }

  run(
    `INSERT INTO background_tasks (id, chatSessionId, source, targetRef, title, status, output, notify, consumed, createdAt, finishedAt, expiresAt)
     VALUES (?, ?, 'shell', ?, ?, 'completed', '', 1, 0, ?, ?, ?)`,
    taskId,
    sessionId,
    taskId,
    "waiting wake",
    at(stamp),
    at(stamp),
    at(stamp + 60 * 60_000),
  )

  return { sessionId, taskId }
}

/** The rows the app itself reads: the queue route the chat UI polls. */
async function queuedRows(sessionId: string): Promise<any[]> {
  const body = await apiJson<any>("GET", `/api/chat-queued-messages?sessionId=${sessionId}`)
  const rows = body?.data ?? body?.items ?? body
  if (!Array.isArray(rows)) throw new Error(`unexpected queue response: ${JSON.stringify(body).slice(0, 300)}`)
  return rows
}

function pausedRows(rows: any[]): any[] {
  return rows.filter((row) => typeof row?.error === "string" && row.error.startsWith("Paused:"))
}

/** Let the sweep retry now instead of waiting out the backoff. */
function forceRetryDue(taskId: string) {
  run(`UPDATE background_tasks SET nextAttemptAt = ? WHERE id = ?`, at(Date.now() - 1_000), taskId)
}

async function waitFor<T>(what: string, probe: () => Promise<T | null>, deadlineMs = CYCLE_DEADLINE_MS): Promise<T> {
  const until = Date.now() + deadlineMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out after ${deadlineMs}ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

test.beforeAll(async ({ browser }, info) => {
  context = await browser.newContext({ baseURL: String(info.project.use.baseURL) })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const session = await apiJson<any>("GET", "/api/auth/get-session")
  userId = session?.user?.id
  if (!userId) throw new Error(`no signed-in user: ${JSON.stringify(session).slice(0, 300)}`)

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? []
  workspaceId = (list.find((w) => w?.kind !== "personal") ?? list[0])?.id
  if (!workspaceId) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)

  const created = await apiJson<any>("POST", "/api/projects", {
    name: `Paused wake churn ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
  })
  projectId = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)

  db = new DatabaseSync(DB_PATH!, { readOnly: false })
})

test.afterAll(async () => {
  if (db) {
    for (const sessionId of cleanupSessions) {
      run(`DELETE FROM chat_queued_messages WHERE sessionId = ?`, sessionId)
      run(`DELETE FROM chat_messages WHERE sessionId = ?`, sessionId)
      run(`DELETE FROM background_tasks WHERE chatSessionId = ?`, sessionId)
      run(`DELETE FROM chat_sessions WHERE id = ?`, sessionId)
    }
  }
  if (projectId) await context?.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
  db?.close()
  await context?.close()
})

const cleanupSessions: string[] = []

test("a session that stays paused keeps one failed row and stops retrying", async () => {
  const { sessionId, taskId } = seedPausedSession()
  cleanupSessions.push(sessionId)

  const paused = await waitFor("the first paused row", async () => {
    const rows = pausedRows(await queuedRows(sessionId))
    return rows[0] ?? null
  })
  expect(await queuedRows(sessionId)).toHaveLength(1)

  // Two retry windows of the drain worker: a paused wake is held, so neither
  // tick may re-queue it or touch the marker row a person is looking at.
  for (let window = 0; window < 2; window++) {
    forceRetryDue(taskId)
    await new Promise((r) => setTimeout(r, TICK_MS + 5_000))
    const rows = await queuedRows(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(paused.id)
    expect(rows[0].createdAt).toBe(paused.createdAt)
  }

  const waiting = db
    .prepare("SELECT attempts, heldUntil, notifiedAt FROM background_tasks WHERE id = ?")
    .get(taskId) as { attempts: number; heldUntil: string | null; notifiedAt: string | null }
  expect(waiting.attempts).toBe(1)
  expect(waiting.notifiedAt).not.toBeNull()
  // Held until the task's own expiry, not re-armed on the five-minute backoff.
  expect(new Date(waiting.heldUntil!).getTime()).toBeGreaterThan(Date.now() + 60_000)
})
