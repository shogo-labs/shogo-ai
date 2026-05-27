// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Extra tests for src/cli/deploy.ts — targets manifest validator branches
// (tool array entries, voiceId/firstMessage hint) + runDeploy fetchImpl
// fallback paths missed by the original suite.
import { describe, expect, test } from 'bun:test'
import { validateManifest, runDeploy } from '../deploy.js'

describe('validateManifest — tool array branches', () => {
  test('flags non-array tools field', () => {
    const out = validateManifest({ a1: { tools: 'not-array' } })
    expect(out.issues.some(i => i.path === 'agents.a1.tools' && /array/.test(i.message))).toBe(true)
  })

  test('flags empty-string tool name', () => {
    const out = validateManifest({ a1: { tools: [''] } })
    expect(out.issues.some(i => i.path === 'agents.a1.tools[0]' && /non-empty/.test(i.message))).toBe(true)
  })

  test('flags duplicate string tool name', () => {
    const out = validateManifest({ a1: { tools: ['x', 'x'] } })
    expect(out.issues.some(i => /duplicate tool name 'x'/.test(i.message))).toBe(true)
  })

  test('flags null/array tool entries', () => {
    const out1 = validateManifest({ a1: { tools: [null] } })
    expect(out1.issues.some(i => /must be a string or/.test(i.message))).toBe(true)
    const out2 = validateManifest({ a2: { tools: [['arr']] as any } })
    expect(out2.issues.some(i => /must be a string or/.test(i.message))).toBe(true)
  })

  test('flags tool object missing name', () => {
    const out = validateManifest({ a1: { tools: [{ description: 'x' } as any] } })
    expect(out.issues.some(i => i.path === 'agents.a1.tools[0].name')).toBe(true)
  })

  test('flags tool object with empty name', () => {
    const out = validateManifest({ a1: { tools: [{ name: '' }] } })
    expect(out.issues.some(i => i.path === 'agents.a1.tools[0].name')).toBe(true)
  })

  test('flags duplicate tool name across string + object form', () => {
    const out = validateManifest({ a1: { tools: ['t1', { name: 't1' }] } })
    expect(out.issues.some(i => /duplicate tool name 't1'/.test(i.message))).toBe(true)
  })

  test('flags non-string description', () => {
    const out = validateManifest({ a1: { tools: [{ name: 't', description: 42 as any }] } })
    expect(out.issues.some(i => i.path === 'agents.a1.tools[0].description')).toBe(true)
  })

  test('flags non-object inputSchema (null, array, primitive)', () => {
    const out1 = validateManifest({ a1: { tools: [{ name: 't', inputSchema: null as any }] } })
    expect(out1.issues.some(i => i.path === 'agents.a1.tools[0].inputSchema')).toBe(true)
    const out2 = validateManifest({ a2: { tools: [{ name: 't', inputSchema: [] as any }] } })
    expect(out2.issues.some(i => i.path === 'agents.a2.tools[0].inputSchema')).toBe(true)
    const out3 = validateManifest({ a3: { tools: [{ name: 't', inputSchema: 'x' as any }] } })
    expect(out3.issues.some(i => i.path === 'agents.a3.tools[0].inputSchema')).toBe(true)
  })

  test('passes through valid tool object with description + inputSchema', () => {
    const out = validateManifest({
      a1: {
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
      },
    })
    expect(out.issues).toEqual([])
    const t0 = (out.agents.a1?.tools as any)?.[0]
    expect(t0).toEqual({ name: 't', description: 'd', inputSchema: { type: 'object' } })
  })

  test('hints when voiceId is set without firstMessage', () => {
    const out = validateManifest({ a1: { voiceId: 'v123' } })
    expect(out.issues.some(i =>
      i.path === 'agents.a1.firstMessage' && /firstMessage/.test(i.message),
    )).toBe(true)
  })

  test('no hint when voiceId AND firstMessage both set', () => {
    const out = validateManifest({ a1: { voiceId: 'v', firstMessage: 'hi' } })
    expect(out.issues.some(i => i.path === 'agents.a1.firstMessage')).toBe(false)
  })

  test('flags non-object agent values (null / array / primitive)', () => {
    const out1 = validateManifest({ a1: null as any })
    expect(out1.issues.some(i => i.path === 'agents.a1' && /object/.test(i.message))).toBe(true)
    const out2 = validateManifest({ a2: [] as any })
    expect(out2.issues.some(i => i.path === 'agents.a2' && /object/.test(i.message))).toBe(true)
    const out3 = validateManifest({ a3: 'string' as any })
    expect(out3.issues.some(i => i.path === 'agents.a3' && /object/.test(i.message))).toBe(true)
  })

  test('flags unknown fields with supported list', () => {
    const out = validateManifest({ a1: { unknownField: 'x' as any } })
    expect(out.issues.some(i => i.path === 'agents.a1.unknownField' && /unknown field/.test(i.message))).toBe(true)
  })

  test('flags non-string scalar fields', () => {
    const out = validateManifest({ a1: { systemPrompt: 123 as any } })
    expect(out.issues.some(i => i.path === 'agents.a1.systemPrompt' && /string/.test(i.message))).toBe(true)
  })
})

describe('runDeploy — fetchImpl branches', () => {
  test('throws when global fetch is missing AND no options.fetchImpl', async () => {
    const origFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = undefined
    try {
      await expect(
        runDeploy({
          apiUrl: 'https://x.example.com',
          projectId: 'p',
          auth: { kind: 'apiKey', apiKey: 'k' },
          manifest: {},
        }),
      ).rejects.toThrow(/global fetch is unavailable/)
    } finally {
      ;(globalThis as any).fetch = origFetch
    }
  })

  test('uses options.fetchImpl when provided + apiKey auth + Bearer header', async () => {
    let captured: any = null
    const fakeFetch = async (url: string, init: any) => {
      captured = { url, init }
      return { status: 200, json: async () => ({ ok: true }) } as any
    }
    const r = await runDeploy({
      apiUrl: 'https://x.example.com/', // trailing slash to exercise strip
      projectId: 'proj/space',          // exercise encodeURIComponent
      auth: { kind: 'apiKey', apiKey: 'secret' },
      manifest: {},
      fetchImpl: fakeFetch as any,
    })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(captured.url).toBe('https://x.example.com/api/projects/proj%2Fspace/agents/sync')
    expect(captured.init.headers.authorization).toBe('Bearer secret')
  })

  test('runtime-token auth sets x-runtime-token header', async () => {
    let captured: any = null
    await runDeploy({
      apiUrl: 'https://x',
      projectId: 'p',
      auth: { kind: 'runtimeToken', token: 'tok' } as any,
      manifest: {},
      fetchImpl: (async (url: string, init: any) => {
        captured = init
        return { status: 200, json: async () => ({}) } as any
      }) as any,
    })
    expect(captured.headers['x-runtime-token']).toBe('tok')
  })

  test('handles non-JSON response body (body=null)', async () => {
    const r = await runDeploy({
      apiUrl: 'https://x',
      projectId: 'p',
      auth: { kind: 'apiKey', apiKey: 'k' },
      manifest: {},
      fetchImpl: (async () => ({
        status: 502,
        json: async () => { throw new Error('not json') },
      })) as any,
    })
    expect(r).toEqual({ status: 502, body: null })
  })

  test('payload includes prune + dryRun when set', async () => {
    let captured: any = null
    await runDeploy({
      apiUrl: 'https://x',
      projectId: 'p',
      auth: { kind: 'apiKey', apiKey: 'k' },
      manifest: { agent1: { systemPrompt: 's' } },
      prune: true,
      dryRun: true,
      fetchImpl: (async (_url: string, init: any) => {
        captured = JSON.parse(init.body)
        return { status: 200, json: async () => ({}) } as any
      }) as any,
    })
    expect(captured.prune).toBe(true)
    expect(captured.dryRun).toBe(true)
    expect(captured.agents.agent1?.systemPrompt).toBe('s')
  })
})
