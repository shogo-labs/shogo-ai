// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verifies capability toggles gate the tools themselves — not just the
 * prompt. `filterDisabledCapabilityTools` is the shared chokepoint used by
 * both the main agent's tool list and the subagent parent-tool set
 * (`allToolsGetter`), so a disabled capability (image gen, heartbeat,
 * channels, integrations, …) is unreachable everywhere.
 */

import { describe, test, expect } from 'bun:test'
import { createTools, filterDisabledCapabilityTools, type ToolContext } from '../gateway-tools'
import type { GatewayConfig } from '../gateway'

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    heartbeatInterval: 1800,
    heartbeatEnabled: true,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    ...overrides,
  }
}

function makeCtx(config: GatewayConfig): ToolContext {
  return {
    workspaceDir: '/tmp/test-capability-tool-gating',
    channels: new Map(),
    config,
    projectId: 'test',
  }
}

function names(config: GatewayConfig): Set<string> {
  const ctx = makeCtx(config)
  const filtered = filterDisabledCapabilityTools(createTools(ctx), config)
  return new Set(filtered.map(t => t.name))
}

describe('filterDisabledCapabilityTools', () => {
  test('default config keeps capability tools available', () => {
    const n = names(makeConfig())
    expect(n.has('generate_image')).toBe(true)
    expect(n.has('heartbeat_configure')).toBe(true)
    expect(n.has('channel_connect')).toBe(true)
    expect(n.has('search_integrations')).toBe(true)
  })

  test('imageGenEnabled: false removes generate_image', () => {
    const n = names(makeConfig({ imageGenEnabled: false }))
    expect(n.has('generate_image')).toBe(false)
    // unrelated tools remain
    expect(n.has('read_file')).toBe(true)
  })

  test('heartbeatEnabled: false removes heartbeat tools', () => {
    const n = names(makeConfig({ heartbeatEnabled: false }))
    expect(n.has('heartbeat_configure')).toBe(false)
    expect(n.has('heartbeat_status')).toBe(false)
  })

  test('channelsEnabled: false removes channel + messaging tools', () => {
    const n = names(makeConfig({ channelsEnabled: false }))
    for (const t of ['channel_connect', 'channel_disconnect', 'channel_list', 'send_message']) {
      expect(n.has(t)).toBe(false)
    }
    // integrations untouched
    expect(n.has('search_integrations')).toBe(true)
  })

  test('integrationsEnabled: false removes integration tools', () => {
    const n = names(makeConfig({ integrationsEnabled: false }))
    for (const t of ['search_integrations', 'connect', 'disconnect']) {
      expect(n.has(t)).toBe(false)
    }
    // channels untouched
    expect(n.has('channel_connect')).toBe(true)
  })

  test('shell / web / memory / quick actions gate their tools', () => {
    const n = names(makeConfig({
      shellEnabled: false,
      webEnabled: false,
      memoryEnabled: false,
      quickActionsEnabled: false,
    }))
    expect(n.has('exec')).toBe(false)
    expect(n.has('exec_wait')).toBe(false)
    expect(n.has('web')).toBe(false)
    expect(n.has('memory_read')).toBe(false)
    expect(n.has('memory_search')).toBe(false)
    expect(n.has('quick_action')).toBe(false)
    // core file tools always survive
    expect(n.has('read_file')).toBe(true)
    expect(n.has('write_file')).toBe(true)
  })

  test('returns the same array reference when nothing is disabled (no-op fast path)', () => {
    const config = makeConfig()
    const tools = createTools(makeCtx(config))
    expect(filterDisabledCapabilityTools(tools, config)).toBe(tools)
  })

  test('orchestration / core tools are never gated', () => {
    const n = names(makeConfig({
      imageGenEnabled: false,
      heartbeatEnabled: false,
      channelsEnabled: false,
      integrationsEnabled: false,
    }))
    for (const t of ['read_file', 'write_file', 'edit_file', 'agent_spawn', 'skill', 'todo_write']) {
      expect(n.has(t)).toBe(true)
    }
  })
})
