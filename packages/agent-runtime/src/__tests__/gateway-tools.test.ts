import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createAllTools, createHeartbeatTools, type ToolContext } from '../gateway-tools'
import { MockChannel } from './helpers/mock-channel'

const TEST_DIR = '/tmp/test-gateway-tools'

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    ...overrides,
  }
}

function getTool(ctx: ToolContext, name: string) {
  const tools = createAllTools(ctx)
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

async function exec(ctx: ToolContext, name: string, params: Record<string, any>) {
  const tool = getTool(ctx, name)
  const result = await tool.execute('test-call', params)
  return result.details
}

describe('gateway-tools', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('exec', () => {
    test('runs a simple command', async () => {
      const result = await exec(createCtx(), 'exec', { command: 'echo hello' })
      expect(result.stdout).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    test('blocks destructive commands', async () => {
      const result = await exec(createCtx(), 'exec', { command: 'rm -rf /' })
      expect(result.error).toContain('Blocked command')
    })

    test('returns stderr on failure', async () => {
      const result = await exec(createCtx(), 'exec', { command: 'ls /nonexistent_dir_12345' })
      expect(result.exitCode).not.toBe(0)
    })

    test('runs in workspace directory', async () => {
      const result = await exec(createCtx(), 'exec', { command: 'pwd' })
      expect(result.stdout).toContain('test-gateway-tools')
    })
  })

  describe('read_file', () => {
    test('reads an existing file', async () => {
      writeFileSync(join(TEST_DIR, 'test.txt'), 'hello world')
      const result = await exec(createCtx(), 'read_file', { path: 'test.txt' })
      expect(result.content).toBe('hello world')
      expect(result.bytes).toBe(11)
    })

    test('returns error for missing file', async () => {
      const result = await exec(createCtx(), 'read_file', { path: 'missing.txt' })
      expect(result.error).toContain('not found')
    })

    test('blocks path traversal', async () => {
      try {
        await exec(createCtx(), 'read_file', { path: '../../../etc/passwd' })
        expect(true).toBe(false)
      } catch (err: any) {
        expect(err.message).toContain('outside workspace')
      }
    })
  })

  describe('write_file', () => {
    test('writes a new file', async () => {
      const result = await exec(createCtx(), 'write_file', { path: 'output.txt', content: 'test content' })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'output.txt'), 'utf-8')).toBe('test content')
    })

    test('creates parent directories', async () => {
      await exec(createCtx(), 'write_file', { path: 'subdir/deep/file.txt', content: 'nested' })
      expect(readFileSync(join(TEST_DIR, 'subdir/deep/file.txt'), 'utf-8')).toBe('nested')
    })

    test('appends to existing file', async () => {
      writeFileSync(join(TEST_DIR, 'append.txt'), 'first')
      await exec(createCtx(), 'write_file', { path: 'append.txt', content: ' second', append: true })
      expect(readFileSync(join(TEST_DIR, 'append.txt'), 'utf-8')).toBe('first second')
    })

    test('blocks path traversal', async () => {
      try {
        await exec(createCtx(), 'write_file', { path: '../../../etc/evil.txt', content: 'bad' })
        expect(true).toBe(false)
      } catch (err: any) {
        expect(err.message).toContain('outside workspace')
      }
    })
  })

  describe('memory_read', () => {
    test('reads MEMORY.md', async () => {
      writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\nSome facts')
      const result = await exec(createCtx(), 'memory_read', { file: 'MEMORY.md' })
      expect(result.exists).toBe(true)
      expect(result.content).toContain('Some facts')
    })

    test('reads daily log by date', async () => {
      mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'memory', '2026-02-18.md'), '# Feb 18\n- Entry')
      const result = await exec(createCtx(), 'memory_read', { file: '2026-02-18' })
      expect(result.exists).toBe(true)
      expect(result.content).toContain('Entry')
    })

    test('returns exists: false for missing file', async () => {
      const result = await exec(createCtx(), 'memory_read', { file: '2099-01-01' })
      expect(result.exists).toBe(false)
    })
  })

  describe('memory_write', () => {
    test('writes to MEMORY.md', async () => {
      await exec(createCtx(), 'memory_write', { file: 'MEMORY.md', content: '# Memory\nNew fact', append: false })
      expect(readFileSync(join(TEST_DIR, 'MEMORY.md'), 'utf-8')).toBe('# Memory\nNew fact')
    })

    test('appends to daily log', async () => {
      mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'memory', '2026-02-18.md'), 'existing')
      await exec(createCtx(), 'memory_write', { file: '2026-02-18', content: '\nnew entry' })
      const content = readFileSync(join(TEST_DIR, 'memory', '2026-02-18.md'), 'utf-8')
      expect(content).toContain('existing')
      expect(content).toContain('new entry')
    })
  })

  describe('send_message', () => {
    test('sends via a connected channel', async () => {
      const mockChannel = new MockChannel('telegram')
      mockChannel.connected = true
      const channels = new Map([['telegram', mockChannel as any]])

      const result = await exec(
        createCtx({ channels }),
        'send_message',
        { channel: 'telegram', channelId: '123', message: 'hello' }
      )
      expect(result.ok).toBe(true)
      expect(mockChannel.sentMessages).toHaveLength(1)
      expect(mockChannel.sentMessages[0].content).toBe('hello')
    })

    test('returns error for unconnected channel', async () => {
      const result = await exec(createCtx(), 'send_message', { channel: 'slack', channelId: '123', message: 'hello' })
      expect(result.error).toContain('not connected')
    })
  })

  describe('tool sets', () => {
    test('createAllTools returns expected tools', () => {
      expect(createAllTools(createCtx())).toHaveLength(33)
      expect(createAllTools(createCtx()).find((t) => t.name === 'cron')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'memory_search')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'browser')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'canvas_create')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'canvas_update')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'canvas_data')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'canvas_delete')).toBeDefined()
      expect(createAllTools(createCtx()).find((t) => t.name === 'canvas_action_wait')).toBeDefined()
    })

    test('createHeartbeatTools excludes exec and send_message', () => {
      const hbTools = createHeartbeatTools(createCtx())
      expect(hbTools).toHaveLength(9)
      expect(hbTools.find((t) => t.name === 'exec')).toBeUndefined()
      expect(hbTools.find((t) => t.name === 'send_message')).toBeUndefined()
      expect(hbTools.find((t) => t.name === 'cron')).toBeDefined()
    })

    test('all tools have TypeBox parameters and label', () => {
      const tools = createAllTools(createCtx())
      for (const tool of tools) {
        expect(tool.label).toBeTruthy()
        expect(tool.parameters).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })
  })
})
