// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for a production incident: a project's canvas preview
 * stopped rebuilding and internal calls made *by* the agent runtime
 * (heartbeat config, the webchat widget embed URL, Composio session init,
 * ...) were rejected by the API with:
 *
 *   [InternalAuth] rejected: runtime_token_project_mismatch
 *     tokenProject=<real-project-id> projectId=__POOL__
 *
 * despite the runtime otherwise working fine (chat streamed, files got
 * edited and committed) for the correct project the whole time.
 *
 * Root cause (fixed): `AgentGateway.projectId` used to be a plain field
 * captured ONCE, by value, in the constructor:
 *
 *   constructor(workspaceDir: string, projectId: string) {
 *     this.projectId = projectId
 *   }
 *
 * and was never reassigned anywhere else in the class. Every outbound call
 * that needs "which project am I" for its URL path (e.g.
 * `updateHeartbeatConfig`'s `PUT .../heartbeat/config/${this.projectId}`,
 * gateway-tools.ts's webchat widget URL, Composio session init) used this
 * frozen value for the lifetime of the process.
 *
 * Meanwhile, the *authentication* for those same calls
 * (`getInternalHeaders()` in internal-api.ts) reads
 * `process.env.RUNTIME_AUTH_SECRET` live, on every call — which DOES get
 * refreshed by `/pool/assign` and `/pool/refresh-env` (see
 * packages/shared-runtime/src/server-framework.ts).
 *
 * If `AgentGateway` was ever constructed while the runtime's project
 * identity was still the warm-pool placeholder (`__POOL__` —
 * `POOL_PROJECT_ID` in server-framework.ts) — e.g. because
 * `startGateway()` read `state.currentProjectId!` around a pool-assign
 * race, or a suspended snapshot froze the gateway before promotion
 * completed — the gateway was permanently poisoned: its URL-building code
 * said `__POOL__` forever, while its auth-header code correctly (and
 * independently) reflected whatever project the env was later, correctly,
 * assigned to. The two could never resync because nothing in the class
 * ever updated `this.projectId`. Confirmed live in production for project
 * 2945c130-6774-4409-8239-f29ee1ffa299 (7 rejected heartbeat calls over
 * ~1 hour, starting the same minute its canvas preview build froze).
 *
 * Fix: `projectId` is now a getter that prefers the live
 * `process.env.PROJECT_ID` (kept fresh by `/pool/assign` /
 * `/pool/refresh-env`) over the value snapshotted at construction —
 * mirroring the pattern already used by checkpoint recording and
 * `getInternalHeaders()`. This test drives a real turn (mocked LLM) that
 * calls the real `heartbeat_configure` tool and asserts the outbound
 * request's URL and auth token now agree.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildToolUseResponse, buildTextResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/test-gateway-stale-pool-projectid'
const POOL_PROJECT_ID = '__POOL__' // mirrors server-framework.ts's POOL_PROJECT_ID
const REAL_PROJECT_ID = '2945c130-6774-4409-8239-f29ee1ffa299'

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      // Must be enabled or `filterDisabledCapabilityTools` strips
      // heartbeat_configure/heartbeat_status before the LLM ever sees them.
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(
    join(TEST_DIR, 'AGENTS.md'),
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTest User\n\n# Operating Instructions\nYou are a test agent.',
  )
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\nTest memory.')
}

describe('AgentGateway project identity survives a pool-assign race (regression)', () => {
  let gateway: AgentGateway
  let fetchSpy: ReturnType<typeof spyOn>
  const originalEnv = { ...process.env }

  beforeEach(() => {
    setupWorkspace()
    process.env.SHOGO_API_URL = 'https://api.internal.test'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    fetchSpy?.mockRestore()
    rmSync(TEST_DIR, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  test('projectId prefers live process.env.PROJECT_ID over the value captured at construction', () => {
    // Simulates `agentGateway = new AgentGateway(WORKSPACE_DIR,
    // state.currentProjectId!)` (server.ts) firing while
    // `state.currentProjectId` was still the pool placeholder.
    gateway = new AgentGateway(TEST_DIR, POOL_PROJECT_ID)

    // The runtime is then correctly assigned — `/pool/assign` (or a later
    // `/pool/refresh-env`) updates process.env exactly like production
    // does (server-framework.ts sets PROJECT_ID + injects RUNTIME_AUTH_SECRET).
    process.env.PROJECT_ID = REAL_PROJECT_ID
    process.env.RUNTIME_AUTH_SECRET = `rt_v1_${REAL_PROJECT_ID}_deadbeefcafebabe`

    // The gateway's identity must track the live env, not the
    // construction-time snapshot.
    expect((gateway as any).projectId).toBe(REAL_PROJECT_ID)
  })

  test('falls back to the constructed value when PROJECT_ID env is unset (local/eval/test contexts)', () => {
    delete process.env.PROJECT_ID
    gateway = new AgentGateway(TEST_DIR, 'my-local-project')
    expect((gateway as any).projectId).toBe('my-local-project')
  })

  test('a real turn calling heartbeat_configure sends a request whose URL and auth token agree on the real project', async () => {
    gateway = new AgentGateway(TEST_DIR, POOL_PROJECT_ID)

    // Correct, live assignment happens on the SAME long-lived process
    // *after* the gateway object already exists — exactly the production
    // sequence (chat kept working the whole time because the AI proxy and
    // everything else reads process.env fresh).
    process.env.PROJECT_ID = REAL_PROJECT_ID
    process.env.RUNTIME_AUTH_SECRET = `rt_v1_${REAL_PROJECT_ID}_deadbeefcafebabe`

    const captured: { url: string; headers: Record<string, string> }[] = []
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/internal/heartbeat/config/')) {
        captured.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([
        { name: 'heartbeat_configure', arguments: { enabled: true, interval: 1200 }, id: 'toolu_1' },
      ]),
      buildTextResponse('Heartbeat configured.'),
    ])
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processChatMessage('Turn on the heartbeat every 20 minutes')

    expect(captured.length).toBe(1)
    const { url, headers } = captured[0]

    // The URL path segment now reflects the live-assigned project, not the
    // pool placeholder captured at construction...
    expect(url).toBe(`https://api.internal.test/api/internal/heartbeat/config/${REAL_PROJECT_ID}`)

    // ...and agrees with the auth token sent alongside it. Before the fix,
    // this URL was pinned to `__POOL__` forever, which apps/api/src/routes
    // /internal.ts's authenticate() rejects as
    // `runtime_token_project_mismatch tokenProject=<real> projectId=__POOL__`
    // even though the token is legitimately signed for the real project.
    const token = headers['x-runtime-token']
    const urlProjectId = url.split('/heartbeat/config/')[1]
    const tokenProjectId = token.split('_').slice(2, -1).join('_') // rt_v1_<projectId>_<hex>
    expect(urlProjectId).toBe(tokenProjectId)
    expect(urlProjectId).toBe(REAL_PROJECT_ID)
  })
})
