// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { buildGuideRegistry, buildCapabilitiesIndex, CAPABILITIES_INDEX } from '../guide-registry'
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
      'integrations', 'subagent', 'browser', 'constraint-awareness',
      'personality', 'skill-matching', 'self-evolution', 'tool-planning', 'memory',
    ]
    for (const key of expectedKeys) {
      expect(registry.has(key)).toBe(true)
      expect(registry.get(key)!.length).toBeGreaterThan(50)
    }
  })

  test('guides contain substantive content', () => {
    const registry = buildGuideRegistry()
    expect(registry.get('integrations')).toContain('search_integrations')
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

describe('buildCapabilitiesIndex flags', () => {
  test('default (no flags) equals the full CAPABILITIES_INDEX', () => {
    expect(buildCapabilitiesIndex()).toBe(CAPABILITIES_INDEX)
  })

  test('all platform lines present by default', () => {
    const idx = buildCapabilitiesIndex()
    expect(idx).toContain('- **integrations**')
    expect(idx).toContain('- **channel**')
    expect(idx).toContain('- **media**')
    expect(idx).toContain('- **devops**')
    // subagent line still advertises the delegated types
    expect(idx).toContain('integration, channel, media, devops')
  })

  test('channels: false drops the channel line and subagent mention', () => {
    const idx = buildCapabilitiesIndex({ channels: false })
    expect(idx).not.toContain('- **channel**')
    expect(idx).not.toContain('Telegram, Discord, webchat')
    // subagent type list no longer lists `channel`
    expect(idx).not.toMatch(/browser, integration, channel/)
    // unrelated coding capabilities remain
    expect(idx).toContain('- **subagent**')
    expect(idx).toContain('- **memory**')
    expect(idx).toContain('- **integrations**')
  })

  test('integrations: false drops the integrations line', () => {
    const idx = buildCapabilitiesIndex({ integrations: false })
    expect(idx).not.toContain('- **integrations**')
    expect(idx).not.toContain('search_integrations')
    // channel line untouched
    expect(idx).toContain('- **channel**')
  })

  test('media + devops false drop their respective lines', () => {
    const idx = buildCapabilitiesIndex({ media: false, devops: false })
    expect(idx).not.toContain('- **media**')
    expect(idx).not.toContain('- **devops**')
    expect(idx).toContain('- **channel**')
    expect(idx).toContain('- **integrations**')
  })

  test('all platform lines off keeps the coding-only core', () => {
    const idx = buildCapabilitiesIndex({
      integrations: false,
      channels: false,
      media: false,
      devops: false,
    })
    for (const line of ['integrations', 'channel', 'media', 'devops']) {
      expect(idx).not.toContain(`- **${line}**`)
    }
    for (const line of ['subagent', 'browser', 'memory', 'skill-matching', 'self-evolution', 'tool-planning', 'personality', 'constraint-awareness']) {
      expect(idx).toContain(`- **${line}**`)
    }
    expect(idx).toContain('read_guide')
    // subagent list collapses to coding types only
    expect(idx).toContain('explore, general-purpose, code-reviewer, browser, fork mode, and team swarm')
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
