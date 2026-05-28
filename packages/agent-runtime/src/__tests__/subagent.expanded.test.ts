// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Expanded coverage for subagent.ts — targets the residual uncovered lines
// left after subagent.test.ts: working-dir mkdir, includeInstalledTools,
// DEBUG_SCREENCAST branches, override-lookup failure, auto-routing happy
// path + escalation paths (failure + thrown), persistence failure,
// isSubagentFailure variants, estimateContextTokens(array-content), and the
// `apiUrl is null` branch in fetchSubagentOverrideFromApi.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- Module mocks ----------------------------------------------------------

let runAgentLoopImpl: (...args: any[]) => Promise<any> = async () => ({
  text: 'ok',
  toolCalls: [],
  iterations: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  newMessages: [],
  effectiveModelId: 'm',
  maxIterationsExhausted: false,
  loopBreak: false,
})

mock.module('../agent-loop', () => ({
  runAgentLoop: (...args: any[]) => runAgentLoopImpl(...args),
}))

mock.module('../gateway-tools', () => ({
  createBrowserTool: (_ctx: any) => ({
    name: 'browser',
    execute: async () => ({ content: [], details: {} }),
  }),
  textResult: (data: any) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }),
}))

// Allow per-test override of deriveApiUrl so we can drive the
// `!apiUrl → cache null` branch in fetchSubagentOverrideFromApi.
let deriveApiUrlImpl: () => string | null = () => 'https://api.test'
mock.module('../internal-api', () => ({
  deriveApiUrl: () => deriveApiUrlImpl(),
  getInternalHeaders: () => ({ 'Content-Type': 'application/json' }),
}))

// Stub the model-router so we can deterministically force routing decisions
// and escalation outcomes.
let selectModelImpl: (..._: any[]) => any = () => ({
  selectedModel: 'auto-cheap',
  fallbackReason: null,
  routerTier: 'cheap',
})
let escalateModelImpl: (..._: any[]) => any = () => ({
  selectedModel: 'auto-premium',
  fallbackReason: 'escalated',
  routerTier: 'premium',
})
mock.module('../model-router', () => ({
  selectModelForSpawn: (...a: any[]) => selectModelImpl(...a),
  escalateModel: (...a: any[]) => escalateModelImpl(...a),
  buildAutoTierMap: () => ({ cheap: 'auto-cheap', mid: 'auto-mid', premium: 'auto-premium' }),
  formatRoutingLog: () => '[router] selected auto-cheap',
}))

mock.module('@shogo/model-catalog', () => ({
  inferProviderFromModel: (m: string, fallback?: string) =>
    m?.startsWith('gpt') ? 'openai' : m?.startsWith('claude') ? 'anthropic' : (fallback || 'anthropic'),
}))

let fetchImpl: (...args: any[]) => Promise<Response> = async () =>
  new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
;(globalThis as any).fetch = (...args: any[]) => fetchImpl(...args)

import {
  loadCustomAgents,
  fetchSubagentOverrideFromApi,
  clearSubagentOverrideCache,
  runSubagent,
} from '../subagent'

afterEach(() => {
  clearSubagentOverrideCache()
  deriveApiUrlImpl = () => 'https://api.test'
  selectModelImpl = () => ({ selectedModel: 'auto-cheap', fallbackReason: null, routerTier: 'cheap' })
  escalateModelImpl = () => ({ selectedModel: 'auto-premium', fallbackReason: 'escalated', routerTier: 'premium' })
  delete process.env.DEBUG_SCREENCAST
})

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

// --- loadCustomAgents: per-file read failure (line 493 catch) -------------

describe('loadCustomAgents — per-file read failure', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cust-agents-err-'))
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* swallow */ }
  })

  it('catches readFileSync errors for individual files and continues', () => {
    const agentsDir = join(dir, '.shogo', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    // A directory whose name ends in .md — readFileSync will throw EISDIR.
    mkdirSync(join(agentsDir, 'broken.md'))
    // A good entry alongside the broken one so we know we kept going.
    writeFileSync(
      join(agentsDir, 'good.md'),
      `---\nname: good\ndescription: works\n---\nbody`,
    )
    const errSpy = console.error
    const calls: string[] = []
    console.error = (...a: any[]) => { calls.push(a.join(' ')) }
    try {
      const out = loadCustomAgents(dir)
      expect(out).toHaveLength(1)
      expect(out[0].name).toBe('good')
      expect(calls.join('\n')).toMatch(/Failed to load broken\.md/)
    } finally {
      console.error = errSpy
    }
  })
})

// --- fetchSubagentOverrideFromApi: apiUrl=null branch (lines 636-637) -----

describe('fetchSubagentOverrideFromApi — apiUrl null', () => {
  it('caches null and returns when deriveApiUrl returns null', async () => {
    deriveApiUrlImpl = () => null
    const r = await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(r.override).toBeNull()
    expect(r.experiment).toBeNull()
    // Subsequent call hits the cache (no bucketKey).
    const r2 = await fetchSubagentOverrideFromApi('explore', 'w1', null)
    expect(r2.override).toBeNull()
  })
})

// --- runSubagent — working dir creation (line 818) ------------------------

describe('runSubagent — workingDir mkdir', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sub-wd-'))
    runAgentLoopImpl = async () => ({
      text: 'ok', toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'm',
    })
  })
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* swallow */ }
  })

  it('creates the working directory when it does not exist', async () => {
    const wd = join(tmp, 'nested', 'work')
    expect(existsSync(wd)).toBe(false)
    const cfg = { name: 'c', description: 'd', systemPrompt: 's', workingDir: wd } as any
    await runSubagent(cfg, 'p', makeCtx(), [])
    expect(existsSync(wd)).toBe(true)
  })
})

// --- includeInstalledTools + browser rebuild + DEBUG_SCREENCAST -----------

describe('runSubagent — includeInstalledTools and browser rebuild', () => {
  beforeEach(() => {
    runAgentLoopImpl = async (opts: any) => {
      ;(runAgentLoopImpl as any).captured = opts
      return {
        text: 'ok', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: 'm',
      }
    }
  })

  it('appends dynamic (non-core) tools when includeInstalledTools=true', async () => {
    const allTools = [
      { name: 'read_file', execute: async () => ({}) },
      { name: 'search_integrations', execute: async () => ({}) },
      { name: 'JIRA_LIST_BOARDS', execute: async () => ({}) },
      { name: 'GMAIL_SEND_EMAIL', execute: async () => ({}) },
    ] as any[]
    const cfg = {
      name: 'integration',
      description: 'd',
      systemPrompt: 's',
      toolNames: ['read_file', 'search_integrations'],
      includeInstalledTools: true,
    } as any
    await runSubagent(cfg, 'p', makeCtx(), allTools)
    const names = (runAgentLoopImpl as any).captured.tools.map((t: any) => t.name).sort()
    expect(names).toContain('JIRA_LIST_BOARDS')
    expect(names).toContain('GMAIL_SEND_EMAIL')
    expect(names).toContain('read_file')
    expect(names).toContain('search_integrations')
  })

  it('rebuilds the browser tool against the subCtx', async () => {
    const parentBrowser = { name: 'browser', execute: async () => ({ marker: 'parent' }) }
    const allTools = [parentBrowser, { name: 'read_file', execute: async () => ({}) }] as any[]
    const cfg = { name: 'browser', description: 'd', systemPrompt: 's', toolNames: ['browser', 'read_file'] } as any
    await runSubagent(cfg, 'p', makeCtx(), allTools)
    const captured = (runAgentLoopImpl as any).captured.tools
    const b = captured.find((t: any) => t.name === 'browser')
    expect(b).toBeDefined()
    // Replaced — not the same reference as parentBrowser.
    expect(b).not.toBe(parentBrowser)
  })

  it('logs debug-screencast when DEBUG_SCREENCAST=1 and browser tool exists', async () => {
    process.env.DEBUG_SCREENCAST = '1'
    const logSpy = console.log
    const lines: string[] = []
    console.log = (...a: any[]) => lines.push(a.join(' '))
    try {
      const allTools = [
        { name: 'browser', execute: async () => ({}) },
      ] as any[]
      const cfg = { name: 'browser', description: 'd', systemPrompt: 's', toolNames: ['browser'] } as any
      await runSubagent(cfg, 'p', makeCtx(), allTools, undefined, { instanceId: 'inst-42' })
      expect(lines.some(l => l.includes('rebuilding browser tool') && l.includes('inst-42'))).toBe(true)
    } finally {
      console.log = logSpy
    }
  })

  it('logs debug-screencast when DEBUG_SCREENCAST=true and no browser tool present', async () => {
    process.env.DEBUG_SCREENCAST = 'true'
    const logSpy = console.log
    const lines: string[] = []
    console.log = (...a: any[]) => lines.push(a.join(' '))
    try {
      const allTools = [{ name: 'read_file', execute: async () => ({}) }] as any[]
      const cfg = { name: 'c', description: 'd', systemPrompt: 's', toolNames: ['read_file'] } as any
      await runSubagent(cfg, 'p', makeCtx(), allTools, undefined, { instanceId: 'inst-99' })
      expect(lines.some(l => l.includes('no browser tool to rebuild') && l.includes('inst-99'))).toBe(true)
    } finally {
      console.log = logSpy
    }
  })
})

// --- Override lookup failure path (line 954 warn catch) -------------------

describe('runSubagent — override lookup failure', () => {
  it('logs and continues when resolveSubagentModel throws', async () => {
    process.env.WORKSPACE_ID = 'w-x'
    deriveApiUrlImpl = () => 'https://api.test'
    // Force the fetch call inside fetchSubagentOverrideFromApi to throw so
    // the inner try/catch returns {null,null} — that alone does not trigger
    // line 954. Instead we throw from deriveApiUrl which runs BEFORE the
    // inner try, so the outer catch in runSubagent fires.
    deriveApiUrlImpl = () => { throw new Error('boom') }
    runAgentLoopImpl = async () => ({
      text: 'ok', toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'm',
    })
    const warnSpy = console.warn
    const warns: string[] = []
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
      const r = await runSubagent(cfg, 'p', makeCtx(), [])
      expect(r.responseText).toBe('ok')
      expect(warns.some(w => w.includes('Override lookup failed'))).toBe(true)
    } finally {
      console.warn = warnSpy
      delete process.env.WORKSPACE_ID
    }
  })
})

// --- Auto-routing happy path (lines 976-989) ------------------------------

describe('runSubagent — auto-routing', () => {
  it('selects routed model and writes routing-decision data event', async () => {
    const written: any[] = []
    const ctx = makeCtx({
      autoRouting: true,
      uiWriter: { write: (d: any) => written.push(d) },
    })
    let observedModel = ''
    runAgentLoopImpl = async (opts: any) => {
      observedModel = opts.model
      return {
        text: 'routed', toolCalls: [{ name: 'x' }], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: 'auto-cheap',
      }
    }
    selectModelImpl = () => ({ selectedModel: 'auto-cheap', fallbackReason: null, routerTier: 'cheap' })
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const r = await runSubagent(cfg, 'a prompt', ctx, [])
    expect(r.responseText).toBe('routed')
    expect(observedModel).toBe('auto-cheap')
    expect(written.some(w => w.type === 'data-routing-decision')).toBe(true)
  })

  it('escalates when the auto-routed run returns an empty/failure result', async () => {
    const written: any[] = []
    const ctx = makeCtx({
      autoRouting: true,
      uiWriter: { write: (d: any) => written.push(d) },
    })
    let call = 0
    runAgentLoopImpl = async (opts: any) => {
      call++
      if (call === 1) {
        // first run: empty text (triggers isSubagentFailure -> escalation)
        return {
          text: '', toolCalls: [], iterations: 1,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          newMessages: [], effectiveModelId: opts.model,
        }
      }
      return {
        text: 'recovered', toolCalls: [{ name: 'x' }], iterations: 2,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: opts.model,
      }
    }
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const r = await runSubagent(cfg, 'p', ctx, [])
    expect(call).toBe(2)
    expect(r.escalated).toBe(true)
    expect(r.responseText).toBe('recovered')
    expect(r.effectiveModelId).toBe('auto-premium')
    // routing-decision event emitted twice (initial + escalation).
    expect(written.filter(w => w.type === 'data-routing-decision').length).toBeGreaterThanOrEqual(2)
  })

  it('does NOT escalate when escalateModel returns null', async () => {
    const ctx = makeCtx({ autoRouting: true })
    runAgentLoopImpl = async () => ({
      text: '', toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'auto-cheap',
    })
    escalateModelImpl = () => null
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const r = await runSubagent(cfg, 'p', ctx, [])
    expect(r.escalated).toBe(false)
    expect(r.responseText).toBe('')
  })

  it('escalates on thrown error during the initial run (catch path)', async () => {
    const ctx = makeCtx({ autoRouting: true })
    let call = 0
    runAgentLoopImpl = async (opts: any) => {
      call++
      if (call === 1) throw new Error('cheap-model-explode')
      return {
        text: 'rescued', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: opts.model,
      }
    }
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const logSpy = console.log
    console.log = () => {}
    try {
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.responseText).toBe('rescued')
      expect(r.escalated).toBe(true)
      expect(r.effectiveModelId).toBe('auto-premium')
    } finally {
      console.log = logSpy
    }
  })

  it('returns failure envelope when escalation retry also throws', async () => {
    const ctx = makeCtx({ autoRouting: true })
    runAgentLoopImpl = async () => { throw new Error('always-fails') }
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const errSpy = console.error
    const logSpy = console.log
    console.error = () => {}
    console.log = () => {}
    try {
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.responseText).toMatch(/Subagent failed: always-fails/)
      expect(r.responseEmpty).toBe(true)
      expect(r.escalated).toBe(false)
    } finally {
      console.error = errSpy
      console.log = logSpy
    }
  })

  it('returns failure envelope when auto-routing throws and escalateModel returns null', async () => {
    const ctx = makeCtx({ autoRouting: true })
    runAgentLoopImpl = async () => { throw new Error('cheap-died') }
    escalateModelImpl = () => null
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    const errSpy = console.error
    console.error = () => {}
    try {
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.responseText).toMatch(/Subagent failed: cheap-died/)
    } finally {
      console.error = errSpy
    }
  })
})

// --- Session persistence failure (line 1036 catch) -------------------------

describe('runSubagent — sessionPersistence failure', () => {
  it('logs a warning but still returns a successful result', async () => {
    const ctx = makeCtx({
      sessionId: 's-fail',
      sessionPersistence: {
        saveSubagentTranscript: async () => { throw new Error('disk-full') },
      },
    })
    runAgentLoopImpl = async () => ({
      text: 'r', toolCalls: [], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [{ role: 'assistant', content: 'r' }], effectiveModelId: 'm',
    })
    const warnSpy = console.warn
    const warns: string[] = []
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.responseText).toBe('r')
      expect(warns.some(w => w.includes('Failed to persist transcript'))).toBe(true)
    } finally {
      console.warn = warnSpy
    }
  })
})

// --- Override resolved → source !== 'builtin' branch (line 990-992) -------

describe('runSubagent — workspace override wins over tier', () => {
  it('uses override model when API returns a project override', async () => {
    process.env.WORKSPACE_ID = 'w-ov'
    deriveApiUrlImpl = () => 'https://api.test'
    fetchImpl = async () =>
      new Response(JSON.stringify({
        override: { model: 'gpt-override', provider: 'openai', source: 'project' },
        experiment: null,
      }), { status: 200 })
    let observed = ''
    runAgentLoopImpl = async (opts: any) => {
      observed = opts.model
      return {
        text: 'ok', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: opts.model,
      }
    }
    const logSpy = console.log
    console.log = () => {}
    try {
      const cfg = { name: 'c', description: 'd', systemPrompt: 's' } as any
      await runSubagent(cfg, 'p', makeCtx(), [])
      expect(observed).toBe('gpt-override')
    } finally {
      console.log = logSpy
      delete process.env.WORKSPACE_ID
      fetchImpl = async () => new Response(JSON.stringify({ override: null, experiment: null }), { status: 200 })
    }
  })
})

// --- estimateContextTokens via auto-routing with array-content history ----

describe('runSubagent — estimateContextTokens covers array content', () => {
  it('handles messages with content-block arrays (text blocks) without throwing', async () => {
    const ctx = makeCtx({ autoRouting: true })
    let captured: any
    selectModelImpl = (input: any) => {
      captured = input
      return { selectedModel: 'auto-cheap', fallbackReason: null, routerTier: 'cheap' }
    }
    runAgentLoopImpl = async () => ({
      text: 'ok', toolCalls: [{ name: 'x' }], iterations: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], effectiveModelId: 'auto-cheap',
    })
    const history = [
      { role: 'user', content: 'plain string here' },
      { role: 'assistant', content: [
        { type: 'text', text: 'hello world' },
        { type: 'thinking', text: 'inner monologue' },
        { type: 'image' /* no text key — must be skipped without throwing */ },
      ] },
    ] as any[]
    const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
    await runSubagent(cfg, 'p', ctx, [], undefined, { history })
    expect(typeof captured.contextTokens).toBe('number')
    expect(captured.contextTokens).toBeGreaterThan(0)
  })
})

// --- isSubagentFailure: iterations==0 && toolCalls==0 (line 1129) ---------

describe('runSubagent — isSubagentFailure idle-result branch', () => {
  it('escalates when auto-routed run returns non-empty text but zero iterations & toolcalls', async () => {
    const ctx = makeCtx({ autoRouting: true })
    let call = 0
    runAgentLoopImpl = async (opts: any) => {
      call++
      if (call === 1) {
        return {
          text: 'looks-fine-but-no-work',
          toolCalls: [],
          iterations: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          newMessages: [], effectiveModelId: opts.model,
        }
      }
      return {
        text: 'rerun-ok', toolCalls: [{ name: 'x' }], iterations: 2,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: opts.model,
      }
    }
    const logSpy = console.log
    console.log = () => {}
    try {
      const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.escalated).toBe(true)
      expect(r.responseText).toBe('rerun-ok')
    } finally {
      console.log = logSpy
    }
  })

  it('escalates when text begins with the "Subagent failed:" marker', async () => {
    const ctx = makeCtx({ autoRouting: true })
    let call = 0
    runAgentLoopImpl = async (opts: any) => {
      call++
      if (call === 1) {
        return {
          text: 'Subagent failed: something bad',
          toolCalls: [{ name: 'x' }], iterations: 1,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          newMessages: [], effectiveModelId: opts.model,
        }
      }
      return {
        text: 'recovered', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: opts.model,
      }
    }
    const logSpy = console.log
    console.log = () => {}
    try {
      const cfg = { name: 'general-purpose', description: 'd', systemPrompt: 's' } as any
      const r = await runSubagent(cfg, 'p', ctx, [])
      expect(r.escalated).toBe(true)
      expect(r.responseText).toBe('recovered')
    } finally {
      console.log = logSpy
    }
  })
})

// --- Fork mode without thinkingLevel (default branch) ---------------------

describe('runSubagent — fork mode default thinking level', () => {
  it('keeps the default thinking level when forkCtx.thinkingLevel is undefined', async () => {
    let observed: any = null
    runAgentLoopImpl = async (opts: any) => {
      observed = opts
      return {
        text: 'forked', toolCalls: [], iterations: 1,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], effectiveModelId: 'm',
      }
    }
    const cfg = { name: 'fork', description: 'd', systemPrompt: 'unused' } as any
    await runSubagent(cfg, 'task', makeCtx(), [], undefined, {
      forkContext: {
        systemPrompt: 'SYS',
        parentMessages: [],
        parentTools: [],
        // no thinkingLevel set
      },
    })
    expect(observed.thinkingLevel).toBe('medium')
  })
})
