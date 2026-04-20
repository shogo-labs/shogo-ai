// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import type { Message } from '@mariozechner/pi-ai'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'

const TEST_DIR = '/tmp/test-gateway-integration'

function setupWorkspace() {
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
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nTest Agent\n\n# Personality\nBe helpful.\n\n# User\nTest User\n\n# Operating Instructions\nYou are a test agent.')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\nTest memory.')
}

describe('AgentGateway integration', () => {
  let gateway: AgentGateway
  let capturedMessages: Message[][]

  beforeEach(() => {
    setupWorkspace()
    capturedMessages = []
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  function createGateway(responses: Parameters<typeof createMockStreamFn>[0]) {
    const mockStream = createMockStreamFn(responses, (_idx, msgs) => {
      capturedMessages.push([...msgs])
    })
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    return gateway
  }

  test('processChatMessage sends to agent loop and returns text', async () => {
    gateway = createGateway([buildTextResponse('Test response from agent.')])
    await gateway.start()

    const response = await gateway.processChatMessage('Hello agent')

    expect(response).toBe('Test response from agent.')
    expect(capturedMessages).toHaveLength(1)
  })

  test('agent loop uses tools during a turn', async () => {
    writeFileSync(join(TEST_DIR, 'data.txt'), 'important data')

    gateway = createGateway([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'data.txt' }, id: 'toolu_1' }]),
      buildTextResponse('The file contains: important data'),
    ])
    await gateway.start()

    const response = await gateway.processChatMessage('Read data.txt')

    expect(response).toBe('The file contains: important data')
    expect(capturedMessages.length).toBeGreaterThanOrEqual(1)
  })

  test('heartbeat returns HEARTBEAT_OK', async () => {
    writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), '- Check system status')
    writeFileSync(
      join(TEST_DIR, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: true,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      })
    )

    gateway = createGateway([buildTextResponse('HEARTBEAT_OK')])
    await gateway.start()

    const result = await gateway.triggerHeartbeat()

    expect(result).toBe('HEARTBEAT_OK')
  })

  test('heartbeat includes pending webhook events', async () => {
    writeFileSync(join(TEST_DIR, 'HEARTBEAT.md'), '- Check for events')

    let promptsSeen: string[] = []
    const mockStream = createMockStreamFn(
      [buildTextResponse('HEARTBEAT_OK')],
      (_idx, msgs) => {
        for (const m of msgs) {
          if (m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : (m.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
            if (text) promptsSeen.push(text)
          }
        }
      }
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    gateway.queuePendingEvent('New email from boss')
    gateway.queuePendingEvent('Deployment failed')

    await gateway.triggerHeartbeat()

    const allText = promptsSeen.join(' ')
    expect(allText).toContain('Pending Events')
    expect(allText).toContain('New email from boss')
    expect(allText).toContain('Deployment failed')
  })

  test('processWebhookMessage runs isolated turn', async () => {
    gateway = createGateway([buildTextResponse('Webhook processed.')])
    await gateway.start()

    const result = await gateway.processWebhookMessage('External trigger')

    expect(result).toBe('Webhook processed.')
  })

  test('BOOT.md is executed on start', async () => {
    writeFileSync(join(TEST_DIR, 'BOOT.md'), '# Startup\n- Announce yourself')

    let bootSeen = false
    const mockStream = createMockStreamFn(
      [buildTextResponse('Agent online and ready.')],
      (_idx, msgs) => {
        for (const m of msgs) {
          if (m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : (m.content as any[]).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
            if (text.includes('BOOT')) bootSeen = true
          }
        }
      }
    )

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(mockStream)
    await gateway.start()

    expect(bootSeen).toBe(true)
  })

  test('BOOT.md is skipped when file is missing', async () => {
    gateway = createGateway([buildTextResponse('Should not be called.')])
    await gateway.start()

    // No BOOT.md => no calls
    expect(capturedMessages).toHaveLength(0)
  })

  test('session history accumulates across turns', async () => {
    gateway = createGateway([
      buildTextResponse('Hello Alice!'),
      buildTextResponse('Your name is Alice.'),
    ])
    await gateway.start()

    await gateway.processChatMessage('My name is Alice')
    await gateway.processChatMessage('What is my name?')

    // Second call should have more messages (history from first call)
    expect(capturedMessages).toHaveLength(2)
    expect(capturedMessages[1].length).toBeGreaterThan(capturedMessages[0].length)
  })

  test('system prompt includes uploaded files context when files exist', async () => {
    const filesDir = join(TEST_DIR, 'files')
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(join(filesDir, 'report.csv'), 'name,revenue\nAcme,1000\nGlobo,2000')
    writeFileSync(join(filesDir, 'notes.txt'), 'Important meeting notes')

    let systemPromptSeen = ''
    const mockStream = createMockStreamFn(
      [buildTextResponse('I can see your files.')],
    )
    const wrappedStream: any = (_model: any, context: any, options: any) => {
      // Capture system prompt from whichever property it's on
      const sp = context.systemPrompt || context.system || ''
      if (sp) systemPromptSeen = sp
      return mockStream(_model, context, options)
    }

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(wrappedStream)
    await gateway.start()

    await gateway.processChatMessage('What files do I have?')

    expect(systemPromptSeen).toContain('Workspace Uploaded Files')
    expect(systemPromptSeen).toContain('report.csv')
    expect(systemPromptSeen).toContain('notes.txt')
  })

  test('system prompt does not list files when files/ is empty', async () => {
    let systemPromptSeen = ''
    const mockStream = createMockStreamFn(
      [buildTextResponse('No files here.')],
    )
    const wrappedStream: any = (_model: any, context: any, options: any) => {
      const sp = context.systemPrompt || context.system || ''
      if (sp) systemPromptSeen = sp
      return mockStream(_model, context, options)
    }

    gateway = new AgentGateway(TEST_DIR, 'test-project')
    gateway.setStreamFn(wrappedStream)
    await gateway.start()

    await gateway.processChatMessage('Hello')

    // The tool planning guide mentions "Uploaded Files" as a section,
    // but no specific file listings should appear
    expect(systemPromptSeen).not.toContain('report.csv')
    expect(systemPromptSeen).not.toContain('notes.txt')
    expect(systemPromptSeen).not.toContain('Workspace Uploaded Files')
  })

  test('system prompt includes Running App Preview section when project/dist/index.html exists', async () => {
    // Simulate a running preview by placing a built dist/index.html on disk —
    // this is the same signal PreviewManager uses to mark the preview as
    // ready. The gateway reads it to decide whether to inject the URL.
    const distDir = join(TEST_DIR, 'project', 'dist')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html></html>')

    // Set PUBLIC_PREVIEW_URL to a fake k8s subdomain so we can assert the
    // external URL is the one the agent gets told about (not localhost).
    const originalPublicUrl = process.env.PUBLIC_PREVIEW_URL
    process.env.PUBLIC_PREVIEW_URL = 'https://preview--test-project.dev.shogo.ai'

    try {
      let systemPromptSeen = ''
      const mockStream = createMockStreamFn([buildTextResponse('ok')])
      const wrappedStream: any = (_model: any, context: any, options: any) => {
        const sp = context.systemPrompt || context.system || ''
        if (sp) systemPromptSeen = sp
        return mockStream(_model, context, options)
      }

      gateway = new AgentGateway(TEST_DIR, 'test-project')
      gateway.setStreamFn(wrappedStream)
      await gateway.start()

      await gateway.processChatMessage('hi')

      expect(systemPromptSeen).toContain('## Running App Preview')
      expect(systemPromptSeen).toContain('https://preview--test-project.dev.shogo.ai')
      // The section must be the declared source of truth so the agent doesn't
      // go probe the filesystem / ports for it.
      expect(systemPromptSeen).toContain('single source of truth')
      // Must steer away from reading config files — the hallucinated 5173
      // port came from the template's vite.config.ts, which is never the
      // actual runtime port.
      expect(systemPromptSeen).toContain('vite.config.ts')
      // Defense-in-depth: the block must NOT name hallucinated paths, even as
      // "don't use this" — mentioning them re-teaches the model they exist.
      expect(systemPromptSeen).not.toContain('.shogo/preview-url')
      expect(systemPromptSeen).not.toContain('lsof')
    } finally {
      if (originalPublicUrl === undefined) {
        delete process.env.PUBLIC_PREVIEW_URL
      } else {
        process.env.PUBLIC_PREVIEW_URL = originalPublicUrl
      }
    }
  })

  test('system prompt omits Running App Preview section when no dist/ exists and PUBLIC_PREVIEW_URL is unset', async () => {
    // Neither launcher signal is present: no dist/ on disk AND no env var.
    // Gateway has no basis to advertise a URL and must stay silent rather
    // than invent one.
    const originalPublicUrl = process.env.PUBLIC_PREVIEW_URL
    delete process.env.PUBLIC_PREVIEW_URL

    try {
      let systemPromptSeen = ''
      const mockStream = createMockStreamFn([buildTextResponse('ok')])
      const wrappedStream: any = (_model: any, context: any, options: any) => {
        const sp = context.systemPrompt || context.system || ''
        if (sp) systemPromptSeen = sp
        return mockStream(_model, context, options)
      }

      gateway = new AgentGateway(TEST_DIR, 'test-project')
      gateway.setStreamFn(wrappedStream)
      await gateway.start()

      await gateway.processChatMessage('hi')

      expect(systemPromptSeen).not.toContain('## Running App Preview')
    } finally {
      if (originalPublicUrl !== undefined) {
        process.env.PUBLIC_PREVIEW_URL = originalPublicUrl
      }
    }
  })

  test('system prompt includes Running App Preview section when PUBLIC_PREVIEW_URL is set even without dist/ (local Vite dev)', async () => {
    // Local RuntimeManager spawns `vite` (dev mode), which serves from memory
    // — no project/dist/index.html ever gets written. The launcher signals
    // the real Vite port via PUBLIC_PREVIEW_URL, and the gateway must trust
    // it. This is the scenario that caused the original hallucinated-5173 bug.
    const originalPublicUrl = process.env.PUBLIC_PREVIEW_URL
    process.env.PUBLIC_PREVIEW_URL = 'http://localhost:37423'

    try {
      let systemPromptSeen = ''
      const mockStream = createMockStreamFn([buildTextResponse('ok')])
      const wrappedStream: any = (_model: any, context: any, options: any) => {
        const sp = context.systemPrompt || context.system || ''
        if (sp) systemPromptSeen = sp
        return mockStream(_model, context, options)
      }

      gateway = new AgentGateway(TEST_DIR, 'test-project')
      gateway.setStreamFn(wrappedStream)
      await gateway.start()

      await gateway.processChatMessage('hi')

      expect(systemPromptSeen).toContain('## Running App Preview')
      expect(systemPromptSeen).toContain('http://localhost:37423')
      // The block must explicitly steer the agent away from reading
      // vite.config.ts, which is where the 5173 hallucination came from.
      expect(systemPromptSeen).toContain('vite.config.ts')
      expect(systemPromptSeen).not.toContain('5173')
    } finally {
      if (originalPublicUrl === undefined) {
        delete process.env.PUBLIC_PREVIEW_URL
      } else {
        process.env.PUBLIC_PREVIEW_URL = originalPublicUrl
      }
    }
  })

  test('system prompt includes Running App Preview when only workspaceDir/dist exists (local RuntimeManager layout)', async () => {
    // Local dev layout: WORKSPACE_DIR === projectDir, so dist/ sits directly
    // under the workspace root, not under workspace/project/dist.
    const distDir = join(TEST_DIR, 'dist')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html></html>')

    const originalPublicUrl = process.env.PUBLIC_PREVIEW_URL
    delete process.env.PUBLIC_PREVIEW_URL

    try {
      let systemPromptSeen = ''
      const mockStream = createMockStreamFn([buildTextResponse('ok')])
      const wrappedStream: any = (_model: any, context: any, options: any) => {
        const sp = context.systemPrompt || context.system || ''
        if (sp) systemPromptSeen = sp
        return mockStream(_model, context, options)
      }

      gateway = new AgentGateway(TEST_DIR, 'test-project')
      gateway.setStreamFn(wrappedStream)
      await gateway.start()

      await gateway.processChatMessage('hi')

      expect(systemPromptSeen).toContain('## Running App Preview')
    } finally {
      if (originalPublicUrl !== undefined) {
        process.env.PUBLIC_PREVIEW_URL = originalPublicUrl
      }
    }
  })

  test('daily memory is written after message processing', async () => {
    gateway = createGateway([buildTextResponse('Response here.')])
    await gateway.start()

    await gateway.processChatMessage('Test message')

    const date = new Date().toISOString().split('T')[0]
    const memoryFile = join(TEST_DIR, 'memory', `${date}.md`)
    expect(existsSync(memoryFile)).toBe(true)

    const content = readFileSync(memoryFile, 'utf-8')
    expect(content).toContain('Test message')
  })
})
