// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `src/cli/deploy.ts` — the manifest validator and
 * sync-payload builder shared between `bin/shogo.ts` (monorepo dev)
 * and `bin/cli.mjs` (published package).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildSyncPayload,
  normalizeToolEntry,
  runDeploy,
  validateManifest,
  AGENT_NAME_PATTERN,
} from '../deploy'

describe('AGENT_NAME_PATTERN', () => {
  test('accepts kebab/snake case starting with a letter', () => {
    expect(AGENT_NAME_PATTERN.test('default')).toBe(true)
    expect(AGENT_NAME_PATTERN.test('architect')).toBe(true)
    expect(AGENT_NAME_PATTERN.test('voice_admin')).toBe(true)
    expect(AGENT_NAME_PATTERN.test('agent-1')).toBe(true)
  })

  test('rejects names with spaces, capitals, or leading digit', () => {
    expect(AGENT_NAME_PATTERN.test('Bad Name')).toBe(false)
    expect(AGENT_NAME_PATTERN.test('Architect')).toBe(false)
    expect(AGENT_NAME_PATTERN.test('1agent')).toBe(false)
    expect(AGENT_NAME_PATTERN.test('')).toBe(false)
  })
})

describe('validateManifest', () => {
  test('returns empty manifest for null/undefined input', () => {
    expect(validateManifest(undefined)).toEqual({ agents: {}, issues: [] })
    expect(validateManifest(null)).toEqual({ agents: {}, issues: [] })
  })

  test('flags non-object roots', () => {
    const out = validateManifest('nope')
    expect(out.issues).toHaveLength(1)
    expect(out.issues[0]!.path).toBe('agents')
  })

  test('passes through a valid manifest verbatim', () => {
    const out = validateManifest({
      architect: {
        systemPrompt: 'arch',
        tools: ['add_memory', 'lookup_user'],
        model: 'claude-sonnet-4-5',
      },
      narrator: {
        systemPrompt: 'narr',
        voiceId: 'v1',
        firstMessage: 'hello',
        characterName: 'Nora',
      },
    })
    expect(out.issues).toEqual([])
    expect(out.agents.architect).toEqual({
      systemPrompt: 'arch',
      tools: ['add_memory', 'lookup_user'],
      model: 'claude-sonnet-4-5',
    })
    expect(out.agents.narrator!.voiceId).toBe('v1')
  })

  test('warns when voiceId is set without firstMessage', () => {
    const out = validateManifest({
      narrator: { voiceId: 'v1' },
    })
    // The warning is non-blocking but is reported in `issues` so the
    // CLI can surface it to the user.
    expect(out.issues.some((i) => i.path === 'agents.narrator.firstMessage')).toBe(
      true,
    )
    // The agent itself is still emitted.
    expect(out.agents.narrator).toBeDefined()
  })

  test('rejects bad agent names with a per-name issue', () => {
    const out = validateManifest({ 'Bad Name': {} })
    expect(out.issues[0]!.path).toBe('agents.Bad Name')
    expect(out.agents['Bad Name']).toBeUndefined()
  })

  test('flags unknown fields', () => {
    const out = validateManifest({ architect: { foo: 'bar' } })
    expect(out.issues.some((i) => i.path === 'agents.architect.foo')).toBe(
      true,
    )
  })

  test('rejects non-string-array tools', () => {
    const out = validateManifest({
      architect: { tools: ['ok', 1, 'also_ok'] as unknown as string[] },
    })
    expect(out.issues.some((i) => i.path === 'agents.architect.tools[1]')).toBe(
      true,
    )
  })

  test('accepts inline tool descriptors with schemas', () => {
    const out = validateManifest({
      architect: {
        tools: [
          'add_memory',
          {
            name: 'lookup_user',
            description: 'Find a user by id',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ],
      },
    })
    expect(out.issues).toEqual([])
    const tools = out.agents.architect!.tools!
    expect(tools).toHaveLength(2)
    expect(tools[0]).toBe('add_memory')
    expect(tools[1]).toEqual({
      name: 'lookup_user',
      description: 'Find a user by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    })
  })

  test('rejects duplicate tool names regardless of form', () => {
    const out = validateManifest({
      architect: {
        tools: ['add_memory', { name: 'add_memory', description: 'dup' }],
      },
    })
    expect(out.issues.some((i) => i.message.includes("duplicate"))).toBe(true)
    expect(out.agents.architect?.tools).toBeUndefined()
  })

  test('flags missing tool name on inline descriptor', () => {
    const out = validateManifest({
      architect: { tools: [{ description: 'no name' } as unknown as string] },
    })
    expect(out.issues.some((i) => i.path === 'agents.architect.tools[0].name')).toBe(true)
  })

  test('rejects non-object inputSchema', () => {
    const out = validateManifest({
      architect: {
        tools: [{ name: 'x', inputSchema: 'not-an-object' as unknown as Record<string, unknown> }],
      },
    })
    expect(
      out.issues.some((i) => i.path === 'agents.architect.tools[0].inputSchema'),
    ).toBe(true)
  })
})

describe('normalizeToolEntry', () => {
  test('expands string sugar to { name }', () => {
    expect(normalizeToolEntry('add_memory')).toEqual({ name: 'add_memory' })
  })

  test('passes through full descriptors verbatim', () => {
    expect(
      normalizeToolEntry({
        name: 'x',
        description: 'd',
        inputSchema: { type: 'object' },
      }),
    ).toEqual({ name: 'x', description: 'd', inputSchema: { type: 'object' } })
  })
})

describe('buildSyncPayload', () => {
  test('normalizes string-sugar tools to { name } descriptors', () => {
    const payload = buildSyncPayload({
      manifest: {
        architect: { systemPrompt: 'a', tools: ['x'] },
        narrator: { voiceId: 'v1', firstMessage: 'hi' },
      },
      prune: true,
      dryRun: false,
    })
    expect(payload).toEqual({
      agents: {
        architect: { systemPrompt: 'a', tools: [{ name: 'x' }] },
        narrator: { voiceId: 'v1', firstMessage: 'hi' },
      },
      prune: true,
      dryRun: false,
    })
  })

  test('forwards inline descriptors verbatim', () => {
    const payload = buildSyncPayload({
      manifest: {
        architect: {
          tools: [
            'add_memory',
            { name: 'lookup_user', description: 'd', inputSchema: { type: 'object' } },
          ],
        },
      },
      prune: false,
      dryRun: false,
    })
    expect(payload.agents.architect!.tools).toEqual([
      { name: 'add_memory' },
      { name: 'lookup_user', description: 'd', inputSchema: { type: 'object' } },
    ])
  })

  test('forwards prune + dryRun verbatim', () => {
    const out = buildSyncPayload({
      manifest: {},
      prune: false,
      dryRun: true,
    })
    expect(out).toEqual({ agents: {}, prune: false, dryRun: true })
  })
})

describe('runDeploy', () => {
  test('POSTs to the right URL with the right headers + body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({ created: ['architect'], dryRun: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await runDeploy({
      apiUrl: 'https://api.shogo.ai/',
      projectId: 'p_xyz',
      shogoApiKey: 'shogo_sk_test',
      manifest: { architect: { systemPrompt: 'arch' } },
      prune: false,
      dryRun: false,
      fetchImpl,
    })

    expect(result.status).toBe(200)
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe('https://api.shogo.ai/api/projects/p_xyz/agents/sync')
    const headers = (init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer shogo_sk_test')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body.agents.architect).toEqual({ systemPrompt: 'arch' })
    expect(body.prune).toBe(false)
    expect(body.dryRun).toBe(false)
  })

  test('returns the parsed body on a non-2xx response without throwing', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const out = await runDeploy({
      apiUrl: 'http://api',
      projectId: 'p',
      shogoApiKey: 'k',
      manifest: {},
      prune: false,
      dryRun: false,
      fetchImpl,
    })
    expect(out.status).toBe(403)
    expect((out.body as any).error.code).toBe('forbidden')
  })

  test('auth: { kind: "apiKey" } sets Authorization: Bearer + omits runtime token header', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await runDeploy({
      apiUrl: 'http://api',
      projectId: 'p',
      manifest: {},
      prune: false,
      dryRun: false,
      auth: { kind: 'apiKey', apiKey: 'shogo_sk_xyz' },
      fetchImpl,
    })
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer shogo_sk_xyz')
    expect('x-runtime-token' in headers).toBe(false)
  })

  test('auth: { kind: "runtimeToken" } sets x-runtime-token + omits Authorization', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await runDeploy({
      apiUrl: 'http://api',
      projectId: 'p',
      manifest: {},
      prune: false,
      dryRun: false,
      auth: { kind: 'runtimeToken', token: 'rt_xyz' },
      fetchImpl,
    })
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>
    expect(headers['x-runtime-token']).toBe('rt_xyz')
    expect('authorization' in headers).toBe(false)
  })

  test('throws when neither auth nor legacy shogoApiKey is supplied', async () => {
    const fetchImpl = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(
      runDeploy({
        apiUrl: 'http://api',
        projectId: 'p',
        manifest: {},
        prune: false,
        dryRun: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/missing auth/)
  })
})
