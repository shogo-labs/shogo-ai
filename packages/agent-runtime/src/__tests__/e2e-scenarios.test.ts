// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-End Scenario Tests
 *
 * These tests exercise realistic multi-step flows through the entire gateway:
 * channels -> slash commands -> skills -> agent loop -> tools -> hooks -> responses.
 * Each test simulates a complete user scenario with multiple interactions.
 *
 * Uses Pi Agent Core's mock streamFn instead of fetch interception.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockChannel } from './helpers/mock-channel'
import type { Message } from '@mariozechner/pi-ai'

const TEST_DIR = '/tmp/test-e2e-scenarios'

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
  writeFileSync(join(TEST_DIR, 'SOUL.md'), '# Soul\nBe concise and take action.')
  writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\nTest Agent')
  writeFileSync(join(TEST_DIR, 'USER.md'), '# User\nAlex, timezone: America/Los_Angeles')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\n- User prefers TypeScript\n- Project uses Bun')

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

describe('E2E: Multi-tool agent workflows', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('agent reads config, checks status, and writes a report', async () => {
    setupWorkspace({
      'deploy-log.txt': 'v2.3.1 deployed at 14:30\nv2.3.2 deployed at 16:45\nv2.3.3 FAILED at 18:00',
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'deploy-log.txt' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'write_file', arguments: {
        path: 'reports/deploy-summary.md',
        content: '# Deploy Summary\n- 2 successful, 1 failed\n- Last failure: v2.3.3 at 18:00',
      }, id: 'toolu_2' }]),
      buildTextResponse('Deploy report generated. 2 successful deployments, 1 failure (v2.3.3 at 18:00). Report saved to reports/deploy-summary.md.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Check the deploy log and write a summary report')

    expect(response).toContain('v2.3.3')
    expect(response).toContain('failure')

    const reportPath = join(TEST_DIR, 'reports/deploy-summary.md')
    expect(existsSync(reportPath)).toBe(true)
    const report = readFileSync(reportPath, 'utf-8')
    expect(report).toContain('Deploy Summary')
    expect(report).toContain('failed')
  })

  test('agent reads a file, transforms it, and writes the result', async () => {
    setupWorkspace({
      'data/users.csv': 'name,email\nAlice,alice@example.com\nBob,bob@example.com\nCharlie,charlie@example.com',
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'data/users.csv' }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'write_file', arguments: {
        path: 'data/users.json',
        content: JSON.stringify([
          { name: 'Alice', email: 'alice@example.com' },
          { name: 'Bob', email: 'bob@example.com' },
          { name: 'Charlie', email: 'charlie@example.com' },
        ], null, 2),
      }, id: 'toolu_2' }]),
      buildTextResponse('Converted users.csv to users.json. 3 records processed.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processChatMessage('Convert data/users.csv to JSON format')

    expect(response).toContain('3 records')

    const jsonPath = join(TEST_DIR, 'data/users.json')
    expect(existsSync(jsonPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'))
    expect(parsed).toHaveLength(3)
    expect(parsed[0].name).toBe('Alice')
    expect(parsed[2].email).toBe('charlie@example.com')
  })
})

describe('E2E: Channel message flow with tools', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('message through mock channel triggers tool use and response is sent back', async () => {
    setupWorkspace({
      'notes.md': '# Meeting Notes\n- Q4 revenue up 15%\n- Hiring 3 engineers\n- Launch date: March 1',
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'notes.md' }, id: 'toolu_1' }]),
      buildTextResponse('Meeting notes summary: Q4 revenue up 15%, hiring 3 engineers, launching March 1.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockTelegram = new MockChannel('telegram')
    mockTelegram.connected = true
    injectMockChannel(gateway, mockTelegram)

    await gateway.processMessage({
      text: 'Summarize the meeting notes',
      channelId: '12345',
      channelType: 'telegram',
      senderId: 'user-1',
      senderName: 'Alex',
      timestamp: Date.now(),
    })

    expect(mockTelegram.sentMessages).toHaveLength(1)
    expect(mockTelegram.sentMessages[0].channelId).toBe('12345')
    expect(mockTelegram.sentMessages[0].content).toContain('Q4 revenue')
    expect(mockTelegram.sentMessages[0].content).toContain('March 1')
  })

  test('slash command /status is handled without LLM call', async () => {
    setupWorkspace()

    let llmCalled = false
    const mockStream = createMockStreamFn(
      [buildTextResponse('should not be called')],
      () => { llmCalled = true }
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockDiscord = new MockChannel('discord')
    mockDiscord.connected = true
    injectMockChannel(gateway, mockDiscord)

    await gateway.processMessage({
      text: '/status',
      channelId: 'chan-1',
      channelType: 'discord',
      senderId: 'user-1',
    })

    expect(llmCalled).toBe(false)
    expect(mockDiscord.sentMessages).toHaveLength(1)
    expect(mockDiscord.sentMessages[0].content).toContain('Running: true')
    expect(mockDiscord.sentMessages[0].content).toContain('Model: claude-sonnet-4-5')
  })

  test('agent send_message tool delivers cross-channel notifications', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'send_message', arguments: {
        channel: 'discord',
        channelId: 'alerts-channel',
        message: 'Deployment v2.4.0 completed successfully!',
      }, id: 'toolu_1' }]),
      buildTextResponse('Notification sent to Discord #alerts channel.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockTelegram = new MockChannel('telegram')
    mockTelegram.connected = true
    const mockDiscord = new MockChannel('discord')
    mockDiscord.connected = true
    injectMockChannel(gateway, mockTelegram)
    injectMockChannel(gateway, mockDiscord)

    await gateway.processMessage({
      text: 'Notify the Discord alerts channel that v2.4.0 deployed',
      channelId: 'tg-123',
      channelType: 'telegram',
      senderId: 'user-1',
    })

    expect(mockTelegram.sentMessages).toHaveLength(1)
    expect(mockTelegram.sentMessages[0].content).toContain('Notification sent')

    expect(mockDiscord.sentMessages).toHaveLength(1)
    expect(mockDiscord.sentMessages[0].channelId).toBe('alerts-channel')
    expect(mockDiscord.sentMessages[0].content).toContain('v2.4.0')
  })
})

describe('E2E: BOOT.md with tool execution', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('BOOT.md startup writes a status file and records to memory', async () => {
    const bootTime = new Date().toISOString()
    setupWorkspace({
      'BOOT.md': '# Startup\n- Write current timestamp to status/boot.txt\n- Record startup in memory',
    })

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'write_file', arguments: {
        path: 'status/boot.txt',
        content: `Agent started at ${bootTime}`,
      }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'memory_write', arguments: {
        file: 'MEMORY.md',
        content: `\n- Agent booted at ${bootTime}`,
        append: true,
      }, id: 'toolu_2' }]),
      buildTextResponse('Startup complete. Status written and memory updated.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const statusPath = join(TEST_DIR, 'status/boot.txt')
    expect(existsSync(statusPath)).toBe(true)
    expect(readFileSync(statusPath, 'utf-8')).toContain('Agent started at')

    const memory = readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')
    expect(memory).toContain('Agent booted at')
  })
})

describe('E2E: Multi-turn conversation with tool context', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('session history accumulates across turns', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([
      buildTextResponse('Hello Alice!'),
      buildTextResponse('Your name is Alice.'),
      buildTextResponse('Still Alice!'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const r1 = await gateway.processChatMessage('My name is Alice')
    expect(r1).toBe('Hello Alice!')

    const r2 = await gateway.processChatMessage('What is my name?')
    expect(r2).toBe('Your name is Alice.')

    const r3 = await gateway.processChatMessage('Tell me again?')
    expect(r3).toBe('Still Alice!')
  })

  test('/new clears history so next turn starts fresh', async () => {
    setupWorkspace()

    const capturedMessages: Message[][] = []
    const mockStream = createMockStreamFn(
      [
        buildTextResponse('Hello Alice!'),
        buildTextResponse('I have no context about you.'),
      ],
      (_idx, msgs) => { capturedMessages.push([...msgs]) }
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockTelegram = new MockChannel('telegram')
    mockTelegram.connected = true
    injectMockChannel(gateway, mockTelegram)

    await gateway.processMessage({
      text: 'My name is Alice',
      channelId: '123',
      channelType: 'telegram',
      senderId: 'alice',
    })

    await gateway.processMessage({
      text: '/new',
      channelId: '123',
      channelType: 'telegram',
      senderId: 'alice',
    })

    await gateway.processMessage({
      text: 'What do you know about me?',
      channelId: '123',
      channelType: 'telegram',
      senderId: 'alice',
    })

    // After /new, second LLM call should have fewer messages than first would accumulate
    expect(capturedMessages.length).toBe(2)
    // First call has just the prompt (no prior history)
    // Second call (after /new) should also have just the prompt
    expect(capturedMessages[1].length).toBeLessThanOrEqual(capturedMessages[0].length)
  })
})
