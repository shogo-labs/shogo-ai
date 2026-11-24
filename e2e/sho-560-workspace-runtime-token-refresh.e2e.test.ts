// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace runtime rotates its AI proxy token (SHO-560).
 *
 * A merged-root workspace runtime names itself `ws:<workspaceId>` (or
 * `ws:proj:<anchorProjectId>` for a project canvas), never a real project id.
 * Its token refresh asks `GET /api/internal/pod-config/<that key>`, and before
 * this change that key resolved no project, so every tick 401'd
 * `workspace_token_mismatch` and the token died for good — turns then ended with
 * 0 tokens (prod: Odin `b5c1129c` silent from 03:11 UTC, plus 5 more workspaces).
 *
 * Nothing here is stubbed between the halves that disagreed with each other:
 *
 *   1. The **real** `apps/api/src/routes/internal.ts` route, the real
 *      `authenticate` chain and the real `wrt_v1_` / `rt_v1_` verifiers, driven
 *      through `app.request` and (for the loop) a real HTTP server.
 *   2. The real `buildWorkspaceRuntimeRefreshEnv` / `buildWorkspaceEnv` token
 *      minting, so the returned `AI_PROXY_TOKEN` is a genuine 7-day JWT whose
 *      `exp` is later than the token the runtime booted with.
 *   3. The real `startTokenRefreshLoop`, so the URL the runtime builds, the
 *      credential it sends and the env it applies are the runtime's own.
 *
 * Stubbed, because they are infrastructure this test does not own: prisma rows
 * (two workspaces, three projects), the owner lookups, the billing gate behind
 * model defaults, the cluster ServiceAccount verifier, `buildProjectEnv` (only
 * to prove the workspace path never reaches it) and the Knative Service read
 * that supplies the member ids a cloud runtime booted with — that Service→ids
 * mapping has its own suite (`knative-workspace-manager.test.ts`).
 */

process.env.AI_PROXY_SECRET = 'sho-560-proxy-secret'
process.env.BETTER_AUTH_SECRET = 'sho-560-better-auth-secret'
delete process.env.SHOGO_METAL_ENABLED
delete process.env.SHOGO_METAL_ALL_PROJECTS
delete process.env.SHOGO_LOCAL_MODE
delete process.env.K8S_SA_TOKEN_OVERRIDE
// A workspace runtime in the cluster; the refresh reads its baked member list
// from the Knative Service (stubbed below).
process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

import { afterAll, afterEach, beforeAll, describe, expect, test, mock } from 'bun:test'
import { Hono } from 'hono'

// ─── Infrastructure stubs ────────────────────────────────────────────────────

const W = 'b5c1129c-odin-workspace'
const W_OTHER = 'eaa51b46-other-workspace'
const W_EMPTY = '2c8bc2d2-empty-workspace'
const W_LOOP = '9873c02d-loop-workspace'
const P1 = 'p-560-alpha'
const P2 = 'p-560-beta'
const P_OTHER = 'p-560-other-workspace-project'
const P_LOOP = 'p-560-loop'
const P_SINGLE = 'p-560-single-project-runtime'

const workspaceRows: Record<string, { id: string; name: string; kind: string }> = {
  [W]: { id: W, name: 'Odin', kind: 'team' },
  [W_OTHER]: { id: W_OTHER, name: 'Other', kind: 'team' },
  [W_EMPTY]: { id: W_EMPTY, name: 'Brand New', kind: 'personal' },
  [W_LOOP]: { id: W_LOOP, name: 'Loop', kind: 'team' },
}
const projectRows: Record<string, { id: string; workspaceId: string; name: string }> = {
  [P1]: { id: P1, workspaceId: W, name: 'Alpha' },
  [P2]: { id: P2, workspaceId: W, name: 'Beta' },
  [P_OTHER]: { id: P_OTHER, workspaceId: W_OTHER, name: 'Other project' },
  [P_LOOP]: { id: P_LOOP, workspaceId: W_LOOP, name: 'Loop project' },
  [P_SINGLE]: { id: P_SINGLE, workspaceId: W, name: 'Single-project runtime' },
}

/** What each Knative Service baked at create time — `readBootedMembers`. */
const bootedMembers = new Map<string, string[] | null>()
const bootedKey = (workspaceId: string, anchorProjectId?: string) =>
  `${workspaceId}|${anchorProjectId ?? ''}`
/** Every `buildProjectEnv` call, so a `ws:` key can prove it never got there. */
const projectEnvCalls: string[] = []

mock.module('../apps/api/src/lib/prisma', () => ({
  prisma: {
    workspace: {
      findUnique: async (args: any) => workspaceRows[args?.where?.id] ?? null,
    },
    project: {
      findUnique: async (args: any) => {
        const row = projectRows[args?.where?.id]
        return row ? { id: row.id, workspaceId: row.workspaceId } : null
      },
      findFirst: async (args: any) => projectRows[args?.where?.id] ?? null,
      findMany: async (args: any) => {
        const where = args?.where ?? {}
        if (where.id?.in) {
          return (where.id.in as string[])
            .map((id) => projectRows[id])
            .filter(Boolean)
            .map((row) => ({
              id: row!.id,
              name: row!.name,
              settings: null,
              workspaceDiskGiB: null,
              vmMemoryMiB: null,
              vmVcpus: null,
            }))
        }
        if (where.workspaceId) {
          return Object.values(projectRows)
            .filter((row) => row.workspaceId === where.workspaceId)
            .map((row) => ({ id: row.id, name: row.name, description: null, createdBy: 'owner-1' }))
        }
        return []
      },
    },
    platformSetting: { findUnique: async () => null },
    modelDefinition: { findMany: async () => [] },
  },
}))

mock.module('../apps/api/src/lib/project-user-context', () => ({
  getProjectOwnerUserId: async (projectId: string) => `owner-of-${projectId}`,
  getWorkspaceOwnerUserId: async (workspaceId: string) => `owner-of-${workspaceId}`,
}))

// Model defaults ask billing whether the workspace has advanced models; a
// live Postgres lookup is not what this test is about.
mock.module('../apps/api/src/services/billing.service', () => ({
  hasAdvancedModelAccess: async () => true,
}))

mock.module('../apps/api/src/lib/k8s-auth', () => ({
  validatePodToken: async (token: string) =>
    token === 'sa-token' ? { serviceAccountName: 'workspace-runtime', namespace: 'shogo-system' } : null,
}))

// Only used to prove the workspace path never calls it, and to keep the
// unchanged project path honest.
mock.module('../apps/api/src/lib/warm-pool-controller', () => ({
  getWarmPoolController: () => ({
    buildProjectEnv: async (projectId: string) => {
      projectEnvCalls.push(projectId)
      return { ASSIGNED_PROJECT: projectId, AI_PROXY_TOKEN: 'project-env-token' }
    },
  }),
}))

mock.module('../apps/api/src/lib/knative-workspace-manager', () => ({
  readWorkspaceRuntimeMembers: async (workspaceId: string, anchorProjectId?: string) =>
    bootedMembers.get(bootedKey(workspaceId, anchorProjectId)) ?? null,
}))

// ─── The real halves ─────────────────────────────────────────────────────────

const app = (await import('../apps/api/src/routes/internal')).default
const { deriveWorkspaceRuntimeToken } = await import('../apps/api/src/lib/workspace-runtime-token')
const { deriveRuntimeToken } = await import('../apps/api/src/lib/runtime-token')
const { generateProxyToken, verifyProxyToken } = await import('../apps/api/src/lib/ai-proxy-token')
const { buildWorkspaceEnv } = await import('../apps/api/src/lib/runtime/build-workspace-env')
const { __resetTokenRefreshGlobals, notifyProxyAuthFailure, startTokenRefreshLoop } = await import(
  '../packages/shared-runtime/src/token-refresh'
)
type TokenRefreshHandle = Awaited<ReturnType<typeof startTokenRefreshLoop>>

const SA = { Authorization: 'Bearer sa-token' }
const wsToken = (workspaceId: string) => ({ 'x-runtime-token': deriveWorkspaceRuntimeToken(workspaceId) })
const podConfigPath = (key: string) => `/pod-config/${encodeURIComponent(key)}`

const touchedEnv = ['AI_PROXY_TOKEN', 'AI_PROXY_TOKENS', 'AI_PROXY_URL', 'SHOGO_API_URL'] as const
const envSnapshot = new Map<string, string | undefined>()
beforeAll(() => {
  for (const name of touchedEnv) envSnapshot.set(name, process.env[name])
})
afterEach(() => {
  for (const name of touchedEnv) {
    const value = envSnapshot.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
afterAll(() => {
  for (const name of touchedEnv) {
    const value = envSnapshot.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

/**
 * The token the runtime booted with — a real proxy JWT minted with a day less
 * TTL left, i.e. the state of a pod that booted 24 h ago. The refresh must hand
 * back a *later* `exp`, which is what keeps the pod alive past day 7.
 */
async function bootToken(projectId: string, workspaceId: string, ttlMs = 6 * 24 * 60 * 60 * 1000): Promise<string> {
  return generateProxyToken(projectId, workspaceId, `owner-of-${projectId}`, ttlMs)
}

// ---------------------------------------------------------------------------
// 1. `ws:<workspaceId>` — the refresh a workspace-session runtime makes
// ---------------------------------------------------------------------------

describe('GET /pod-config/ws:<workspaceId>', () => {
  test('the runtime’s own token rotates its AI proxy token, for the projects it booted with', async () => {
    // The Knative Service for this workspace baked both attached projects.
    bootedMembers.set(bootedKey(W), [P1, P2])
    const oldToken = await bootToken(P1, W)
    const oldPayload = (await verifyProxyToken(oldToken))!

    const res = await app.request(podConfigPath(`ws:${W}`), { headers: wsToken(W) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; env: Record<string, string> }

    expect(body.projectId).toBe(`ws:${W}`)
    // Only proxy credentials: the runtime applies a refresh additively and never
    // unsets, so a topology key from a stale boot would rewrite the live runtime.
    expect(Object.keys(body.env).sort()).toEqual(['AI_PROXY_TOKEN', 'AI_PROXY_TOKENS', 'AI_PROXY_URL'])
    expect(body.env.WORKSPACE_PROJECT_IDS).toBeUndefined()

    // A fresh token, not the one that expired.
    expect(body.env.AI_PROXY_TOKEN).not.toBe(oldToken)
    const fresh = (await verifyProxyToken(body.env.AI_PROXY_TOKEN))!
    expect(fresh.projectId).toBe(P1)
    expect(fresh.workspaceId).toBe(W)
    expect(fresh.exp).toBeGreaterThan(oldPayload.exp)

    // Every project the runtime serves, so per-project attribution survives.
    const tokens = JSON.parse(body.env.AI_PROXY_TOKENS) as Record<string, string>
    expect(Object.keys(tokens).sort()).toEqual([P1, P2].sort())
    for (const projectId of [P1, P2]) {
      expect((await verifyProxyToken(tokens[projectId]))!.projectId).toBe(projectId)
    }

    // Never the single-project builder: this key names no project.
    expect(projectEnvCalls).toEqual([])
  })

  test('a workspace with no projects gets the `workspace` sentinel token', async () => {
    bootedMembers.set(bootedKey(W_EMPTY), [])
    const res = await app.request(podConfigPath(`ws:${W_EMPTY}`), { headers: wsToken(W_EMPTY) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { env: Record<string, string> }

    const token = (await verifyProxyToken(body.env.AI_PROXY_TOKEN))!
    expect(token.projectId).toBe('workspace')
    expect(token.workspaceId).toBe(W_EMPTY)
    expect(JSON.parse(body.env.AI_PROXY_TOKENS)).toEqual({})
  })

  test('an SA bearer is served, and never reaches buildProjectEnv', async () => {
    bootedMembers.set(bootedKey(W), [P1, P2])
    const res = await app.request(podConfigPath(`ws:${W}`), { headers: SA })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { env: Record<string, string> }
    expect(body.env.AI_PROXY_TOKEN).toBeTruthy()
    expect(Object.keys(body.env).sort()).toEqual(['AI_PROXY_TOKEN', 'AI_PROXY_TOKENS', 'AI_PROXY_URL'])
    expect(projectEnvCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. `ws:proj:<anchor>` — the refresh a project-canvas runtime makes
// ---------------------------------------------------------------------------

describe('GET /pod-config/ws:proj:<anchor>', () => {
  test('the workspace is resolved from the anchor, whose token leads the set', async () => {
    bootedMembers.set(bootedKey(W, P1), [P1, P2])
    const oldToken = await bootToken(P1, W)

    const res = await app.request(podConfigPath(`ws:proj:${P1}`), { headers: wsToken(W) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; env: Record<string, string> }

    expect(body.projectId).toBe(`ws:proj:${P1}`)
    const tokens = JSON.parse(body.env.AI_PROXY_TOKENS) as Record<string, string>
    expect(tokens[P1]).toBe(body.env.AI_PROXY_TOKEN)
    expect(tokens[P1]).not.toBe(oldToken)
    expect((await verifyProxyToken(body.env.AI_PROXY_TOKEN))!.projectId).toBe(P1)
    expect(Object.keys(tokens).sort()).toEqual([P1, P2].sort())
  })
})

// ---------------------------------------------------------------------------
// 3. Authorisation: the key never widens what the token may see
// ---------------------------------------------------------------------------

describe('auth for a workspace runtime key', () => {
  test('a workspace token for another workspace gets 401', async () => {
    const res = await app.request(podConfigPath(`ws:${W}`), { headers: wsToken(W_OTHER) })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toContain('workspace_runtime_key_mismatch')
  })

  test('a workspace token may not refresh an anchor project in another workspace', async () => {
    const res = await app.request(podConfigPath(`ws:proj:${P_OTHER}`), { headers: wsToken(W) })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toContain('workspace_runtime_key_mismatch')
  })

  test('a single-project runtime token gets 401: it must not collect the whole workspace', async () => {
    const res = await app.request(podConfigPath(`ws:${W}`), {
      headers: { 'x-runtime-token': deriveRuntimeToken(P_SINGLE) },
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toContain('tokenProject=')
    expect(projectEnvCalls).toEqual([])
  })

  test('no credentials get 401', async () => {
    const res = await app.request(podConfigPath(`ws:${W}`))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// 4. The project path is byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe('a real project id still takes the project path', () => {
  test('a project runtime token gets that project’s env from buildProjectEnv', async () => {
    const res = await app.request(podConfigPath(P_SINGLE), {
      headers: { 'x-runtime-token': deriveRuntimeToken(P_SINGLE) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; env: Record<string, string> }
    expect(body.projectId).toBe(P_SINGLE)
    expect(body.env).toEqual({ ASSIGNED_PROJECT: P_SINGLE, AI_PROXY_TOKEN: 'project-env-token' })
    expect(projectEnvCalls).toEqual([P_SINGLE])
  })

  test('a token for a different project still gets 401', async () => {
    const res = await app.request(podConfigPath(P_SINGLE), {
      headers: { 'x-runtime-token': deriveRuntimeToken(P2) },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// 5. The runtime's own refresh loop, against a real HTTP endpoint
// ---------------------------------------------------------------------------

describe('startTokenRefreshLoop on a workspace runtime', () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  const seenPaths: string[] = []
  const handles: TokenRefreshHandle[] = []

  beforeAll(() => {
    const api = new Hono()
    api.use('*', async (c, next) => {
      seenPaths.push(c.req.path)
      await next()
    })
    api.route('/api/internal', app)
    server = Bun.serve({ port: 0, fetch: (req) => api.fetch(req) })
    baseUrl = `http://127.0.0.1:${server.port}`
    bootedMembers.set(bootedKey(W_LOOP), [P_LOOP])
  })

  afterAll(() => {
    for (const handle of handles) handle.stop()
    server?.stop(true)
  })

  afterEach(() => {
    for (const handle of handles) handle.stop()
    handles.length = 0
    __resetTokenRefreshGlobals()
  })

  test('rotates AI_PROXY_TOKEN over HTTP, percent-encoding the workspace key', async () => {
    process.env.SHOGO_API_URL = baseUrl
    process.env.RUNTIME_AUTH_SECRET = deriveWorkspaceRuntimeToken(W_LOOP)
    process.env.AI_PROXY_URL = `${baseUrl}/api/ai/v1`
    process.env.AI_PROXY_TOKEN = await bootToken(P_LOOP, W_LOOP)
    const booted = process.env.AI_PROXY_TOKEN

    const handle = startTokenRefreshLoop({
      getProjectId: () => `ws:${W_LOOP}`,
      logPrefix: '[e2e-sho560]',
      intervalMs: 60 * 60 * 1000,
      jitterMs: 0,
    })
    handles.push(handle)

    const env = await handle.refreshNow()
    expect(env).not.toBeNull()
    expect(process.env.AI_PROXY_TOKEN).not.toBe(booted)
    expect((await verifyProxyToken(process.env.AI_PROXY_TOKEN!))!.projectId).toBe(P_LOOP)
    expect(JSON.parse(process.env.AI_PROXY_TOKENS!)).toHaveProperty(P_LOOP)

    // The key travelled as one path segment, with the colon encoded.
    expect(seenPaths.some((path) => path === `/api/internal/pod-config/ws%3A${W_LOOP}`)).toBe(true)
  })

  test('an already-expired local token triggers an immediate rotation on the first 401', async () => {
    process.env.SHOGO_API_URL = baseUrl
    process.env.RUNTIME_AUTH_SECRET = deriveWorkspaceRuntimeToken(W_LOOP)
    process.env.AI_PROXY_URL = `${baseUrl}/api/ai/v1`
    // The day-8 pod: the baked token expired, so every turn 401s.
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
    process.env.AI_PROXY_TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      projectId: P_LOOP,
      exp: Math.floor(Date.now() / 1000) - 60,
    })}.sig`

    const handle = startTokenRefreshLoop({
      getProjectId: () => `ws:${W_LOOP}`,
      logPrefix: '[e2e-sho560]',
      intervalMs: 60 * 60 * 1000,
      jitterMs: 0,
    })
    handles.push(handle)

    expect(notifyProxyAuthFailure()).toBe(true)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const payload = await verifyProxyToken(process.env.AI_PROXY_TOKEN ?? '')
      if (payload?.projectId === P_LOOP && payload.exp * 1000 > Date.now()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`AI_PROXY_TOKEN was never rotated (still ${process.env.AI_PROXY_TOKEN})`)
  })
})

// ---------------------------------------------------------------------------
// 6. Boot and refresh agree on the workspace's identity
// ---------------------------------------------------------------------------

describe('boot and refresh agree', () => {
  test('the token boot put in RUNTIME_AUTH_SECRET is the one the route accepts', async () => {
    bootedMembers.set(bootedKey(W, P1), [P1, P2])
    const env = await buildWorkspaceEnv(W, [P1, P2], { anchorProjectId: P1 })
    expect(env.RUNTIME_AUTH_SECRET).toBe(deriveWorkspaceRuntimeToken(W))

    // The boot env's own token is what the refresh replaces. Minting is
    // deterministic (same inputs, same second → same bytes), so what a refresh
    // owes the pod is a *valid* token that expires no earlier than the one it
    // holds — a pod that boots on day 8 gets a live token on its first tick.
    const booted = (await verifyProxyToken(env.AI_PROXY_TOKEN))!
    const res = await app.request(podConfigPath(`ws:proj:${P1}`), {
      headers: { 'x-runtime-token': env.RUNTIME_AUTH_SECRET },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { env: Record<string, string> }
    const refreshed = (await verifyProxyToken(body.env.AI_PROXY_TOKEN))!
    expect(refreshed.projectId).toBe(P1)
    expect(refreshed.workspaceId).toBe(W)
    expect(refreshed.exp).toBeGreaterThanOrEqual(booted.exp)
  })
})
