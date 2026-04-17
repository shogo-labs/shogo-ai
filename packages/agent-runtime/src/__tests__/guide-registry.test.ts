// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { buildGuideRegistry, CAPABILITIES_INDEX } from '../guide-registry'
import { createTools, type ToolContext } from '../gateway-tools'

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: '/tmp/test-guide-registry',
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    ...overrides,
  }
}

describe('Guide Registry', () => {
  test('buildGuideRegistry returns all expected guides', () => {
    const registry = buildGuideRegistry()
    const expectedKeys = [
      'mcp-discovery', 'subagent', 'browser', 'constraint-awareness',
      'personality', 'skill-matching', 'self-evolution', 'tool-planning', 'memory',
    ]
    for (const key of expectedKeys) {
      expect(registry.has(key)).toBe(true)
      expect(registry.get(key)!.length).toBeGreaterThan(50)
    }
  })

  test('guides contain substantive content', () => {
    const registry = buildGuideRegistry()
    expect(registry.get('mcp-discovery')).toContain('tool_search')
    expect(registry.get('subagent')).toContain('agent_spawn')
    expect(registry.get('browser')).toContain('snapshot')
    expect(registry.get('personality')).toContain('AGENTS.md')
    expect(registry.get('skill-matching')).toContain('SKILL.md')
  })

  test('prompt overrides are respected', () => {
    const overrides = new Map([['personality_guide', 'CUSTOM PERSONALITY GUIDE']])
    const registry = buildGuideRegistry(overrides)
    expect(registry.get('personality')).toContain('CUSTOM PERSONALITY GUIDE')
  })

  test('CAPABILITIES_INDEX mentions all guide names', () => {
    const registry = buildGuideRegistry()
    for (const key of registry.keys()) {
      expect(CAPABILITIES_INDEX).toContain(key)
    }
  })

  test('CAPABILITIES_INDEX mentions read_guide tool', () => {
    expect(CAPABILITIES_INDEX).toContain('read_guide')
  })
})

describe('read_guide tool', () => {
  test('is included in tool list', () => {
    const registry = buildGuideRegistry()
    const ctx = createCtx({ guideRegistry: registry })
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_guide')
    expect(tool).toBeDefined()
  })

  test('returns guide content for valid name', async () => {
    const registry = buildGuideRegistry()
    const ctx = createCtx({ guideRegistry: registry })
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_guide')!
    const result = await tool.execute('test-id', { name: 'browser' })
    const text = (result.content[0] as any).text
    expect(text).toContain('snapshot')
    expect(text).toContain('navigate')
  })

  test('returns error for unknown guide name', async () => {
    const registry = buildGuideRegistry()
    const ctx = createCtx({ guideRegistry: registry })
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_guide')!
    const result = await tool.execute('test-id', { name: 'nonexistent' })
    const text = (result.content[0] as any).text
    expect(text).toContain('Unknown guide')
    expect(text).toContain('Available:')
  })
})
