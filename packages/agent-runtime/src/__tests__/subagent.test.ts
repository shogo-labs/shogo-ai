// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Phase 2 coverage for subagent.ts — helpers + runSubagent core paths.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Module mocks (set up BEFORE importing the SUT) ------------------------

let runAgentLoopImpl: (...args: any[]) => Promise<any> = async () => ({
  text: 'final',
  toolCalls: [],
  iterations: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  newMessages: [],
  effectiveModelId: 'sonnet',
  maxIterationsExhausted: false,
  loopBreak: false,
})

mock.module('../agent-loop', () => ({
  runAgentLoop: (...args: any[]) => runAgentLoopImpl(...args),
}))

mock.module('../gateway-tools', () => ({
  createBrowserTool: (_ctx: any) => ({ name: 'browser', execute: async () => ({ content: [], details: {} }) }),
  textResult: (data: any) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }),
}))

let fetchImpl: (...args: any[]) => Promise<Response> = async () =>
  new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
const realFetch = globalThis.fetch
;(globalThis as any).fetch = (...args: any[]) => fetchImpl(...args)

import {
  getBuiltinSubagentConfig,
  loadCustomAgents,
  resolveModelTier,
  filterIncompleteToolCalls,
  createAgentId,
  clearSubagentOverrideCache,
  fetchSubagentOverrideFromApi,
  resolveSubagentModel,
  runSubagent,
  runSubagentsParallel,
} from '../subagent'

afterEach(() => {
  clearSubagentOverrideCache()
})

// --- getBuiltinSubagentConfig ---------------------------------------------

describe('getBuiltinSubagentConfig', () => {
  const cases = [
    'explore', 'general-purpose', 'code-reviewer', 'browser',
    'browser_qa', 'channel', 'media', 'devops',
  ] as const

  for (const name of cases) {
    it(`returns a config for "${name}"`, () => {
      const cfg = getBuiltinSubagentConfig(name, {} as any, [])
      expect(cfg).not.toBeNull()
      expect(cfg!.name).toBe(name)
      expect(cfg!.systemPrompt.length).toBeGreaterThan(0)
    })
  }

  it('returns null for an unknown type', () => {
    expect(getBuiltinSubagentConfig('mystery', {} as any, [])).toBeNull()
  })

  it('explore is haiku + 5 turns + readonly tool set', () => {
    const cfg = getBuiltinSubagentConfig('explore', {} as any, [])!
    expect(cfg.model).toBe('claude-haiku-4-5')
    expect(cfg.maxTurns).toBe(5)
    expect(cfg.toolNames).toContain('read_file')
    expect(cfg.disallowedTools).toContain('task')
  })

  it('browser_qa uses an OpenAI provider', () => {
    const cfg = getBuiltinSubagentConfig('browser_qa', {} as any, [])!
    expect(cfg.provider).toBe('openai')
  })
})

// --- loadCustomAgents + parseAgentFrontmatter -----------------------------

describe('loadCustomAgents', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cust-agents-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns [] when .shogo/agents is missing', () => {
    expect(loadCustomAgents(dir)).toEqual([])
  })

  it('returns [] for an empty agents dir', () => {
    mkdirSync(join(dir, '.shogo/agents'), { recursive: true })
    expect(loadCustomAgents(dir)).toEqual([])
  })

  it('ignores non-md files', () => {
    mkdirSync(join(dir, '.shogo/agents'), { recursive: true })
    writeFileSync(join(dir, '.shogo/agents/notes.txt'), 'not a yaml file')
    expect(loadCustomAgents(dir)).toEqual([])
  })

  it('parses a well-formed frontmatter file', () => {
    mkdirSync(join(dir, '.shogo/agents'), { recursive: true })
    writeFileSync(
      join(dir, '.shogo/agents/reviewer.md'),
      `---
name: reviewer
description: "code review buddy"
tools: [read_file, search]
model: sonnet
maxTurns: 8
---
You are a careful reviewer.`,
    )
    const out = loadCustomAgents(dir)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('reviewer')
    expect(out[0].description).toBe('code review buddy')
    expect(out[0].tools).toEqual(['read_file', 'search'])
    expect(out[0].model).toBe('sonnet')
    expect(out[0].maxTurns).toBe(8)
    expect(out[0].systemPrompt).toContain('careful reviewer')
  })

  it('skips files missing name or description', () => {
    mkdirSync(join(dir, '.shogo/agents'), { recursive: true })
    writeFileSync(
      join(dir, '.shogo/agents/incomplete.md'),
      '---\nname: only-name\n---\nbody',
    )
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(loadCustomAgents(dir)).toEqual([])
    } finally {
      console.warn = warn
    }
  })

  it('records files without frontmatter as raw systemPrompt (still skipped due to missing name)', () => {
    mkdirSync(join(dir, '.shogo/agents'), { recursive: true })
    writeFileSync(join(dir, '.shogo/agents/raw.md'), 'just a body, no frontmatter')
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(loadCustomAgents(dir)).toEqual([])
    } finally {
      console.warn = warn
    }
  })
})

// --- resolveModelTier ------------------------------------------------------

describe('resolveModelTier', () => {
  it('returns parent when tier is undefined', () => {
    expect(resolveModelTier(undefined, 'parent-model')).toBe('parent-model')
  })

  it('returns parent when tier is "default"', () => {
    expect(resolveModelTier('default', 'parent-model')).toBe('parent-model')
  })

  it('returns the fast tier model', () => {
    expect(resolveModelTier('fast', 'parent-model')).toBe('claude-haiku-4-5')
  })

  it('returns the capable tier model', () => {
    expect(resolveModelTier('capable', 'parent-model')).toBe('claude-sonnet-4-6')
  })

  it('falls back to parent for unrecognized tiers', () => {
    expect(resolveModelTier('bogus' as any, 'parent-model')).toBe('parent-model')
  })
})

// --- filterIncompleteToolCalls --------------------------------------------

describe('filterIncompleteToolCalls', () => {
  it('returns [] for an empty list', () => {
    expect(filterIncompleteToolCalls([])).toEqual([])
  })

  it('keeps messages with no tool-call content', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ] as any[]
    expect(filterIncompleteToolCalls(msgs)).toEqual(msgs)
  })

  it('keeps assistant tool-calls when results are present', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1' }, { type: 'text', text: 'going' }],
      },
      { role: 'toolResult', toolCallId: 'tc1', content: 'ok' },
    ] as any[]
    expect(filterIncompleteToolCalls(msgs)).toHaveLength(2)
  })

  it('drops assistant tool-calls without a matching result', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc1' }],
      },
      { role: 'user', content: 'continue' },
    ] as any[]
    const out = filterIncompleteToolCalls(msgs)
    expect(out).toHaveLength(1)
    expect((out[0] as any).role).toBe('user')
  })

  it('preserves messages whose tool calls are partially complete (drops only orphaned)', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc1' }] },
      { role: 'toolResult', toolCallId: 'tc1', content: 'ok' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tc2' }] },
    ] as any[]
    const out = filterIncompleteToolCalls(msgs)
    expect(out).toHaveLength(2)
  })
})

// --- createAgentId ---------------------------------------------------------

describe('createAgentId', () => {
  it('uses "agent" as the default label', () => {
    expect(createAgentId()).toMatch(/^a-agent-[0-9a-f]{16}$/)
  })

  it('sanitizes special characters and truncates to 20 chars', () => {
    const id = createAgentId('Code Reviewer / Risk!!!')
    expect(id).toMatch(/^a-[a-z0-9-]{1,20}-[0-9a-f]{16}$/)
  })

  it('produces unique ids', () => {
    const a = createAgentId('x')
    const b = createAgentId('x')
    expect(a).not.toBe(b)
  })
})

// --- fetchSubagentOverrideFromApi -----------------------------------------

describe('fetchSubagentOverrideFromApi', () => {
  beforeEach(() => {
    clearSubagentOverrideCache()
    // Make sure deriveApiUrl returns something
    process.env.SHOGO_API_URL = 'https://api.test'
    fetchImpl = async () => new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
  })
  afterEach(() => {
    delete process.env.SHOGO_API_URL
  })

  it('returns null override on a 200 with empty body', async () => {
    const r = await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(r.override).toBeNull()
    expect(r.experiment).toBeNull()
  })

  it('returns override + experiment from the response body', async () => {
    fetchImpl = async () => new Response(JSON.stringify({
      override: { model: 'opus', provider: 'anthropic', source: 'project' },
      experiment: { experimentId: 'e1', model: 'sonnet', variant: 'A' },
    }), { status: 200 })
    const r = await fetchSubagentOverrideFromApi('explore', 'w1', 'p1', 'bucket')
    expect(r.override?.model).toBe('opus')
    expect(r.experiment?.experimentId).toBe('e1')
  })

  it('returns null when the API responds non-2xx', async () => {
    fetchImpl = async () => new Response('boom', { status: 500 })
    const r = await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(r.override).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    fetchImpl = async () => { throw new Error('network down') }
    const r = await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(r.override).toBeNull()
  })

  it('caches the override result across calls (no bucketKey)', async () => {
    let calls = 0
    fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({
        override: { model: 'opus', provider: null, source: 'workspace' },
        experiment: null,
      }), { status: 200 })
    }
    await fetchSubagentOverrideFromApi('explore', 'w1', null)
    await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(calls).toBe(1)
  })

  it('bypasses the cache when bucketKey is provided', async () => {
    let calls = 0
    fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
    }
    await fetchSubagentOverrideFromApi('explore', 'w1', null, 'b1')
    await fetchSubagentOverrideFromApi('explore', 'w1', null, 'b2')
    expect(calls).toBe(2)
  })
})

// --- resolveSubagentModel --------------------------------------------------

describe('resolveSubagentModel', () => {
  beforeEach(() => {
    clearSubagentOverrideCache()
    process.env.SHOGO_API_URL = 'https://api.test'
    fetchImpl = async () => new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
  })
  afterEach(() => { delete process.env.SHOGO_API_URL })

  it('honors an explicit caller-supplied model first', async () => {
    const r = await resolveSubagentModel('explore', 'w', null, 'opus', 'anthropic', 'haiku', undefined)
    expect(r.source).toBe('explicit')
    expect(r.model).toBe('opus')
    expect(r.provider).toBe('anthropic')
  })

  it('falls back to builtin when no workspace and no explicit', async () => {
    const r = await resolveSubagentModel('explore', null, null, undefined, undefined, 'haiku', 'anthropic')
    expect(r.source).toBe('builtin')
    expect(r.model).toBe('haiku')
  })

  it('uses an override from the API when present', async () => {
    fetchImpl = async () => new Response(JSON.stringify({
      override: { model: 'opus', provider: 'anthropic', source: 'project' },
      experiment: null,
    }), { status: 200 })
    const r = await resolveSubagentModel('explore', 'w1', 'p1', undefined, undefined, 'haiku', 'anthropic')
    expect(r.source).toBe('project')
    expect(r.model).toBe('opus')
  })

  it('honors an experiment assignment when no override is set', async () => {
    fetchImpl = async () => new Response(JSON.stringify({
      override: null,
      experiment: { experimentId: 'e1', model: 'sonnet', variant: 'B' },
    }), { status: 200 })
    const r = await resolveSubagentModel('explore', 'w1', null, undefined, undefined, 'haiku', 'anthropic', 'bkt')
    expect(r.source).toBe('experiment')
    expect(r.experimentVariant).toBe('B')
    expect(r.model).toBe('sonnet')
  })
})

// --- runSubagent — core paths ---------------------------------------------

function makeCtx(over: Partial<any> = {}): any {
  return {
    workspaceDir: '/tmp/ws',
    fileStateCache: undefined,
    sessionId: 's1',
    projectId: null,
    effectiveModel: 'parent-model',
    config: { model: { name: 'parent-model', provider: 'anthropic' } },
    autoRouting: false,
    toolMockFns: undefined,
    sessionPersistence: undefined,
    uiWriter: undefined,
    ...over,
  }
}

describe('runSubagent — success paths', () => {
  beforeEach(() => {
    runAgentLoopImpl = async () => ({
      text: 'done',
      toolCalls: [{ name: 'read_file' }],
      iterations: 2,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      newMessages: [{ role: 'assistant', content: 'done' }],
      effectiveModelId: 'parent-model',
      maxIterationsExhausted: false,
      loopBreak: false,
    })
  })

  it('runs a builtin config and emits onStart/onEnd', async () => {
    const cfg = getBuiltinSubagentConfig('explore', makeCtx(), [])!
    const events: string[] = []
    const result = await runSubagent(cfg, 'explore the code', makeCtx(), [], {
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
      onModelResolved: () => events.push('model'),
    })
    expect(result.responseText).toBe('done')
    expect(result.toolCalls).toBe(1)
    expect(result.iterations).toBe(2)
    expect(result.responseEmpty).toBe(false)
    expect(events).toEqual(['start', 'model', 'end'])
  })

  it('filters tools by config.toolNames', async () => {
    let observedTools: any[] = []
    runAgentLoopImpl = async (opts: any) => {
      observedTools = opts.tools
      return {
        text: 'ok', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: 'm',
      }
    }
    const allTools = [
      { name: 'read_file', execute: async () => ({}) },
      { name: 'write_file', execute: async () => ({}) },
      { name: 'exec', execute: async () => ({}) },
    ] as any[]
    const cfg = {
      name: 'custom',
      description: 'd',
      systemPrompt: 's',
      toolNames: ['read_file', 'exec'],
    } as any
    await runSubagent(cfg, 'p', makeCtx(), allTools)
    expect(observedTools.map(t => t.name).sort()).toEqual(['exec', 'read_file'])
  })

  it('strips orchestration tools (task, agent_*)', async () => {
    let observed: any[] = []
    runAgentLoopImpl = async (opts: any) => {
      observed = opts.tools
      return { text: 'ok', toolCalls: [], iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, newMessages: [], effectiveModelId: 'm' }
    }
    const allTools = [
      { name: 'read_file', execute: async () => ({}) },
      { name: 'task', execute: async () => ({}) },
      { name: 'agent_spawn', execute: async () => ({}) },
    ] as any[]
    const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
    await runSubagent(cfg, 'p', makeCtx(), allTools)
    const names = observed.map(t => t.name)
    expect(names).not.toContain('task')
    expect(names).not.toContain('agent_spawn')
    expect(names).toContain('read_file')
  })

  it('honors readonly mode by stripping unsafe tools', async () => {
    let observed: any[] = []
    runAgentLoopImpl = async (opts: any) => {
      observed = opts.tools
      return { text: 'ok', toolCalls: [], iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, newMessages: [], effectiveModelId: 'm' }
    }
    const allTools = [
      { name: 'read_file', execute: async () => ({}) },
      { name: 'write_file', execute: async () => ({}) },
      { name: 'todo_write', execute: async () => ({}) },
      { name: 'ask_user', execute: async () => ({}) },
    ] as any[]
    const cfg = { name: 'c', description: 'd', systemPrompt: 's', readonly: true } as any
    await runSubagent(cfg, 'p', makeCtx(), allTools)
    const names = observed.map(t => t.name).sort()
    expect(names).toContain('read_file')
    expect(names).toContain('todo_write')
    expect(names).toContain('ask_user')
    expect(names).not.toContain('write_file')
  })

  it('uses parent system prompt + history in fork mode', async () => {
    let observed: any = {}
    runAgentLoopImpl = async (opts: any) => {
      observed = opts
      return { text: 'forked', toolCalls: [], iterations: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, newMessages: [], effectiveModelId: 'm' }
    }
    const cfg = { name: 'fork', description: 'd', systemPrompt: 'unused' } as any
    const forkParent = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'world' },
    ] as any[]
    const result = await runSubagent(cfg, 'task', makeCtx(), [], undefined, {
      forkContext: {
        systemPrompt: 'PARENT-SYS',
        parentMessages: forkParent,
        parentTools: [{ name: 'read_file', execute: async () => ({}) } as any],
        thinkingLevel: 'high',
      },
    })
    expect(result.responseText).toBe('forked')
    expect(observed.system).toBe('PARENT-SYS')
    expect(observed.thinkingLevel).toBe('high')
    expect(observed.history).toHaveLength(2)
  })

  it('returns an error envelope when runAgentLoop throws', async () => {
    runAgentLoopImpl = async () => { throw new Error('LLM exploded') }
    const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
    const errSpy = console.error
    console.error = () => {}
    try {
      const result = await runSubagent(cfg, 'p', makeCtx(), [])
      expect(result.responseText).toMatch(/Subagent failed: LLM exploded/)
      expect(result.responseEmpty).toBe(true)
      expect(result.toolCalls).toBe(0)
    } finally {
      console.error = errSpy
    }
  })

  it('marks responseEmpty when LLM returns empty text', async () => {
    runAgentLoopImpl = async () => ({
      text: '',
      toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'm',
    })
    const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
    const result = await runSubagent(cfg, 'p', makeCtx(), [])
    expect(result.responseEmpty).toBe(true)
  })

  it('hitMaxTurns flips when maxIterationsExhausted is true', async () => {
    runAgentLoopImpl = async () => ({
      text: 'partial',
      toolCalls: [], iterations: 50,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'm',
      maxIterationsExhausted: true,
    })
    const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
    const result = await runSubagent(cfg, 'p', makeCtx(), [])
    expect(result.hitMaxTurns).toBe(true)
  })

  it('persists transcript when sessionPersistence is provided', async () => {
    const saved: any[] = []
    const ctx = makeCtx({
      sessionId: 's1',
      sessionPersistence: {
        saveSubagentTranscript: async (...args: any[]) => { saved.push(args) },
      },
    })
    runAgentLoopImpl = async () => ({
      text: 'r', toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [{ role: 'assistant', content: 'r' }],
      effectiveModelId: 'm',
    })
    const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
    await runSubagent(cfg, 'p', ctx, [])
    expect(saved).toHaveLength(1)
    expect(saved[0][1]).toBe('s1')
  })

  it('applies toolMockFns interceptors when provided', async () => {
    let calledMock = false
    const ctx = makeCtx({
      toolMockFns: new Map([
        ['read_file', () => {
          calledMock = true
          return 'mocked-output'
        }],
      ]),
    })
    let observed: any[] = []
    runAgentLoopImpl = async (opts: any) => {
      observed = opts.tools
      // simulate the loop running the mock
      const tool = opts.tools.find((t: any) => t.name === 'read_file')
      const r = await tool.execute('tc', { path: 'x' })
      expect(r.details).toBe('mocked-output')
      return { text: 'ok', toolCalls: [], iterations: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, newMessages: [], effectiveModelId: 'm' }
    }
    const allTools = [{ name: 'read_file', execute: async () => 'real' } as any]
    const cfg = { name: 'c', description: 'd', systemPrompt: 's', toolNames: ['read_file'] } as any
    await runSubagent(cfg, 'p', ctx, allTools)
    expect(calledMock).toBe(true)
    expect(observed.find(t => t.name === 'read_file')).toBeDefined()
  })
})

// --- runSubagentsParallel -------------------------------------------------

describe('runSubagentsParallel', () => {
  it('runs all configs and resolves to an array of SubagentResult', async () => {
    runAgentLoopImpl = async () => ({
      text: 'r', toolCalls: [], iterations: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'm',
    })
    const cfgs = [
      { config: { name: 'a', description: 'd', systemPrompt: 's' } as any, prompt: 'p1' },
      { config: { name: 'b', description: 'd', systemPrompt: 's' } as any, prompt: 'p2' },
    ]
    const out = await runSubagentsParallel(cfgs, makeCtx(), [])
    expect(out).toHaveLength(2)
    expect(out.every(r => r.responseText === 'r')).toBe(true)
  })
})
