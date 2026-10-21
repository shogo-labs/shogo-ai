// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The capability pull is scoped to the project this gateway serves.
 *
 * A process that carries the runtime env (`PROJECT_ID` + `RUNTIME_AUTH_SECRET`)
 * used to sync capabilities for whatever `PROJECT_ID` said into whatever
 * `config.json` the gateway happened to own — so a test started on a fixture id
 * wrote a live project's settings over its own scratch config (SHO-102). These
 * tests pin the guard: a foreign id never reaches the network and never touches
 * the file, while a matching id, a pool runtime and an explicit fetcher all
 * still apply settings.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentGateway } from '../gateway'

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

function snapshotEnv(): SavedEnv {
  const saved: SavedEnv = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

describe('syncCapabilitiesFromApi scope', () => {
  let saved: SavedEnv
  let dirs: string[] = []
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    saved = snapshotEnv()
    originalFetch = globalThis.fetch
    // Start from a bare env so the test asserts the same thing in CI and in an
    // agent shell that carries PROJECT_ID / RUNTIME_AUTH_SECRET / AI_PROXY_URL.
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv(saved)
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
  })

  function scratchWorkspace(): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'capability-sync-scope-'))
    dirs.push(dir)
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      channelsEnabled: false,
      integrationsEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }, null, 2))
    writeFileSync(join(dir, 'AGENTS.md'), '# Identity\nScope Test\n')
    return { dir, configPath }
  }

  function gatewayEnv(): void {
    process.env.RUNTIME_AUTH_SECRET = 'test-runtime-secret'
    process.env.SHOGO_API_URL = 'http://api.test.invalid'
  }

  /** A fetch that records the request and answers with `body`. */
  function stubFetch(body: unknown): { calls: string[] } {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    return { calls }
  }

  test('a foreign project id never reaches the network or the config file', async () => {
    const { dir, configPath } = scratchWorkspace()
    const decoyWorkspace = mkdtempSync(join(tmpdir(), 'capability-sync-decoy-'))
    dirs.push(decoyWorkspace)

    gatewayEnv()
    process.env.PROJECT_ID = 'someone-elses-project'
    process.env.AI_PROXY_URL = 'http://127.0.0.1:9/api/ai/v1'
    process.env.WORKSPACE_DIR = decoyWorkspace

    const gateway = new AgentGateway(dir, 'test-project')
    const fetched: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      throw new Error('the scoped sync must not call the API')
    }) as unknown as typeof globalThis.fetch

    const before = readFileSync(configPath, 'utf-8')
    try {
      expect(await gateway.syncCapabilitiesFromApi()).toBe(false)
      expect(fetched).toEqual([])
      expect(readFileSync(configPath, 'utf-8')).toBe(before)
    } finally {
      await gateway.stop()
    }
  })

  test('a matching project id still applies the database settings', async () => {
    const { dir, configPath } = scratchWorkspace()
    gatewayEnv()
    process.env.PROJECT_ID = 'proj-scope-match'

    const gateway = new AgentGateway(dir, 'proj-scope-match')
    const { calls } = stubFetch({ project: { settings: { socialMediaEnabled: true } } })
    try {
      expect(await gateway.syncCapabilitiesFromApi()).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('/api/internal/projects/proj-scope-match/config')
      const file = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(file.socialMediaEnabled).toBe(true)
    } finally {
      await gateway.stop()
    }
  })

  test('a pool runtime keeps syncing the project the env hands it', async () => {
    const { dir, configPath } = scratchWorkspace()
    gatewayEnv()
    process.env.PROJECT_ID = 'proj-pooled'

    const gateway = new AgentGateway(dir, '__POOL__')
    const { calls } = stubFetch({ project: { settings: { socialMediaEnabled: true } } })
    try {
      expect(await gateway.syncCapabilitiesFromApi()).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('/api/internal/projects/proj-pooled/config')
      const file = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(file.socialMediaEnabled).toBe(true)
    } finally {
      await gateway.stop()
    }
  })

  test('a workspace runtime writes nothing for a project it does not serve', async () => {
    const { dir, configPath } = scratchWorkspace()
    const runtimeWorkspace = mkdtempSync(join(tmpdir(), 'capability-sync-own-'))
    dirs.push(runtimeWorkspace)

    gatewayEnv()
    process.env.PROJECT_ID = 'someone-elses-project'
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-scope'
    process.env.WORKSPACE_DIR = runtimeWorkspace
    process.env.AI_PROXY_URL = 'http://127.0.0.1:9/api/ai/v1'

    const gateway = new AgentGateway(dir, 'test-project')
    const fetched: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      throw new Error('neither pull may reach the API from a foreign dir')
    }) as unknown as typeof globalThis.fetch

    const before = readFileSync(configPath, 'utf-8')
    try {
      expect(await gateway.syncCapabilitiesFromApi()).toBe(false)
      expect(fetched).toEqual([])
      expect(readFileSync(configPath, 'utf-8')).toBe(before)
    } finally {
      await gateway.stop()
    }
  })

  test('the runtime’s own workspace dir still pulls the workspace settings', async () => {
    const { dir, configPath } = scratchWorkspace()
    gatewayEnv()
    process.env.PROJECT_ID = 'proj-scope-match'
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-scope'
    process.env.WORKSPACE_DIR = dir

    const gateway = new AgentGateway(dir, 'proj-scope-match')
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      const body = url.includes('/api/internal/workspaces/')
        ? { workspace: { settings: { boardsEnabled: true } } }
        : { project: { settings: { socialMediaEnabled: true } } }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    try {
      expect(await gateway.syncCapabilitiesFromApi()).toBe(true)
      expect(calls.some((url) => url.includes('/api/internal/workspaces/ws-scope/config'))).toBe(true)
      const file = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(file.workspaceCapabilities).toMatchObject({ boardsEnabled: true })
    } finally {
      await gateway.stop()
    }
  })

  test('an injected fetcher is honoured even when the env ids disagree', async () => {
    const { dir, configPath } = scratchWorkspace()
    gatewayEnv()
    process.env.PROJECT_ID = 'someone-elses-project'

    const gateway = new AgentGateway(dir, 'test-project')
    const fetched: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      throw new Error('an injected fetcher must replace the network call')
    }) as unknown as typeof globalThis.fetch

    const seen: string[] = []
    try {
      const applied = await gateway.syncCapabilitiesFromApi(async (projectId) => {
        seen.push(projectId)
        return { ok: true, data: { settings: { socialMediaEnabled: true } } }
      })
      expect(applied).toBe(true)
      expect(seen).toHaveLength(1)
      expect(fetched).toEqual([])
      const file = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(file.socialMediaEnabled).toBe(true)
    } finally {
      await gateway.stop()
    }
  })
})
