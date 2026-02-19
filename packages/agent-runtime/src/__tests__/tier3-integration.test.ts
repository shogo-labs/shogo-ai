/**
 * Tier 3 Integration Tests
 *
 * End-to-end tests for loop detection, session compaction,
 * and agent-managed cron through the full gateway stack.
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

    const response = await gateway.processTestMessage('Check the status repeatedly')

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

    const response = await gateway.processTestMessage('Merge files a and b into c')

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

    const response = await gateway.processTestMessage('Read x three times')

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

    await gateway.processTestMessage('Hi')

    const sm = gateway.getSessionManager()
    expect(sm.sessionCount).toBeGreaterThanOrEqual(1)

    await new Promise((r) => setTimeout(r, 100))

    const pruned = sm.pruneExpired()
    expect(pruned.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Tier 3: Cron manager integration', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('cron tool adds and lists jobs', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([
      buildToolUseResponse([{ name: 'cron', arguments: {
        action: 'add',
        name: 'daily-report',
        intervalSeconds: 86400,
        prompt: 'Generate daily report',
      }, id: 'toolu_1' }]),
      buildToolUseResponse([{ name: 'cron', arguments: { action: 'list' }, id: 'toolu_2' }]),
      buildTextResponse('Created daily-report job running every 24h.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const response = await gateway.processTestMessage('Set up a daily report cron job')
    expect(response).toContain('daily-report')

    const cm = gateway.getCronManager()
    const jobs = cm.listJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].name).toBe('daily-report')
    expect(jobs[0].intervalSeconds).toBe(86400)

    const cronPath = join(TEST_DIR, 'cron.json')
    expect(existsSync(cronPath)).toBe(true)
  })

  test('persisted cron jobs load on restart', async () => {
    setupWorkspace()

    writeFileSync(
      join(TEST_DIR, 'cron.json'),
      JSON.stringify([{
        name: 'persistent-job',
        intervalSeconds: 600,
        prompt: 'Do a thing',
        enabled: true,
        createdAt: new Date().toISOString(),
      }])
    )

    const mockStream = createMockStreamFn([buildTextResponse('ok')])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const cm = gateway.getCronManager()
    expect(cm.listJobs()).toHaveLength(1)
    expect(cm.getJob('persistent-job')?.prompt).toBe('Do a thing')
  })
})

describe('Tier 3: Status includes Tier 3 info', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('/status includes sessions and cron info', async () => {
    setupWorkspace()

    const mockStream = createMockStreamFn([buildTextResponse('Hello!')])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    await gateway.processTestMessage('Hi')
    gateway.getCronManager().addJob({
      name: 'status-test',
      intervalSeconds: 300,
      prompt: 'test',
    })

    const status = gateway.getStatus()
    expect(status.sessions).toBeDefined()
    expect(status.sessions!.length).toBeGreaterThanOrEqual(1)
    expect(status.cronJobs).toBeDefined()
    expect(status.cronJobs!).toHaveLength(1)
    expect(status.cronJobs![0].name).toBe('status-test')
  })
})

describe('Tier 3: Combined scenario — cron + compaction + loop detection', () => {
  let gateway: AgentGateway

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('long conversation with cron job setup and session compaction', async () => {
    setupWorkspace()

    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
        session: { maxMessages: 6, keepRecentMessages: 2 },
      })
    )

    const mockStream = createMockStreamFn([
      // Turn 1: Agent sets up a cron job
      buildToolUseResponse([{ name: 'cron', arguments: {
        action: 'add',
        name: 'check-logs',
        intervalSeconds: 600,
        prompt: 'Check application logs for errors',
      }, id: 'toolu_1' }]),
      buildTextResponse('Set up check-logs cron job to run every 10 minutes.'),
      // Turn 2
      buildTextResponse('The job is configured and running.'),
      // Turn 3
      buildTextResponse('Everything looks good.'),
      // Turn 4 (should trigger compaction)
      buildTextResponse('Session is now compacted, continuing.'),
    ])

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    const mockTelegram = new MockChannel('telegram')
    mockTelegram.connected = true
    injectMockChannel(gateway, mockTelegram)

    await gateway.processMessage({
      text: 'Set up a cron job to check logs every 10 minutes',
      channelId: 'chat-1',
      channelType: 'telegram',
      senderId: 'user-1',
    })

    await gateway.processMessage({
      text: 'Is the job running?',
      channelId: 'chat-1',
      channelType: 'telegram',
      senderId: 'user-1',
    })

    await gateway.processMessage({
      text: 'How does it look?',
      channelId: 'chat-1',
      channelType: 'telegram',
      senderId: 'user-1',
    })

    await gateway.processMessage({
      text: 'Great, anything else to report?',
      channelId: 'chat-1',
      channelType: 'telegram',
      senderId: 'user-1',
    })

    const cm = gateway.getCronManager()
    expect(cm.listJobs()).toHaveLength(1)
    expect(cm.getJob('check-logs')?.enabled).toBe(true)

    const sm = gateway.getSessionManager()
    const session = sm.get('chat-1')
    expect(session).toBeDefined()
    expect(session!.compactionCount).toBeGreaterThanOrEqual(1)

    expect(mockTelegram.sentMessages).toHaveLength(4)
  })
})
