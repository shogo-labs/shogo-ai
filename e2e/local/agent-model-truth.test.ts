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
 * Only fault 1 is driven from here. Faults 2 and 3 have to observe a turn
 * running on a *different* model per project, and this stack cannot produce
 * that: `LOCAL_LLM_BASIC_MODEL`/`LOCAL_LLM_ADVANCED_MODEL` are what point the
 * `local` provider at the fake server, and the same two variables build the
 * economy/standard/premium Auto-tier map every turn on the runtime resolves
 * through ("Auto tier override active: …" at boot). A per-project model written
 * either to `agent_configs` or through `PATCH /api/internal/projects/:id/config`
 * is therefore never the model the turn sends — every request arrives as
 * `fake-stream`, so a two-model assertion would compare one model to itself and
 * pass no matter what the runtime printed. Those two faults are covered where
 * the resolution is deterministic instead:
 *   - `packages/agent-runtime/src/__tests__/account-model-line.test.ts` — the
 *     line comes from the turn's own model, and a stamped name cannot outlive
 *     its override.
 *   - `packages/agent-runtime/src/__tests__/agent-model-config.test.ts` and
 *     `capability-sync.test.ts` — the API's model config wins over the cached
 *     `config.json`, and the DB re-read is throttled rather than per-turn.
 *
 * The model server is scripted (see `apps/desktop/e2e/streaming/fake-llm-server`)
 * so every request the runtime makes is captured here.
 *
 *   E2E_LOCAL_START_STACK=1 E2E_FAKE_LLM_STACK=1 \
 *   LOCAL_LLM_BASE_URL=http://127.0.0.1:18765 LOCAL_LLM_BASIC_MODEL=fake-stream \
 *   LOCAL_LLM_ADVANCED_MODEL=fake-stream \
 *   npx playwright test --config e2e/local/playwright.config.ts agent-model-truth --project chromium
 */
import { expect, test, type BrowserContext } from "@playwright/test"
import { resolve } from "path"
import { DatabaseSync } from "node:sqlite"
import { FakeLlmServer } from "../../apps/desktop/e2e/streaming/fake-llm-server"
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

/**
 * The stack lists the static `MODEL_CATALOG` until an admin adds rows, and in
 * local mode not one static model's provider is reachable, so the published
 * list has no usable entry at all. The desktop's real path is the admin catalog
 * (`/api/admin/settings/models`), which the local composer does not mount, so
 * the two rows a super-admin would have added are written straight into the
 * stack's own database. A `local`-provider row is always considered configured
 * and is never plan-gated (`apps/api/src/lib/model-access.ts`), so both come
 * back `available:true` — and with DB rows present the picker stops falling
 * back to the static catalog, leaving exactly these two.
 *
 * Two rows rather than one: the case below compares the route's `available`
 * flag against the runtime's cache per entry, so more than one entry is what
 * makes it a comparison instead of a single lookup that could pass by luck.
 *
 * The registry snapshot is refreshed in the background once it is 30s stale
 * (`model-registry.service.ts`), hence the poll instead of a single read.
 */
const SEEDED_MODELS = [
  { id: "e2e-alpha-model", displayName: "E2E Alpha Model" },
  { id: "e2e-beta-model", displayName: "E2E Beta Model" },
] as const

async function seedLocalModels(): Promise<void> {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO model_definitions
       (id, provider, providerId, apiModel, displayName, shortDisplayName, tier, family,
        generation, kind, maxOutputTokens, enabled, sortOrder, aliases, capabilities,
        description, contextWindow, reasoningEffort, inputPerMillion, cachedInputPerMillion,
        cacheWritePerMillion, outputPerMillion, usdPerMinute, createdAt, updatedAt, updatedBy)
     VALUES (?, 'local', NULL, ?, ?, ?, 'standard', 'other', 'current', 'chat', 64000, 1, ?,
             NULL, NULL, NULL, 200000, NULL, 0, 0, 0, 0, NULL, ?, ?, NULL)`,
  )
  const now = prismaDate(new Date())
  SEEDED_MODELS.forEach((model, index) => {
    insert.run(model.id, model.id, model.displayName, model.displayName, index, now, now)
  })

  const deadline = Date.now() + 120_000
  let available: CatalogEntry[] = []
  while (Date.now() < deadline) {
    available = (await catalog()).filter((entry) => entry.available !== false)
    if (SEEDED_MODELS.every((model) => available.some((entry) => entry.id === model.id))) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`the seeded models never became available: ${JSON.stringify(available).slice(0, 500)}`)
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(600_000)
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
  // A runtime token is scoped to a project, so the probe project has to exist
  // before anything authenticates — `seedLocalModels` reads the catalog first.
  await createProject("model truth probe")
  await seedLocalModels()
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
  // The token belongs to the probe project `beforeAll` created; one is enough
  // to read the workspace's list.
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
