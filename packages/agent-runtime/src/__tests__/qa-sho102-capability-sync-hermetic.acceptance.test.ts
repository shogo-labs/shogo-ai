// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-102 acceptance — a gateway never pulls another project's capabilities.
 *
 * The unit test (`capability-sync-scope.test.ts`) pins the predicate. This one
 * drives the production entry points instead: `start()` (gateway.ts) and the
 * first turn. A runtime shell — every agent pod, every dev running tests in the
 * app's terminal — carries `PROJECT_ID` + `RUNTIME_AUTH_SECRET` + `AI_PROXY_URL`,
 * so a gateway built on a fixture id used to fetch the live project's settings
 * over its own scratch `config.json` and silently turn capabilities back on.
 *
 * The canary is `capabilities-guide-toggles.test.ts` (2 pass / 2 fail on main,
 * 4/4 here); these cases name the promise end to end: a foreign project or
 * workspace never writes into the file, and a project this runtime does serve
 * is still synced (so the guard cannot be satisfied by disabling the sync).
 *
 * One unrelated read is expected and harmless: `start()` also calls
 * `refreshHeartbeatSnapshot()`, which GETs the same `/projects/<id>/config` URL
 * for the status output and never writes `config.json`. Hence "at most one
 * project-config read, and it changes nothing" rather than "zero network".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const ENV_KEYS = [
  'PROJECT_ID',
  'WORKSPACE_ANCHOR_PROJECT_ID',
  'WORKSPACE_RUNTIME',
  'WORKSPACE_ID',
  'WORKSPACE_DIR',
  'WORKSPACE_KIND',
  'RUNTIME_AUTH_SECRET',
  'AI_PROXY_URL',
  'SHOGO_API_URL',
  'API_URL',
] as const

type SavedEnv = Record<string, string | undefined>

describe('SHO-102 acceptance — the capability pull is scoped to what this runtime serves', () => {
  let saved: SavedEnv
  let originalFetch: typeof globalThis.fetch
  let dirs: string[]
  let gateway: AgentGateway | undefined

  beforeEach(() => {
    saved = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    originalFetch = globalThis.fetch
    dirs = []
    gateway = undefined
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
    globalThis.fetch = originalFetch
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function scratchWorkspace(config: Record<string, unknown> = {}): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'qa-sho102-'))
    dirs.push(dir)
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        heartbeatEnabled: false,
        heartbeatInterval: 1800,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        channelsEnabled: false,
        integrationsEnabled: false,
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        ...config,
      }, null, 2),
    )
    writeFileSync(join(dir, 'AGENTS.md'), '# Identity\nQA SCOPE ACCEPTANCE\n\n# Personality\nBe helpful.')
    return { dir, configPath: join(dir, 'config.json') }
  }

  /** A runtime shell: credentials + an API url, exactly what the pod carries. */
  function runtimeShellEnv(): void {
    process.env.RUNTIME_AUTH_SECRET = 'qa-test-runtime-secret'
    process.env.SHOGO_API_URL = 'http://api.qa-test.invalid'
    process.env.AI_PROXY_URL = 'http://127.0.0.1:9/api/ai/v1'
  }

  /**
   * Records every call. Capability reads answer with settings that WOULD flip
   * channels/integrations/boards back on, so an unguarded sync changes the file
   * and the assertion below can see it.
   */
  function spyFetch(): string[] {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      const body = /\/api\/internal\/workspaces\//.test(url)
        ? { workspace: { settings: { boardsEnabled: true, channelsEnabled: true } } }
        : /\/api\/internal\/projects\/[^/]+\/config/.test(url)
          ? { project: { settings: { socialMediaEnabled: true, channelsEnabled: true, integrationsEnabled: true } } }
          : {}
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch
    return calls
  }

  function section(label: string) {
    return (gateway?.lastPromptBreakdown ?? []).find((s) => s.label === label)
  }

  test('start() on a foreign project id writes nothing and keeps the toggles off', async () => {
    const { dir, configPath } = scratchWorkspace()
    const decoy = mkdtempSync(join(tmpdir(), 'qa-sho102-decoy-'))
    dirs.push(decoy)

    runtimeShellEnv()
    process.env.PROJECT_ID = 'proj-someone-elses'
    process.env.WORKSPACE_DIR = decoy

    gateway = new AgentGateway(dir, 'test-project')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    const calls = spyFetch()

    const before = readFileSync(configPath, 'utf-8')
    await gateway.start()
    await gateway.processChatMessage('ping')

    // Nothing asked about the gateway's own fixture project. The `/config`
    // reads that remain are read-only status probes (heartbeat snapshot); the
    // stub answers them with settings that WOULD have rewritten the file had
    // any of them been the capability sync.
    expect(calls.some((url) => url.includes('/api/internal/projects/test-project/config'))).toBe(false)
    // The stranger's settings never landed, so the turn still honors the file.
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
    expect(section('action-tools-guide')).toBeUndefined()
    expect(section('capabilities-index')).toBeDefined()
  })

  test('a gateway on this runtime’s own dir still refuses a foreign project’s settings', async () => {
    const { dir, configPath } = scratchWorkspace()
    runtimeShellEnv()
    process.env.PROJECT_ID = 'proj-someone-elses'
    process.env.WORKSPACE_DIR = dir

    gateway = new AgentGateway(dir, 'test-project')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    const calls = spyFetch()

    const before = readFileSync(configPath, 'utf-8')
    await gateway.start()

    expect(calls.some((url) => url.includes('/api/internal/projects/test-project/config'))).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
    expect(section('action-tools-guide')).toBeUndefined()
  })

  test('a foreign workspace dir syncs neither the workspace overlay nor a project', async () => {
    const { dir, configPath } = scratchWorkspace()
    const decoy = mkdtempSync(join(tmpdir(), 'qa-sho102-decoy-'))
    dirs.push(decoy)

    runtimeShellEnv()
    process.env.PROJECT_ID = 'proj-someone-elses'
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-qa-foreign'
    process.env.WORKSPACE_DIR = decoy

    gateway = new AgentGateway(dir, 'test-project')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    const calls = spyFetch()

    const before = readFileSync(configPath, 'utf-8')
    await gateway.start()

    expect(calls.some((url) => url.includes('/api/internal/workspaces/ws-qa-foreign/config'))).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  test('start() for the project this runtime serves still applies the database settings', async () => {
    const { dir, configPath } = scratchWorkspace({ channels: [], channelsEnabled: false })
    runtimeShellEnv()
    process.env.PROJECT_ID = 'proj-qa-serves'
    process.env.WORKSPACE_DIR = dir

    gateway = new AgentGateway(dir, 'proj-qa-serves')
    gateway.setStreamFn(createMockStreamFn([buildTextResponse('ok')]))
    const calls = spyFetch()

    await gateway.start()

    expect(calls.some((url) => url.includes('/api/internal/projects/proj-qa-serves/config'))).toBe(true)
    const file = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(file.channelsEnabled).toBe(true)
    expect(file.integrationsEnabled).toBe(true)
    expect(file.socialMediaEnabled).toBe(true)
  })
})
