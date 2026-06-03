// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verifies the Shogo-platform prompt surfaces (channels, managed
 * integrations) are gated by `GatewayConfig.channelsEnabled` /
 * `integrationsEnabled` (default on). When all action surfaces
 * (channels, integrations, heartbeat) are off, the Action Tools guide is
 * dropped entirely and the Capabilities Index shrinks.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/test-capabilities-guide-toggles'

function setupWorkspace(extraConfig: Record<string, unknown> = {}): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      ...extraConfig,
    }),
  )
  writeFileSync(
    join(TEST_DIR, 'AGENTS.md'),
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.',
  )
}

describe('Capabilities / Action Tools prompt gating', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  async function buildGatewayAndTurn(): Promise<AgentGateway> {
    const mockStream = createMockStreamFn([buildTextResponse('ok')])
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()
    await gateway.processChatMessage('ping')
    return gateway
  }

  function section(label: string) {
    return (gateway.lastPromptBreakdown ?? []).find((s) => s.label === label)
  }

  test('action-tools + capabilities-index present by default', async () => {
    setupWorkspace()
    gateway = await buildGatewayAndTurn()

    expect(section('capabilities-index')).toBeDefined()
    expect(section('action-tools-guide')).toBeDefined()
    expect(section('action-tools-guide')!.zone).toBe('stable')
  })

  test('capabilities-index shrinks when channels are disabled', async () => {
    setupWorkspace()
    gateway = await buildGatewayAndTurn()
    const fullChars = section('capabilities-index')!.chars
    await gateway.stop()

    setupWorkspace({ channelsEnabled: false })
    gateway = await buildGatewayAndTurn()
    const trimmedChars = section('capabilities-index')!.chars

    expect(trimmedChars).toBeLessThan(fullChars)
  })

  test('action-tools-guide is dropped when channels + integrations are both off', async () => {
    // heartbeatEnabled is already false in the test config, so disabling
    // channels + integrations removes every action surface.
    setupWorkspace({ channelsEnabled: false, integrationsEnabled: false })
    gateway = await buildGatewayAndTurn()

    expect(section('action-tools-guide')).toBeUndefined()
    // The coding core of the Capabilities Index still ships.
    expect(section('capabilities-index')).toBeDefined()
    expect(section('code-agent-guide')).toBeDefined()
  })

  test('action-tools-guide survives when only integrations is enabled', async () => {
    setupWorkspace({ channelsEnabled: false })
    gateway = await buildGatewayAndTurn()

    expect(section('action-tools-guide')).toBeDefined()
  })
})
