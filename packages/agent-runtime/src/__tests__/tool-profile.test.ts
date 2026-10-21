// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the tool advertising profile (SHO-97).
 *
 * The profile decides which tool definitions are sent to the provider on every
 * API call. These cover the mechanics — budget, catalog, activation, learning —
 * with synthetic tool lists; the gateway-level acceptance test covers a real
 * `createTools()` set end to end.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { filterDisabledCapabilityTools } from '../gateway-tools'
import {
  CORE_TOOL_NAMES,
  DEFAULT_TOOL_PRIORITY,
  DEFAULT_TOKEN_BUDGET,
  DEFERRED_TOOLS_ENV,
  LEARNING_MIN_CALLS,
  createToolProfile,
  deferredToolsEnabled,
  estimateToolTokens,
  renderDeferredCatalog,
  resetToolRankingCache,
  resolveLearnedToolOrder,
  withActivationOnCall,
} from '../tool-profile'

function fakeTool(name: string, description = `${name} does a thing`): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to look' },
        limit: { type: 'number', description: 'How many' },
      },
      required: ['path'],
    },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  } as unknown as AgentTool
}

/** 240 managed-integration/MCP tools across six toolkits — a fully-connected agent. */
function integrationTools(): AgentTool[] {
  const toolkits = ['GMAIL', 'SLACK', 'JIRA', 'NOTION', 'GITHUB', 'HUBSPOT']
  const tools: AgentTool[] = []
  for (const toolkit of toolkits) {
    for (let i = 0; i < 40; i++) tools.push(fakeTool(`${toolkit}_ACTION_${i}`, `${toolkit} action ${i}`))
  }
  return tools
}

beforeEach(() => {
  resetToolRankingCache()
  delete process.env[DEFERRED_TOOLS_ENV]
})

describe('deferredToolsEnabled', () => {
  test('is on by default on both tracks', () => {
    expect(deferredToolsEnabled({})).toBe(true)
    expect(deferredToolsEnabled({ deferredToolsEnabled: true })).toBe(true)
  })

  test('can be turned off by config or env, without a per-track flag', () => {
    expect(deferredToolsEnabled({ deferredToolsEnabled: false })).toBe(false)
    process.env[DEFERRED_TOOLS_ENV] = '0'
    expect(deferredToolsEnabled({})).toBe(false)
  })
})

describe('createToolProfile', () => {
  test('advertises the core set and defers everything else', () => {
    const tools = [fakeTool('read_file'), fakeTool('exec'), fakeTool('rebase_branch'), fakeTool('drop_table')]
    const profile = createToolProfile(tools)
    expect(profile.isAdvertised('read_file')).toBe(true)
    expect(profile.isAdvertised('exec')).toBe(true)
    expect(profile.isAdvertised('rebase_branch')).toBe(false)
    expect(profile.catalog).toContain('rebase_branch')
  })

  test('a tool that was never deferred is advertised (later registrations are not hidden)', () => {
    const profile = createToolProfile([fakeTool('read_file')])
    expect(profile.isAdvertised('connected_later_mcp_tool')).toBe(true)
  })

  test('stays inside the token budget on a fully-connected agent', () => {
    const tools = [fakeTool('read_file'), fakeTool('exec'), ...integrationTools()]
    const profile = createToolProfile(tools)
    expect(profile.advertisedTokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET)
    expect(profile.deferredNames().length).toBeGreaterThan(200)
  })

  test('caps learned additions at maxLearned', () => {
    const tools = [...CORE_TOOL_NAMES.map(n => fakeTool(n)), ...DEFAULT_TOOL_PRIORITY.map(n => fakeTool(n))]
    const profile = createToolProfile(tools, { maxLearned: 3 })
    // core survives whether or not it is in the tool list; 3 learned on top.
    const learned = profile.advertisedNames().filter(n => !CORE_TOOL_NAMES.includes(n))
    expect(learned.length).toBe(3)
  })

  test('honours the budget when the learned list is expensive', () => {
    const core = [fakeTool('read_file'), fakeTool('exec')]
    const expensive = Array.from({ length: 40 }, (_, i) => fakeTool(`tool_${i}`, 'x'.repeat(4000)))
    const profile = createToolProfile([...core, ...expensive], { tokenBudget: 2_000 })
    expect(profile.advertisedTokens).toBeLessThanOrEqual(2_000)
    // The budget trims learned additions, never the core set.
    expect(profile.isAdvertised('read_file')).toBe(true)
    expect(profile.isAdvertised('exec')).toBe(true)
  })

  test('is deterministic for the same input', () => {
    const tools = [...CORE_TOOL_NAMES.map(n => fakeTool(n)), ...integrationTools()]
    const a = createToolProfile(tools)
    const b = createToolProfile(tools)
    expect(a.advertisedNames()).toEqual(b.advertisedNames())
    expect(a.catalog).toBe(b.catalog)
  })

  test('every registered tool is advertised or named in the catalog', () => {
    const tools = [...CORE_TOOL_NAMES.map(n => fakeTool(n)), ...integrationTools(), fakeTool('obscure_tool')]
    const profile = createToolProfile(tools)
    const advertised = new Set(profile.advertisedNames())
    for (const tool of tools) {
      if (advertised.has(tool.name)) continue
      const group = tool.name.slice(0, tool.name.indexOf('_'))
      const named =
        profile.catalog.includes(tool.name) ||
        new RegExp(`^- ${group.charAt(0)}${group.slice(1).toLowerCase()} [(]`, 'm').test(profile.catalog)
      expect(named).toBe(true)
    }
  })

  test('describe() returns the full definition and advertise() reveals it', () => {
    const tools = [fakeTool('read_file'), fakeTool('obscure_tool', 'Does the obscure thing')]
    const profile = createToolProfile(tools)

    const described = profile.describe('obscure_tool')!
    expect(described).toContain('Does the obscure thing')
    expect(described).toContain('"type": "object"')

    expect(profile.isDeferred('obscure_tool')).toBe(true)
    expect(profile.advertise('obscure_tool')).toBe(true)
    expect(profile.isAdvertised('obscure_tool')).toBe(true)
    expect(profile.advertise('obscure_tool')).toBe(false)
    // Costs nothing and keeps the prompt cache prefix intact.
    expect(profile.catalog).toContain('obscure_tool')
  })

  test('describe() on an unknown tool is null', () => {
    expect(createToolProfile([fakeTool('read_file')]).describe('nope')).toBeNull()
  })
})

describe('composition with capability filtering', () => {
  // Deferral runs AFTER capability/mode/permission filtering in the gateway, so
  // a tool a filter removed can never reappear behind the catalog.
  test('a filtered-out tool is neither advertised nor catalogued', () => {
    const tools = [fakeTool('web'), fakeTool('read_file'), fakeTool('exec'), fakeTool('memory_search')]
    const filtered = filterDisabledCapabilityTools(tools, { webEnabled: false, memoryEnabled: false } as never)
    const profile = createToolProfile(filtered)

    expect(filtered.map(t => t.name)).not.toContain('web')
    // Gone from the profile entirely: not catalogued, not readable on demand.
    expect(profile.describe('web')).toBeNull()
    expect(profile.isDeferred('web')).toBe(false)
    expect(profile.catalog).not.toContain('web')
    expect(profile.catalog).not.toContain('memory_search')
    expect(profile.isAdvertised('read_file')).toBe(true)
  })
})

describe('renderDeferredCatalog', () => {
  test('collapses 240 integration tools into at most six lines', () => {
    const tools = integrationTools()
    const catalog = renderDeferredCatalog(tools, new Set())
    const groupLines = catalog.split('\n').filter(l => /^- [A-Z][a-z]+ \(\d+ tools?:/.test(l))
    expect(groupLines.length).toBe(6)
    expect(groupLines[0]).toContain('Gmail (40 tools')
    expect(groupLines[0]).toContain('read_guide({ tool: "GMAIL_ACTION_0" })')
  })

  test('groups MCP tools by server and ordinary tools one per line', () => {
    const tools = [
      fakeTool('mcp_postgres_query'),
      fakeTool('mcp_postgres_schema'),
      fakeTool('mcp_linear_issues'),
      fakeTool('obscure_tool', 'Does the obscure thing. Second sentence here.'),
    ]
    const catalog = renderDeferredCatalog(tools, new Set())
    expect(catalog).toContain('MCP · postgres (2 tools: mcp_postgres_query, mcp_postgres_schema)')
    expect(catalog).toContain('MCP · linear (1 tool: mcp_linear_issues)')
    expect(catalog).toContain('- `obscure_tool` — Does the obscure thing')
    expect(catalog).not.toContain('Second sentence')
  })

  test('empty when nothing is deferred', () => {
    const tools = [fakeTool('read_file')]
    expect(renderDeferredCatalog(tools, new Set(['read_file']))).toBe('')
  })
})

describe('withActivationOnCall', () => {
  test('advertises the tool as soon as it is called, then executes it', async () => {
    const tool = fakeTool('obscure_tool')
    const profile = createToolProfile([tool])
    const wrapped = withActivationOnCall(tool, profile)

    expect(profile.isAdvertised('obscure_tool')).toBe(false)
    const result = await wrapped.execute('call-1', {} as never)
    expect(profile.isAdvertised('obscure_tool')).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' })
  })
})

describe('resolveLearnedToolOrder', () => {
  const rank = (order: string[], totalCalls: number) => async () => ({ order, totalCalls })

  test('falls back to the static ranking below the learning threshold', async () => {
    const order = await resolveLearnedToolOrder({
      projectId: 'p1',
      load: rank(['obscure_tool'], LEARNING_MIN_CALLS - 1),
    })
    expect(order).toEqual(DEFAULT_TOOL_PRIORITY)
  })

  test('puts the project’s measured top tools first once there is enough history', async () => {
    const order = await resolveLearnedToolOrder({
      projectId: 'p2',
      load: rank(['obscure_tool', 'read_file'], LEARNING_MIN_CALLS + 10),
    })
    expect(order[0]).toBe('obscure_tool')
    expect(order[1]).toBe('read_file')
    // The static ranking still fills in behind them, without duplicates.
    expect(new Set(order).size).toBe(order.length)
  })

  test('caches per project and never throws', async () => {
    let calls = 0
    const load = async () => {
      calls++
      return { order: ['obscure_tool'], totalCalls: LEARNING_MIN_CALLS + 1 }
    }
    await resolveLearnedToolOrder({ projectId: 'p3', load })
    await resolveLearnedToolOrder({ projectId: 'p3', load })
    expect(calls).toBe(1)

    const failing = await resolveLearnedToolOrder({
      projectId: 'p4',
      load: async () => {
        throw new Error('api down')
      },
    })
    expect(failing).toEqual(DEFAULT_TOOL_PRIORITY)
  })

  test('uses the static ranking with no project or no loader', async () => {
    expect(await resolveLearnedToolOrder({ projectId: null })).toEqual(DEFAULT_TOOL_PRIORITY)
    expect(await resolveLearnedToolOrder({ projectId: 'p5' })).toEqual(DEFAULT_TOOL_PRIORITY)
  })
})

describe('estimateToolTokens', () => {
  test('matches the chars/4 basis the prompt breakdown reports', () => {
    const tool = fakeTool('obscure_tool')
    const chars = JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.parameters }).length
    expect(estimateToolTokens(tool)).toBe(Math.ceil(chars / 4))
  })
})
