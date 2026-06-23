// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WS7 — core-tool contract.
 *
 * Prod signature: `exec` / `edit_file` / `write_file` reported "Tool not found"
 * in agent mode (concentrated sessions; registration/MCP-merge race or a
 * read-only mode filter). These tests pin two guarantees:
 *
 *   1. Across capability-config permutations, the agent-mode tool set always
 *      contains the expected core tools (`expectedCoreToolsForAgentMode`).
 *   2. A tool removed by a read-only mode still dispatches to a *mode-aware*
 *      error stub (not the opaque "Tool not found"), via
 *      `createModeUnavailableTool`.
 */

import { describe, test, expect } from 'bun:test'
import {
  createTools,
  filterDisabledCapabilityTools,
  expectedCoreToolsForAgentMode,
  createModeUnavailableTool,
  type ToolContext,
  type RestrictedMode,
} from '../gateway-tools'
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
    workspaceDir: '/tmp/test-core-tool-contract',
    channels: new Map(),
    config,
    projectId: 'test',
  }
}

/** Mirror the agent-mode assembly (createTools → capability filter). */
function agentModeNames(config: GatewayConfig): Set<string> {
  const filtered = filterDisabledCapabilityTools(createTools(makeCtx(config)), config)
  return new Set(filtered.map(t => t.name))
}

describe('WS7: core tools always present in agent mode', () => {
  const permutations: Array<[string, Partial<GatewayConfig>]> = [
    ['default', {}],
    ['web off', { webEnabled: false }],
    ['browser off', { browserEnabled: false }],
    ['heartbeat off', { heartbeatEnabled: false }],
    ['channels off', { channelsEnabled: false }],
    ['integrations off', { integrationsEnabled: false }],
    ['memory off', { memoryEnabled: false }],
    ['image gen off', { imageGenEnabled: false }],
    ['everything optional off', {
      webEnabled: false,
      browserEnabled: false,
      heartbeatEnabled: false,
      channelsEnabled: false,
      integrationsEnabled: false,
      memoryEnabled: false,
      imageGenEnabled: false,
      quickActionsEnabled: false,
    }],
  ]

  for (const [label, overrides] of permutations) {
    test(`core tools present (${label})`, () => {
      const config = makeConfig(overrides)
      const names = agentModeNames(config)
      for (const core of expectedCoreToolsForAgentMode(config)) {
        expect(names.has(core)).toBe(true)
      }
      // Filesystem trio is unconditional regardless of toggles.
      expect(names.has('read_file')).toBe(true)
      expect(names.has('write_file')).toBe(true)
      expect(names.has('edit_file')).toBe(true)
    })
  }

  test('exec is core only when shell is enabled', () => {
    expect(expectedCoreToolsForAgentMode(makeConfig())).toContain('exec')
    expect(expectedCoreToolsForAgentMode(makeConfig({ shellEnabled: false }))).not.toContain('exec')
  })

  test('exec present with shell on, absent with shell off', () => {
    expect(agentModeNames(makeConfig()).has('exec')).toBe(true)
    expect(agentModeNames(makeConfig({ shellEnabled: false })).has('exec')).toBe(false)
  })
})

describe('WS7: mode-aware unavailable-tool stub', () => {
  const modes: RestrictedMode[] = ['plan', 'ask', 'coordinator']

  for (const mode of modes) {
    test(`createModeUnavailableTool(${mode}) returns an actionable error, not "not found"`, async () => {
      const stub = createModeUnavailableTool('write_file', mode)
      expect(stub.name).toBe('write_file')
      const res: any = await stub.execute('id', {})
      const detail = res.details
      expect(detail.toolUnavailableInMode).toBe(mode)
      expect(String(detail.error)).toContain('write_file')
      expect(String(detail.error).toLowerCase()).not.toContain('not found')
      // Mentions how to recover (agent mode / delegate).
      expect(/agent mode|delegate/i.test(String(detail.error))).toBe(true)
    })
  }

  test('plan-mode stub names the mode', async () => {
    const res: any = await createModeUnavailableTool('exec', 'plan').execute('id', {})
    expect(String(res.details.error)).toContain('Plan mode')
  })
})
