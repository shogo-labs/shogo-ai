// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verifies the Shogo SDK guide section is gated by
 * `GatewayConfig.sdkGuideEnabled` (default on) and lands in the stable zone
 * of the assembled system prompt.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { SHOGO_SDK_GUIDE } from '../shogo-sdk-prompt'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/test-shogo-sdk-prompt'

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
    '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTest User\n\n# Operating Instructions\nYou are a test agent.',
  )
}

describe('Shogo SDK prompt section', () => {
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
    // _agentTurnInner is what populates lastPromptBreakdown via
    // loadBootstrapContext. processChatMessage funnels into it.
    await gateway.processChatMessage('ping')
    return gateway
  }

  test('section is present in the stable zone by default', async () => {
    setupWorkspace()
    gateway = await buildGatewayAndTurn()

    const sections = gateway.lastPromptBreakdown ?? []
    const sdk = sections.find((s) => s.label === 'shogo-sdk-guide')

    expect(sdk).toBeDefined()
    expect(sdk!.zone).toBe('stable')
    expect(sdk!.chars).toBeGreaterThan(0)
    expect(sdk!.chars).toBe(SHOGO_SDK_GUIDE.length)
  })

  test('section is omitted when sdkGuideEnabled is false', async () => {
    setupWorkspace({ sdkGuideEnabled: false })
    gateway = await buildGatewayAndTurn()

    const sections = gateway.lastPromptBreakdown ?? []
    const sdk = sections.find((s) => s.label === 'shogo-sdk-guide')

    expect(sdk).toBeUndefined()

    // Sanity: the rest of the stable prefix is still there — we only
    // dropped the SDK block, not the entire coding guide.
    const codingGuide = sections.find((s) => s.label === 'code-agent-guide')
    expect(codingGuide).toBeDefined()
    expect(codingGuide!.zone).toBe('stable')
  })

  test('section is included when sdkGuideEnabled is explicitly true', async () => {
    setupWorkspace({ sdkGuideEnabled: true })
    gateway = await buildGatewayAndTurn()

    const sections = gateway.lastPromptBreakdown ?? []
    const sdk = sections.find((s) => s.label === 'shogo-sdk-guide')

    expect(sdk).toBeDefined()
    expect(sdk!.zone).toBe('stable')
  })
})
