// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-145 — the model an agent reports is the model it actually sends.
 *
 * Three faults shared one path: "which model does this agent run on".
 *
 *   1. `GET /ai/v1/models` marked every cloud-forwarded model
 *      `available:false`, and the runtime drops those entries, so the only
 *      concrete id an agent was ever offered was the one whose provider is
 *      never gated. The route's flag and the runtime's cache have to be the
 *      same list.
 *   2. The "You are running on …" line was a process singleton refreshed only
 *      by `/agent/chat`, so a turn in another project — or a heartbeat — printed
 *      whatever the last request happened to stamp. Two chats on one runtime
 *      must each name their own model.
 *   3. A model change written to the database never reached a running runtime
 *      for turns that read `config.json` (pipeline, heartbeat, schedule).
 *
 * The model server is scripted (see `apps/desktop/e2e/streaming/fake-llm-server`)
 * so every request the runtime makes is captured here: the model it sent and the
 * prompt it sent with it are both readable off `turn.body`.
 *
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   npx playwright test --config e2e/local/playwright.config.ts agent-model-truth --project chromium
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { resolve } from "path"
import { DatabaseSync } from "node:sqlite"
import { FakeLlmServer, marker, type FakeTurn } from "../../apps/desktop/e2e/streaming/fake-llm-server"
import { refreshAvailableModels, isAvailableModel } from "../../packages/agent-runtime/src/available-models"
import { deriveRuntimeToken } from "../../apps/api/src/lib/runtime-token"

const API = process.env.E2E_API_URL || "http://localhost:8002"
const LLM_PORT = Number(process.env.E2E_FAKE_LLM_PORT || 18765)
const REPO_ROOT = resolve(__dirname, "../..")

test.skip(
  process.env.E2E_FAKE_LLM_STACK !== "1",
  "needs an API started with LOCAL_LLM_BASE_URL pointing at the fake model (see the header); set E2E_FAKE_LLM_STACK=1",
)

test.setTimeout(420_000)

/**
 * The stack's own DB, so the spec can change a model the way the API does and
 * seed a second catalog entry. Always returns the file the API was booted
 * against; opening it fails loudly if the stack was started differently.
 */
function localDbPath(): string {
  if (process.env.E2E_LOCAL_DB) return process.env.E2E_LOCAL_DB
  const bundled = resolve(REPO_ROOT, "test-results/e2e-local.db")
  if (process.env.E2E_LOCAL_START_STACK === "1") return bundled
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv?.startsWith("file:")) return fromEnv.slice("file:".length)
  return bundled
}

const DB_PATH = localDbPath()

interface CatalogEntry {
  id: string
  display_name?: string
  owned_by?: string
  available?: boolean
}

let llm: FakeLlmServer
let context: BrowserContext
let workspaceId: string
let db: DatabaseSync
const created: string[] = []

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

async function createProject(name: string): Promise<string> {
  const res = await apiJson<any>("POST", "/api/projects", {
    name: `${name} ${Date.now().toString(36)}`,
    workspaceId,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
  })
  const id = res?.data?.id ?? res?.id
  if (!id) throw new Error(`project create failed: ${JSON.stringify(res).slice(0, 300)}`)
  created.push(id)
  return id
}

function prismaDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00")
}

/**
 * `GET /ai/v1/models` authenticates the caller by bearer token (proxy JWT,
 * device key or `rt_v1_` project runtime token), not by session cookie — it is
 * the endpoint the agent runtime itself calls. The spec calls it the same way.
 */
async function catalog(): Promise<CatalogEntry[]> {
  const entries: CatalogEntry[] = await proxyModels()
  return entries.filter((e) => e && typeof e.id === "string")
}

async function proxyModels(): Promise<CatalogEntry[]> {
  const res = await context.request.get(`${API}/api/ai/v1/models`, {
    headers: { Authorization: `Bearer ${proxyToken()}` },
  })
  const text = await res.text()
  if (!res.ok()) throw new Error(`GET /ai/v1/models as the runtime: HTTP ${res.status()} ${text.slice(0, 300)}`)
  const body = JSON.parse(text)
  return (body?.data ?? body?.items ?? []) as CatalogEntry[]
}

/** The bearer the agent runtime would use for this workspace's projects. */
function proxyToken(): string {
  const projectId = created[0]
  if (!projectId) throw new Error("proxyToken() needs a project")
  return runtimeToken(projectId)
}

function runtimeToken(projectId: string): string {
  return deriveRuntimeToken(projectId)
}

/** The name the API publishes for an id — what a prompt must call it. */
function displayName(entries: CatalogEntry[], id: string): string {
  const entry = entries.find((e) => e.id === id)
  return entry?.display_name ?? entry?.id ?? id
}

/** Every message the runtime sent, system prompt included, as one string. */
function promptText(turn: FakeTurn): string {
  const messages: any[] = turn.body?.messages ?? []
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n\n")
}

const composer = (page: Page) => page.getByTestId("project-composer-input").filter({ visible: true }).first()

async function openProjectChat(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectId)}`)
  await expect(composer(page)).toBeVisible({ timeout: 120_000 })
}

async function send(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Enter")
}

/** Writes the project's model to the DB the way `PATCH …/config` does. */
function setDbModel(projectId: string, name: string, provider: string): void {
  const updated = db
    .prepare("UPDATE agent_configs SET modelName = ?, modelProvider = ? WHERE projectId = ?")
    .run(name, provider, projectId)
  expect(updated.changes, `no agent_configs row for project ${projectId}`).toBe(1)
}

function modelForId(entries: CatalogEntry[], id: string): { name: string; provider: string } {
  const entry = entries.find((e) => e.id === id)
  return { name: id, provider: entry?.owned_by ?? "" }
}

/** Turns the fake model has already served, so a wait can look only at new ones. */
function newTurnsSince(count: number): FakeTurn[] {
  return llm.turns.slice(count)
}

/**
 * The stack ships one available model (`LOCAL_LLM_BASIC_MODEL` and
 * `LOCAL_LLM_ADVANCED_MODEL` are the same id in CI), which is not enough to
 * tell one turn's model from another's. Add a second through the admin catalog
 * route the picker uses: a `local`-provider row is always considered
 * configured and is not plan-gated (`apps/api/src/lib/model-access.ts`), and
 * the route invalidates the registry, so the next `/ai/v1/models` lists it.
 *
 * Seeding is a hard prerequisite, not a nicety: without two models the two
 * behavioural tests below cannot distinguish a correct turn from the stale-line
 * bug, and a skip there would report green while covering nothing (SHO-145 QA).
 */
async function seedSecondModel(): Promise<string> {
  const available = (await catalog()).filter((e) => e.available !== false)
  const ids = [...new Set(available.map((e) => e.id))]
  if (ids.length >= 2) return ids[1]

  // The admin catalog route is super-admin only; the local stack's sole user
  // is the instance owner.
  db.prepare("UPDATE users SET role = 'super_admin'").run()
  const res = await context.request.post(`${API}/api/admin/settings/models`, {
    data: {
      provider: "local",
      apiModel: "e2e-alternate-model",
      displayName: `E2E Alternate Model ${Date.now().toString(36)}`,
      shortDisplayName: "E2E Alt",
      tier: "standard",
    },
  })
  const text = await res.text()
  if (!res.ok()) throw new Error(`could not seed a second model (HTTP ${res.status()}): ${text.slice(0, 300)}`)

  const seeded = (await catalog()).filter((e) => e.available !== false)
  const seededIds = [...new Set(seeded.map((e) => e.id))]
  if (seededIds.length < 2) {
    throw new Error(`seeding a model did not make a second one visible: ${JSON.stringify(seeded).slice(0, 300)}`)
  }
  return seededIds.find((id) => !ids.includes(id)) ?? seededIds[1]
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(480_000)
  // Runtime tokens are HMACs of the stack's signing secret, so the spec has to
  // sign with the same one the API verifies (`BETTER_AUTH_SECRET` in
  // e2e/local/playwright.config.ts). Point E2E_AI_PROXY_SECRET at whatever a
  // differently-configured stack uses.
  process.env.BETTER_AUTH_SECRET = process.env.E2E_AI_PROXY_SECRET || "e2e-local-secret"
  llm = new FakeLlmServer()
  await llm.start(LLM_PORT)
  const baseURL = String(info.project.use.baseURL)
  context = await browser.newContext({ baseURL })
  const signIn = await context.request.post(`${API}/api/local/auto-sign-in`)
  if (!signIn.ok()) throw new Error(`auto-sign-in failed (${signIn.status()}): ${await signIn.text()}`)
  await context.request.post(`${API}/api/onboarding/complete`)

  const workspaces = await apiJson<any>("GET", "/api/workspaces")
  const list: any[] = workspaces?.items ?? workspaces?.data?.items ?? workspaces ?? []
  const workspace = list.find((w) => w?.kind !== "personal") ?? list[0]
  if (!workspace?.id) throw new Error(`no workspace: ${JSON.stringify(workspaces).slice(0, 300)}`)
  workspaceId = workspace.id

  db = new DatabaseSync(DB_PATH, { readOnly: false })
  await seedSecondModel()
})

test.afterAll(async () => {
  for (const id of created) await context?.request.delete(`${API}/api/projects/${id}`).catch(() => {})
  db?.close()
  await context?.close()
  await llm?.stop()
})

test("the models route and the runtime's cache are the same list", async () => {
  // Fault 1. The runtime drops every entry the route marks `available:false`,
  // so if the route is wrong about a cloud-forwarded provider the agent is
  // never offered that model — which is how every agent ended up on the one
  // provider that is never gated.
  // The token belongs to a project; one is enough to read the workspace's list.
  await createProject("model truth probe")
  const entries = await catalog()
  expect(entries.length, "the models route published nothing").toBeGreaterThan(0)

  process.env.AI_PROXY_URL = `${API}/api/ai/v1`
  process.env.AI_PROXY_TOKEN = proxyToken()
  try {
    await refreshAvailableModels({ force: true })
    // A 401 leaves the cache unloaded, where `isAvailableModel` accepts
    // everything — the assertions below would then prove nothing.
    expect(
      isAvailableModel("__never-a-model__"),
      "the runtime never loaded the model list: its fetch was not authenticated (set E2E_AI_PROXY_SECRET)",
    ).toBe(false)

    for (const entry of entries) {
      const listed = entry.available !== false
      expect(
        isAvailableModel(entry.id),
        `route says available:${listed} for ${entry.id} (${entry.owned_by}) but the runtime disagrees`,
      ).toBe(listed)
    }
  } finally {
    delete process.env.AI_PROXY_URL
    delete process.env.AI_PROXY_TOKEN
  }
})

test("two chats on one runtime each name their own model", async () => {
  // Fault 2. The line used to be a process singleton refreshed only by
  // `/agent/chat`, so the second project's turn printed the first one's model.
  const entries = (await catalog()).filter((e) => e.available !== false)
  const distinct = entries.filter((e, i) => entries.findIndex((o) => o.id === e.id) === i)
  expect(
    distinct.length,
    "fewer than two distinct available models: the seeding step did not take, and this test cannot tell one turn's model from another's",
  ).toBeGreaterThanOrEqual(2)
  const [first, second] = distinct

  const projectA = await createProject("model truth A")
  const projectB = await createProject("model truth B")
  const modelA = modelForId(entries, first.id)
  const modelB = modelForId(entries, second.id)
  setDbModel(projectA, modelA.name, modelA.provider)
  setDbModel(projectB, modelB.name, modelB.provider)

  const page = await context.newPage()
  const tagA = `mA${Date.now().toString(36)}`
  await openProjectChat(page, projectA)
  await send(page, `${marker("long", tagA, 4, { ms: 5 })} hello from A`)
  const turnA = await llm.waitForTurn(tagA, 180_000)

  const tagB = `mB${Date.now().toString(36)}`
  await openProjectChat(page, projectB)
  await send(page, `${marker("long", tagB, 4, { ms: 5 })} hello from B`)
  const turnB = await llm.waitForTurn(tagB, 180_000)
  await page.close()

  const nameA = displayName(entries, first.id)
  const nameB = displayName(entries, second.id)
  const promptA = promptText(turnA)
  const promptB = promptText(turnB)

  expect(promptA, `project A's prompt never named ${nameA}`).toContain(nameA)
  expect(promptB, `project B's prompt never named ${nameB}`).toContain(nameB)
  if (nameA !== nameB) {
    // The stale-line regression: B's turn printing A's model.
    expect(promptB, `project B's prompt still named project A's model (${nameA})`).not.toContain(nameA)
  }
})

test("a model change in the database reaches the next config-sourced turn", async () => {
  // Fault 3. A heartbeat turn takes its model from `config.json`, which nothing
  // re-synced, so a change made through the API only landed after a restart.
  const entries = (await catalog()).filter((e) => e.available !== false)
  expect(
    entries.length,
    "fewer than two available models: the seeding step did not take, and a model change cannot be observed",
  ).toBeGreaterThanOrEqual(2)
  const [before, after] = entries

  const projectId = await createProject("model truth heartbeat")
  // Local-mode file API: a HEARTBEAT.md makes the tick a real model turn
  // instead of the cheap `HEARTBEAT_OK` short-circuit.
  await apiJson("PUT", `/api/projects/${projectId}/files/HEARTBEAT.md`, {
    content: "# Heartbeat\n\nCheck nothing in particular, then reply HEARTBEAT_OK.\n",
  })
  await apiJson("PATCH", `/api/projects/${projectId}/heartbeat`, {
    heartbeatEnabled: true,
    heartbeatInterval: 60,
  })

  const beforeModel = modelForId(entries, before.id)
  const afterModel = modelForId(entries, after.id)

  const tick = async (model: { name: string; provider: string }): Promise<FakeTurn> => {
    setDbModel(projectId, model.name, model.provider)
    const since = llm.turns.length
    db.prepare("UPDATE agent_configs SET nextHeartbeatAt = ?, lastHeartbeatAt = NULL WHERE projectId = ?").run(
      prismaDate(new Date(Date.now() - 2 * 60_000)),
      projectId,
    )
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const turn = newTurnsSince(since).find((t) => /heartbeat/i.test(promptText(t)))
      if (turn) return turn
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`no heartbeat turn reached the model for ${model.name} within 240s`)
  }

  const firstTick = await tick(beforeModel)
  expect(promptText(firstTick), "the first heartbeat turn did not name its configured model").toContain(
    displayName(entries, before.id),
  )

  // No restart, no re-boot: the same running runtime, one DB write in between.
  const secondTick = await tick(afterModel)
  const secondPrompt = promptText(secondTick)
  expect(secondPrompt, "the next turn kept the old model after a database change").toContain(
    displayName(entries, after.id),
  )
  const staleName = displayName(entries, before.id)
  if (staleName !== displayName(entries, after.id)) {
    expect(secondPrompt, `the next turn still reported ${staleName}`).not.toContain(staleName)
  }
})
