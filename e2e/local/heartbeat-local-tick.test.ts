// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A due heartbeat is actually consumed in local/desktop mode (SHO-36).
 *
 * The desktop API entrypoint used to start four of the five polling workers
 * and never start the heartbeat scheduler, so `agent_configs.nextHeartbeatAt`
 * was written by the enable flow and never read: `lastHeartbeatAt` stayed null
 * forever while the UI showed a next run.
 *
 * This asserts the real thing end to end — enable via the route, force the row
 * due, then watch the scheduler advance it and the runtime report the tick.
 * The project has no `HEARTBEAT.md`, so the runtime returns `HEARTBEAT_OK`
 * before any model call: the run costs nothing.
 *
 * The forced-due write goes straight to the stack's SQLite file (the same one
 * `E2E_LOCAL_START_STACK=1` boots the API against), so the spec can stay
 * deterministic instead of waiting out the 60 s minimum interval. Set
 * `E2E_LOCAL_DB` when running against a stack you started yourself.
 */
import { expect, test, type BrowserContext } from "@playwright/test"
import { existsSync } from "fs"
import { resolve } from "path"
import { DatabaseSync } from "node:sqlite"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const REPO_ROOT = resolve(__dirname, "../..")
const MIN_INTERVAL_S = 60
/** Cold-booting the project runtime is the slow part of the first tick. */
const TICK_DEADLINE_MS = 180_000

function localDbPath(): string | null {
  if (process.env.E2E_LOCAL_DB) return process.env.E2E_LOCAL_DB
  const bundled = resolve(REPO_ROOT, "test-results/e2e-local.db")
  // E2E_LOCAL_START_STACK boots the API against this file, and wins over an
  // inherited DATABASE_URL: an agent shell or a developer's env often exports
  // the workspace dev DB, and forcing a due row in *that* file matches no
  // project, so the spec would fail without ever exercising the scheduler.
  if (process.env.E2E_LOCAL_START_STACK === "1") return bundled
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv?.startsWith("file:")) return fromEnv.slice("file:".length)
  return existsSync(bundled) ? bundled : null
}

const DB_PATH = localDbPath()

test.skip(!DB_PATH, "no local SQLite database to force a due heartbeat in (set E2E_LOCAL_DB)")
test.setTimeout(300_000)

let context: BrowserContext
let workspaceId: string
let projectId: string
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

test.beforeAll(async ({ browser }, info) => {
  context = await browser.newContext({ baseURL: String(info.project.use.baseURL) })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? []
  const workspace = list.find((w) => w?.kind !== "personal") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)
  workspaceId = workspace.id

  db = new DatabaseSync(DB_PATH!, { readOnly: false })
})

test.afterAll(async () => {
  if (projectId) await context?.request.delete(`${API}/api/projects/${projectId}`).catch(() => {})
  db?.close()
  await context?.close()
})

test("a due heartbeat advances its schedule and records the tick", async () => {
  const created = await apiJson<any>("POST", "/api/projects", {
    name: `Heartbeat tick ${Date.now()}`,
    workspaceId,
    tier: "starter",
    status: "draft",
  })
  projectId = created?.data?.id ?? created?.id
  if (!projectId) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 300)}`)

  // Enabling succeeds in local mode regardless of plan (local billing is paid).
  const enabled = await apiJson<any>("PATCH", `/api/projects/${projectId}/heartbeat`, {
    heartbeatEnabled: true,
    heartbeatInterval: MIN_INTERVAL_S,
  })
  expect(enabled.heartbeatEnabled).toBe(true)
  expect(enabled.heartbeatInterval).toBe(MIN_INTERVAL_S)
  expect(enabled.lastHeartbeatAt).toBeNull()

  // Force it due: the scheduler polls, it is the poll that was missing.
  const forcedDueAt = new Date(Date.now() - 2 * 60_000)
  const updated = db
    .prepare("UPDATE agent_configs SET nextHeartbeatAt = ?, lastHeartbeatAt = NULL WHERE projectId = ?")
    .run(prismaDate(forcedDueAt), projectId)
  expect(updated.changes).toBe(1)

  const heartbeat = async (): Promise<any> =>
    apiJson<any>("GET", `/api/projects/${projectId}/heartbeat`)

  // 1. The tick was consumed: lastHeartbeatAt is no longer null.
  await expect
    .poll(async () => (await heartbeat())?.lastHeartbeatAt ?? null, {
      message: "the local heartbeat scheduler never consumed the due row (SHO-36)",
      timeout: TICK_DEADLINE_MS,
      intervals: [2_000],
    })
    .not.toBeNull()

  // 2. It rescheduled itself by the configured interval (+ up to 10 % jitter).
  //    `nextHeartbeatAt` is written from the poll, but `lastHeartbeatAt` comes
  //    from the runtime's completion report, so the measured gap is the
  //    interval *minus* however long the trigger took to report — a cold
  //    runtime start alone costs seconds. Bound it loosely rather than pinning
  //    it to 0.9x, which fails whenever the tick is slow (SHO-36 QA).
  const after = await heartbeat()
  const last = new Date(after.lastHeartbeatAt)
  const next = new Date(after.nextHeartbeatAt)
  const advancedS = (next.getTime() - last.getTime()) / 1000
  expect(advancedS).toBeGreaterThan(MIN_INTERVAL_S * 0.5)
  expect(advancedS).toBeLessThan(MIN_INTERVAL_S * 1.1 + 5)
  expect(next.getTime()).toBeGreaterThan(forcedDueAt.getTime())

  // 3. Enabling stayed on — the tick did not switch the feature off.
  expect(after.heartbeatEnabled).toBe(true)
})
