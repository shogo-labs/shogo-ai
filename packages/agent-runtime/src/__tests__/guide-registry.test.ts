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
      'integrations', 'subagent', 'browser', 'media', 'constraint-awareness',
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
    expect(registry.get('media')).toContain('generate_image')
    expect(registry.get('media')).toContain('list_media_models')
    expect(registry.get('media')).toContain('Higgsfield')
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
    expect(idx).toContain('- **heartbeat**')
    // subagent line still advertises the delegated types — media and devops
    // are not among them: the main agent calls those tools directly.
    expect(idx).toContain('integration, channel, fork mode')
    expect(idx).not.toMatch(/devops/i)
  })

  test('the media line calls the tools directly and never delegates', () => {
    const idx = buildCapabilitiesIndex()
    const line = idx.split('\n').find((l) => l.startsWith('- **media**'))!
    expect(line).toContain('directly')
    for (const tool of ['generate_image', 'list_media_models', 'transcribe_audio']) {
      expect(line).toContain(tool)
    }
    expect(line).not.toContain('agent_spawn')
    expect(idx).not.toContain('agent_spawn({ type: "media"')
  })

  test('video and 3D tools are named only when their capability is on', () => {
    expect(buildCapabilitiesIndex()).not.toContain('generate_video')
    expect(buildCapabilitiesIndex()).not.toContain('generate_3d_model')
    const video = buildCapabilitiesIndex({ video: true })
    expect(video).toContain('`generate_video`')
    expect(video).toContain('video generation')
    const threeD = buildCapabilitiesIndex({ threeD: true })
    expect(threeD).toContain('`generate_3d_model`')
    expect(threeD).toContain('`edit_3d_model`')
    // image tools off, video on: a video-only line, no generate_image
    const videoOnly = buildCapabilitiesIndex({ media: false, video: true })
    expect(videoOnly).toContain('- **media**')
    expect(videoOnly).toContain('`generate_video`')
    expect(videoOnly).not.toContain('generate_image')
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

  test('media + heartbeat false drop their respective lines', () => {
    const idx = buildCapabilitiesIndex({ media: false, heartbeat: false })
    expect(idx).not.toContain('- **media**')
    expect(idx).not.toContain('- **heartbeat**')
    expect(idx).toContain('- **channel**')
    expect(idx).toContain('- **integrations**')
  })

  test('all platform lines off keeps the coding-only core', () => {
    const idx = buildCapabilitiesIndex({
      integrations: false,
      channels: false,
      media: false,
      heartbeat: false,
    })
    for (const line of ['integrations', 'channel', 'media', 'heartbeat']) {
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

  test('returns the media guide instead of "Unknown guide"', async () => {
    const registry = buildGuideRegistry()
    const ctx = createCtx({ guideRegistry: registry })
    const tools = createTools(ctx)
    const tool = tools.find(t => t.name === 'read_guide')!
    const result = await tool.execute('test-id', { name: 'media' })
    const text = (result.content[0] as any).text
    expect(text).not.toContain('Unknown guide')
    expect(text.length).toBeGreaterThan(50)
    expect(text).toContain('generate_image')
    expect(text).toContain('list_media_models')
    expect(text).toContain('Higgsfield')
    expect(text).not.toContain('agent_spawn')
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
