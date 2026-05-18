// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, mock } from 'bun:test'

// --- Module mocks (must be set up BEFORE importing the module under test) ----

let runSubagentImpl: (...args: any[]) => Promise<any> = async () => ({
  responseText: 'ok',
  toolCalls: 1,
  iterations: 1,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheWriteTokens: 0,
  newMessages: [{ role: 'assistant', content: 'ok' }],
  agentId: 'a-x-deadbeef',
  effectiveModelId: 'sonnet',
})

let builtinConfigImpl: (name: string) => any = (name) =>
  ['explore', 'general-purpose', 'browser_qa'].includes(name)
    ? { name, description: `${name} desc`, systemPrompt: 'sys', toolNames: ['read_file'], model: 'sonnet' }
    : null

mock.module('../subagent', () => ({
  runSubagent: (...args: any[]) => runSubagentImpl(...args),
  getBuiltinSubagentConfig: (name: string) => builtinConfigImpl(name),
}))

mock.module('../screencast-broadcaster', () => ({
  dropChannel: () => {},
}))

import { AgentManager, type AgentRegistryPersistence, type AgentCostMetricData } from '../agent-manager'

const baseCfg = (over: Partial<any> = {}) => ({
  name: 'custom',
  description: 'a custom agent',
  systemPrompt: 'you are custom',
  toolNames: ['read_file'],
  ...over,
})

const ctx = {} as any
const tools: any[] = []

beforeEach(() => {
  runSubagentImpl = async () => ({
    responseText: 'ok',
    toolCalls: 1, iterations: 1,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0,
    newMessages: [], agentId: 'a-x', effectiveModelId: 'sonnet',
  })
})

describe('AgentManager — register / unregister', () => {
  it('registers a valid config', () => {
    const m = new AgentManager()
    expect(m.register(baseCfg())).toEqual({ ok: true })
    expect(m.getConfig('custom')?.name).toBe('custom')
  })

  it('rejects a system prompt over the limit', () => {
    const m = new AgentManager({ maxSystemPromptLength: 10 })
    const r = m.register(baseCfg({ systemPrompt: 'x'.repeat(11) }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/exceeds 10 char limit/)
  })

  it('rejects new types past maxAgentTypes', () => {
    const m = new AgentManager({ maxAgentTypes: 1 })
    m.register(baseCfg({ name: 'a' }))
    const r = m.register(baseCfg({ name: 'b' }))
    expect(r.ok).toBe(false)
  })

  it('allows re-registering an existing type past the cap', () => {
    const m = new AgentManager({ maxAgentTypes: 1 })
    m.register(baseCfg({ name: 'a' }))
    expect(m.register(baseCfg({ name: 'a', description: 'new' }))).toEqual({ ok: true })
  })

  it('rejects disallowed tool names', () => {
    const m = new AgentManager()
    const r = m.register(baseCfg({ toolNames: ['read_file', 'agent_spawn'] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/agent_spawn/)
  })

  it('unregister returns false for unknown names', () => {
    const m = new AgentManager()
    expect(m.unregister('nope')).toBe(false)
  })

  it('unregister deletes and reports true', () => {
    const m = new AgentManager()
    m.register(baseCfg())
    expect(m.unregister('custom')).toBe(true)
    expect(m.getConfig('custom')).toBeNull()
  })
})

describe('AgentManager — persistence', () => {
  function fakeDb(): AgentRegistryPersistence & {
    saved: Array<{ name: string; cfg: any; metrics: any }>
    deleted: string[]
    updated: Array<{ name: string; metrics: any }>
  } {
    const saved: any[] = []
    const deleted: string[] = []
    const updated: any[] = []
    return {
      saved, deleted, updated,
      saveAgentType: (name, cfg, metrics) => { saved.push({ name, cfg, metrics }) },
      deleteAgentType: (name) => { deleted.push(name); return true },
      loadAgentTypes: () => [],
      updateAgentMetrics: (name, metrics) => { updated.push({ name, metrics }) },
    }
  }

  it('persists when persist=true', () => {
    const m = new AgentManager()
    const db = fakeDb()
    m.attachPersistence(db)
    m.register(baseCfg(), true)
    expect(db.saved).toHaveLength(1)
    expect(db.saved[0].name).toBe('custom')
  })

  it('does NOT persist when persist=false', () => {
    const m = new AgentManager()
    const db = fakeDb()
    m.attachPersistence(db)
    m.register(baseCfg())
    expect(db.saved).toHaveLength(0)
  })

  it('unregister calls deleteAgentType', () => {
    const m = new AgentManager()
    const db = fakeDb()
    m.attachPersistence(db)
    m.register(baseCfg(), true)
    m.unregister('custom')
    expect(db.deleted).toEqual(['custom'])
  })

  it('attachPersistence hydrates from DB and survives loadAgentTypes errors', () => {
    const m = new AgentManager()
    const db: AgentRegistryPersistence = {
      saveAgentType: () => {},
      deleteAgentType: () => true,
      loadAgentTypes: () => [
        { name: 'h1', config: baseCfg({ name: 'h1' }) as any, metrics: { totalRuns: 3 } as any },
      ],
      updateAgentMetrics: () => {},
    }
    m.attachPersistence(db)
    expect(m.getConfig('h1')).not.toBeNull()
    expect(m.listTypes().find(t => t.name === 'h1')?.metrics.totalRuns).toBe(3)

    // Second attach with a throwing load should not crash
    const original = console.warn
    console.warn = () => {}
    try {
      m.attachPersistence({
        ...db,
        loadAgentTypes: () => { throw new Error('db down') },
      } as any)
    } finally {
      console.warn = original
    }
  })
})

describe('AgentManager — listTypes', () => {
  it('returns the three builtins plus any custom registrations', () => {
    const m = new AgentManager()
    m.register(baseCfg())
    const list = m.listTypes()
    const names = list.map(t => t.name)
    expect(names).toContain('explore')
    expect(names).toContain('general-purpose')
    expect(names).toContain('browser_qa')
    expect(names).toContain('custom')
  })

  it('attaches builtin descriptions when ctx + allTools are provided', () => {
    const m = new AgentManager()
    const list = m.listTypes(ctx, tools)
    const explore = list.find(t => t.name === 'explore')!
    expect(explore.description).toContain('explore')
    expect(explore.builtin).toBe(true)
  })
})

describe('AgentManager — spawn happy path', () => {
  it('runs a registered subagent and updates metrics + emits cost', async () => {
    const m = new AgentManager()
    m.register(baseCfg())
    const costs: AgentCostMetricData[] = []
    m.onCostMetric((d) => costs.push(d))

    const r = m.spawn('custom', 'do it', ctx, tools)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const inst = m.getInstance(r.instanceId)!
    expect(inst.status).toBe('running')

    await inst.promise

    const final = m.getInstance(r.instanceId)!
    expect(final.status).toBe('completed')
    expect(final.result?.responseText).toBe('ok')
    expect(costs).toHaveLength(1)
    expect(costs[0].agentType).toBe('custom')
    expect(costs[0].inputTokens).toBe(100)
    expect(costs[0].success).toBe(true)

    const metrics = m.listTypes().find(t => t.name === 'custom')!.metrics
    expect(metrics.totalRuns).toBe(1)
    expect(metrics.successes).toBe(1)
    expect(metrics.totalInputTokens).toBe(100)
  })

  it('records onAfterToolCall activity in recentActivity', async () => {
    const m = new AgentManager()
    m.register(baseCfg())
    runSubagentImpl = async (_cfg, _prompt, _ctx, _tools, callbacks) => {
      await callbacks?.onAfterToolCall?.('read_file', { path: 'a' }, 'file body', false, 'tc1')
      await callbacks?.onAfterToolCall?.('exec', { cmd: 'ls' }, { stdout: 'x' }, false, 'tc2')
      await callbacks?.onAfterToolCall?.('exec', {}, '', true, 'tc3')
      callbacks?.onModelResolved?.('haiku')
      return {
        responseText: 'done', toolCalls: 3, iterations: 1,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
        newMessages: [], agentId: 'a',
      }
    }
    const r = m.spawn('custom', 'p', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    const inst = m.getInstance(r.instanceId)!
    await inst.promise
    expect(inst.recentActivity).toHaveLength(3)
    expect(inst.recentActivity[2].summary).toBe('ERROR')
    expect(inst.recentActivity[0].tool).toBe('read_file')
    expect(inst.model).toBe('haiku')
  })

  it('falls back to a builtin config when type is unregistered but builtin', async () => {
    const m = new AgentManager()
    const r = m.spawn('explore', 'find x', ctx, tools)
    expect(r.ok).toBe(true)
  })

  it('rejects spawn for an unknown type', () => {
    const m = new AgentManager()
    const r = m.spawn('nope', 'x', ctx, tools)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Unknown agent type/)
  })

  it('rejects when maxTotalSpawns is hit', () => {
    const m = new AgentManager({ maxTotalSpawns: 0 })
    const r = m.spawn('explore', 'x', ctx, tools)
    expect(r.ok).toBe(false)
  })

  it('rejects when maxConcurrentInstances is hit', () => {
    const m = new AgentManager({ maxConcurrentInstances: 1 })
    // Make first spawn never resolve
    let resolve!: () => void
    runSubagentImpl = () => new Promise<any>((res) => { resolve = () => res({
      responseText: 'r', toolCalls: 0, iterations: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [], agentId: 'a',
    }) })
    const a = m.spawn('explore', 'x', ctx, tools)
    expect(a.ok).toBe(true)
    const b = m.spawn('explore', 'y', ctx, tools)
    expect(b.ok).toBe(false)
    resolve()
  })
})

describe('AgentManager — spawn failure path', () => {
  it('records failure metrics and emits a failure cost', async () => {
    runSubagentImpl = async () => { throw new Error('boom') }
    const m = new AgentManager()
    m.register(baseCfg())
    const costs: AgentCostMetricData[] = []
    m.onCostMetric((d) => costs.push(d))

    const r = m.spawn('custom', 'x', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    const inst = m.getInstance(r.instanceId)!
    await inst.promise
    expect(inst.status).toBe('failed')
    expect(inst.result?.responseText).toBe('boom')
    expect(costs[0].success).toBe(false)
    expect(costs[0].responseEmpty).toBe(true)

    const metrics = m.listTypes().find(t => t.name === 'custom')!.metrics
    expect(metrics.failures).toBe(1)
  })

  it('cancel() flips a running instance and avoids counting failure metrics', async () => {
    let resolve!: (v: any) => void
    runSubagentImpl = () => new Promise<any>((res) => { resolve = res })
    const m = new AgentManager()
    m.register(baseCfg())
    const r = m.spawn('custom', 'x', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    expect(m.cancel(r.instanceId)).toBe(true)
    // Now make the subagent throw because it was aborted
    resolve(Promise.reject(new Error('aborted')))
    await m.getInstance(r.instanceId)!.promise.catch(() => {})
    const inst = m.getInstance(r.instanceId)!
    expect(inst.status).toBe('cancelled')
    const metrics = m.listTypes().find(t => t.name === 'custom')!.metrics
    expect(metrics.failures).toBe(0)
  })

  it('cancel() returns false for unknown or finished instances', async () => {
    const m = new AgentManager()
    expect(m.cancel('does-not-exist')).toBe(false)
    m.register(baseCfg())
    const r = m.spawn('custom', 'x', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    await m.getInstance(r.instanceId)!.promise
    expect(m.cancel(r.instanceId)).toBe(false)
  })

  it('cancelAll() cancels all running, skips completed', async () => {
    const resolvers: Array<(v: any) => void> = []
    runSubagentImpl = () => new Promise<any>((res) => { resolvers.push(res) })
    const m = new AgentManager({ maxConcurrentInstances: 3 })
    m.register(baseCfg())
    const r1 = m.spawn('custom', 'x', ctx, tools)
    const r2 = m.spawn('custom', 'y', ctx, tools)
    expect(r1.ok && r2.ok).toBe(true)
    const ids = m.cancelAll()
    expect(ids).toHaveLength(2)
    resolvers.forEach((r) => r(Promise.reject(new Error('abort'))))
    await Promise.all(m.listInstances().map((i) => m.getInstance(i.id)!.promise.catch(() => {})))
    expect(m.cancelAll()).toEqual([])
  })
})

describe('AgentManager — accessors', () => {
  it('getInstance returns null for unknown ids', () => {
    expect(new AgentManager().getInstance('nope')).toBeNull()
  })

  it('listInstances includes id/type/status/timestamps', async () => {
    const m = new AgentManager()
    m.register(baseCfg())
    const r = m.spawn('custom', 'x', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    await m.getInstance(r.instanceId)!.promise
    const list = m.listInstances()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(r.instanceId)
    expect(list[0].status).toBe('completed')
  })

  it('getInstanceMessages returns the newMessages array', async () => {
    runSubagentImpl = async () => ({
      responseText: 'r', toolCalls: 0, iterations: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      newMessages: [{ role: 'assistant', content: 'hello' }] as any,
      agentId: 'a',
    })
    const m = new AgentManager()
    m.register(baseCfg())
    const r = m.spawn('custom', 'x', ctx, tools)
    if (!r.ok) throw new Error(r.error)
    await m.getInstance(r.instanceId)!.promise
    const msgs = m.getInstanceMessages(r.instanceId)
    expect(msgs?.length).toBe(1)
    expect(m.getInstanceMessages('nope')).toBeNull()
  })
})
