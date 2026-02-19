import { describe, test, expect } from 'bun:test'
import { parseSlashCommand, isSlashCommand } from '../slash-commands'
import type { SlashCommandContext } from '../slash-commands'
import type { Message, UserMessage, AssistantMessage } from '@mariozechner/pi-ai'

function createMockCtx(overrides?: Partial<SlashCommandContext>): SlashCommandContext {
  const messages: Message[] = [
    { role: 'user', content: 'Hello', timestamp: Date.now() } as UserMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    } as AssistantMessage,
  ]
  let currentModel: string | undefined

  return {
    sessionKey: 'test-session',
    workspaceDir: '/tmp/test-slash',
    clearHistory: () => {
      messages.length = 0
    },
    getMessages: () => [...messages],
    reloadConfig: () => {},
    setModelOverride: (model: string) => {
      currentModel = model
    },
    getStatus: () => ({
      running: true,
      heartbeat: {
        enabled: false,
        intervalSeconds: 1800,
        lastTick: null,
        nextTick: null,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      },
      channels: [],
      skills: [],
      model: { provider: 'anthropic', name: currentModel || 'claude-sonnet-4-5' },
    }),
    ...overrides,
  }
}

describe('isSlashCommand', () => {
  test('recognizes valid commands', () => {
    expect(isSlashCommand('/new')).toBe(true)
    expect(isSlashCommand('/reset')).toBe(true)
    expect(isSlashCommand('/stop')).toBe(true)
    expect(isSlashCommand('/model claude-haiku-4-5')).toBe(true)
    expect(isSlashCommand('/status')).toBe(true)
    expect(isSlashCommand('/memory')).toBe(true)
    expect(isSlashCommand('/help')).toBe(true)
  })

  test('rejects non-commands', () => {
    expect(isSlashCommand('hello')).toBe(false)
    expect(isSlashCommand('/unknown')).toBe(false)
    expect(isSlashCommand('')).toBe(false)
    expect(isSlashCommand('not /new')).toBe(false)
  })

  test('handles commands with leading whitespace', () => {
    expect(isSlashCommand('  /new')).toBe(true)
  })
})

describe('parseSlashCommand', () => {
  test('/new clears history and returns hook event', () => {
    let cleared = false
    const ctx = createMockCtx({
      clearHistory: () => {
        cleared = true
      },
    })

    const result = parseSlashCommand('/new', ctx)

    expect(result.handled).toBe(true)
    expect(result.response).toContain('Session cleared')
    expect(cleared).toBe(true)
    expect(result.hookEvent).toBeDefined()
    expect(result.hookEvent!.action).toBe('new')
    expect(result.hookEvent!.context.sessionMessages).toBeDefined()
  })

  test('/reset reloads config', () => {
    let reloaded = false
    const ctx = createMockCtx({
      reloadConfig: () => {
        reloaded = true
      },
    })

    const result = parseSlashCommand('/reset', ctx)

    expect(result.handled).toBe(true)
    expect(result.response).toContain('reloaded')
    expect(reloaded).toBe(true)
    expect(result.hookEvent?.action).toBe('reset')
  })

  test('/stop sets stop flag', () => {
    const result = parseSlashCommand('/stop', createMockCtx())
    expect(result.handled).toBe(true)
    expect(result.hookEvent?.action).toBe('stop')
  })

  test('/model with name sets override', () => {
    let setModel: string | undefined
    const ctx = createMockCtx({
      setModelOverride: (m) => {
        setModel = m
      },
    })

    const result = parseSlashCommand('/model claude-haiku-4-5', ctx)

    expect(result.handled).toBe(true)
    expect(result.response).toContain('claude-haiku-4-5')
    expect(setModel).toBe('claude-haiku-4-5')
  })

  test('/model without name shows usage', () => {
    const result = parseSlashCommand('/model', createMockCtx())
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Usage')
  })

  test('/status returns agent info', () => {
    const result = parseSlashCommand('/status', createMockCtx())
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Running: true')
    expect(result.response).toContain('Heartbeat')
  })

  test('/help lists all commands', () => {
    const result = parseSlashCommand('/help', createMockCtx())
    expect(result.handled).toBe(true)
    expect(result.response).toContain('/new')
    expect(result.response).toContain('/reset')
    expect(result.response).toContain('/model')
    expect(result.response).toContain('/status')
  })

  test('non-command returns handled: false', () => {
    const result = parseSlashCommand('hello world', createMockCtx())
    expect(result.handled).toBe(false)
  })

  test('unknown /command returns handled: false', () => {
    const result = parseSlashCommand('/deploy', createMockCtx())
    expect(result.handled).toBe(false)
  })

  test('is case insensitive for command name', () => {
    const result = parseSlashCommand('/NEW', createMockCtx())
    expect(result.handled).toBe(true)
  })
})
