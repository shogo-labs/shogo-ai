// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tier 3 Integration Tests
 *
 * End-to-end tests for loop detection and session compaction
 * through the full gateway stack.
 *
 * Uses Pi Agent Core's mock streamFn instead of fetch interception.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockChannel } from './helpers/mock-channel'

const TEST_DIR = '/tmp/test-tier3-integration'

function setupWorkspace(extras?: Record<string, string>) {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agent\nYou are a helpful AI agent.')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\n')

  for (const [file, content] of Object.entries(extras || {})) {
    const filePath = join(TEST_DIR, file)
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, content)
  }
}

function injectMockChannel(gateway: AgentGateway, channel: MockChannel): void {
  ;(gateway as any).channels.set(channel.channelType, channel)
}

describe('Tier 3: Loop detection in agent turns', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('loop detector breaks agent out of identical tool call loop', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'status.json' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'status.json' }, id: 'toolu_2' }]),
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'status.json' }, id: 'toolu_3' }]),
      buildTextResponse('Should not reach here'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Check the status repeatedly')

    expect(response).toContain('LOOP DETECTED')
  })

  test('loop detector does NOT trigger on varied tool calls', async () => {
    setupWorkspace({
      'a.txt': 'content a',
      'b.txt': 'content b',
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'a.txt' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'b.txt' }, id: 'toolu_2' }]),
      buildToolUseResponse([{ name: 'write_file', arguments: { path: 'c.txt', content: 'merged' }, id: 'toolu_3' }]),
      buildTextResponse('All files processed successfully.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Merge files a and b into c')

    expect(response).not.toContain('LOOP DETECTED')
    expect(response).toContain('successfully')
  })

  test('loop detection can be disabled via config', async () => {
    setupWorkspace()

    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        loopDetection: false,
      })
    )

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'x' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'x' }, id: 'toolu_2' }]),
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'x' }, id: 'toolu_3' }]),
      buildTextResponse('Done reading three times.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Read x three times')

    expect(response).not.toContain('LOOP DETECTED')
    expect(response).toContain('Done reading')
  })
})

describe('Tier 3: Session compaction through gateway', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('session auto-compacts when maxMessages exceeded via channel', async () => {
    setupWorkspace()

    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        session: { maxMessages: 4, keepRecentMessages: 2 },
      })
    )

    const responses = Array.from({ length: 10 }, (_, i) => buildTextResponse(`Reply ${i}`))
    const mockStream = createMockStreamFn(responses)

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockTelegram = new MockChannel('telegram')
    mockTelegram.connected = true
    injectMockChannel(gateway, mockTelegram)

    for (let i = 0; i < 4; i++) {
      await gateway.processMessage({
        text: `Message ${i}`,
        channelId: 'chat-1',
        channelType: 'telegram',
        senderId: 'user-1',
      })
    }

    expect(mockTelegram.sentMessages).toHaveLength(4)

    const sm = gateway.getSessionManager()
    const session = sm.get('chat-1')
    expect(session).toBeDefined()
    expect(session!.compactionCount).toBeGreaterThanOrEqual(1)
    expect(session!.messages.length).toBeLessThanOrEqual(4)
  })
})

describe('Tier 3: Session TTL expiry', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('expired sessions are pruned', async () => {
    setupWorkspace()

    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        session: { sessionTtlSeconds: 0.05 },
      })
    )

    const mockStream = createMockStreamFn([buildTextResponse('Hello!')])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processChatMessage('Hi')

    const sm = gateway.getSessionManager()
    expect(sm.sessionCount).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 100))

    const pruned = sm.pruneExpired()
    expect(pruned.length).toBeGreaterThanOrEqual(1)
  })
})


describe('Tier 3: Status includes Tier 3 info', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('/status includes sessions info', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([buildTextResponse('Hello!')])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processChatMessage('Hi')

    const status = gateway.getStatus()
    expect(status.sessions).toBeDefined()
    expect(status.sessions!.length).toBeGreaterThanOrEqual(1)
  })
})

