// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, createHeartbeatTools, TOOL_GROUP_MAP, ALL_TOOL_NAMES, resolveToolNames, type ToolContext } from '../gateway-tools'
import { MCPClientManager } from '../mcp-client'
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
  const tools = createTools(ctx)
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

  describe('edit_file', () => {
    test('exact match replacement', async () => {
      writeFileSync(join(TEST_DIR, 'code.py'), 'def hello():\n    return "world"\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'code.py',
        old_string: 'return "world"',
        new_string: 'return "universe"',
      })
      expect(result.ok).toBe(true)
      expect(result.replacements).toBe(1)
      expect(readFileSync(join(TEST_DIR, 'code.py'), 'utf-8')).toContain('return "universe"')
    })

    test('replace_all replaces multiple occurrences', async () => {
      writeFileSync(join(TEST_DIR, 'multi.py'), 'foo = 1\nbar = foo\nbaz = foo\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'multi.py',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      })
      expect(result.ok).toBe(true)
      expect(result.replacements).toBe(3)
      const content = readFileSync(join(TEST_DIR, 'multi.py'), 'utf-8')
      expect(content).not.toContain('foo')
      expect(content.split('qux').length - 1).toBe(3)
    })

    test('errors when old_string not unique and replace_all not set', async () => {
      writeFileSync(join(TEST_DIR, 'dup.py'), 'x = 1\nx = 2\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'dup.py',
        old_string: 'x = ',
        new_string: 'y = ',
      })
      expect(result.error).toContain('found 2 times')
    })

    test('errors when old_string equals new_string', async () => {
      writeFileSync(join(TEST_DIR, 'same.py'), 'hello\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'same.py',
        old_string: 'hello',
        new_string: 'hello',
      })
      expect(result.error).toContain('must differ')
    })

    test('errors for missing file', async () => {
      const result = await exec(createCtx(), 'edit_file', {
        path: 'nonexistent.py',
        old_string: 'a',
        new_string: 'b',
      })
      expect(result.error).toContain('not found')
    })

    test('fuzzy match: handles escaped quotes (\\\" → ")', async () => {
      writeFileSync(join(TEST_DIR, 'quotes.py'), 'msg = "hello world"\nprint(msg)\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'quotes.py',
        old_string: 'msg = \\"hello world\\"',
        new_string: 'msg = "goodbye world"',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'quotes.py'), 'utf-8')).toContain('msg = "goodbye world"')
    })

    test('fuzzy match: handles triple escaped quotes (doc strings)', async () => {
      writeFileSync(join(TEST_DIR, 'docstr.py'), '"""Defines the Foo class.\n\nThis does stuff.\n"""\nimport os\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'docstr.py',
        old_string: '\\"\\"\\"Defines the Foo class.\n\nThis does stuff.\n\\"\\"\\"',
        new_string: '"""Defines the Bar class.\n\nThis does other stuff.\n"""',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'docstr.py'), 'utf-8')).toContain('Defines the Bar class')
    })

    test('fuzzy match: trailing whitespace differences', async () => {
      writeFileSync(join(TEST_DIR, 'ws.py'), 'def foo():  \n    pass\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'ws.py',
        old_string: 'def foo():\n    pass',
        new_string: 'def bar():\n    pass',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'ws.py'), 'utf-8')).toContain('def bar()')
    })

    test('fuzzy match: tab vs space indentation', async () => {
      writeFileSync(join(TEST_DIR, 'indent.py'), '\tif x:\n\t\treturn True\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'indent.py',
        old_string: '    if x:\n        return True',
        new_string: '    if y:\n        return False',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'indent.py'), 'utf-8')).toContain('return False')
    })

    test('fuzzy match: CRLF vs LF line endings', async () => {
      writeFileSync(join(TEST_DIR, 'crlf.py'), 'line1\r\nline2\r\nline3\r\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'crlf.py',
        old_string: 'line1\nline2',
        new_string: 'lineA\nlineB',
      })
      expect(result.ok).toBe(true)
      const content = readFileSync(join(TEST_DIR, 'crlf.py'), 'utf-8')
      expect(content).toContain('lineA')
      expect(content).toContain('lineB')
    })

    test('returns hint when no match found', async () => {
      writeFileSync(join(TEST_DIR, 'hint.py'), 'def hello():\n    return 42\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'hint.py',
        old_string: 'def goodbye():\n    return 99',
        new_string: 'def goodbye():\n    return 100',
      })
      expect(result.error).toContain('old_string not found')
    })

    test('multiline exact replacement', async () => {
      writeFileSync(join(TEST_DIR, 'multi.txt'), 'aaa\nbbb\nccc\nddd\n')
      const result = await exec(createCtx(), 'edit_file', {
        path: 'multi.txt',
        old_string: 'bbb\nccc',
        new_string: 'BBB\nCCC',
      })
      expect(result.ok).toBe(true)
      expect(readFileSync(join(TEST_DIR, 'multi.txt'), 'utf-8')).toBe('aaa\nBBB\nCCC\nddd\n')
    })
  })

  describe('read_file on directory', () => {
    test('returns directory listing instead of EISDIR error', async () => {
      mkdirSync(join(TEST_DIR, 'mydir'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'mydir', 'a.txt'), 'content')
      writeFileSync(join(TEST_DIR, 'mydir', 'b.txt'), 'content')
      const result = await exec(createCtx(), 'read_file', { path: 'mydir' })
      expect(result.note).toContain('directory')
      expect(result.entries).toBeDefined()
      expect(result.count).toBe(2)
    })
  })

  describe('ls truncation', () => {
    test('truncates results when exceeding max entries', async () => {
      for (let i = 0; i < 250; i++) {
        writeFileSync(join(TEST_DIR, `file_${String(i).padStart(3, '0')}.txt`), `content ${i}`)
      }
      const result = await exec(createCtx(), 'ls', { path: '.', recursive: false })
      expect(result.count).toBe(200)
      expect(result.truncated).toBe(true)
      expect(result.totalEntries).toBe(250)
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
    test('createTools returns expected tools', () => {
      expect(createTools(createCtx())).toHaveLength(49)
      expect(createTools(createCtx()).find((t) => t.name === 'cron')).toBeUndefined()
      expect(createTools(createCtx()).find((t) => t.name === 'memory_search')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'browser')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_create')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_update')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_data')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_delete')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_action_wait')).toBeDefined()
    })

    test('createHeartbeatTools excludes exec and send_message', () => {
      const hbTools = createHeartbeatTools(createCtx())
      expect(hbTools).toHaveLength(11)
      expect(hbTools.find((t) => t.name === 'exec')).toBeUndefined()
      expect(hbTools.find((t) => t.name === 'send_message')).toBeUndefined()
      expect(hbTools.find((t) => t.name === 'cron')).toBeUndefined()
    })

    test('all tools have TypeBox parameters and label', () => {
      const tools = createTools(createCtx())
      for (const tool of tools) {
        expect(tool.label).toBeTruthy()
        expect(tool.parameters).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })
  })

  // =========================================================================
  // Tool vs MCP Discovery Split
  // =========================================================================

  describe('tool vs MCP discovery split', () => {
    test('all 6 discovery tools exist with correct names', () => {
      const tools = createTools(createCtx())
      const names = tools.map(t => t.name)

      expect(names).toContain('tool_search')
      expect(names).toContain('tool_install')
      expect(names).toContain('tool_uninstall')
      expect(names).toContain('mcp_search')
      expect(names).toContain('mcp_install')
      expect(names).toContain('mcp_uninstall')
    })

    test('tool_discovery group maps to Composio tools only', () => {
      expect(TOOL_GROUP_MAP.tool_discovery).toEqual(['tool_search', 'tool_install', 'tool_uninstall'])
    })

    test('mcp_discovery group maps to MCP tools only', () => {
      expect(TOOL_GROUP_MAP.mcp_discovery).toEqual(['mcp_search', 'mcp_install', 'mcp_uninstall'])
    })

    test('tool_discovery and mcp_discovery groups are disjoint', () => {
      const toolSet = new Set(TOOL_GROUP_MAP.tool_discovery)
      const mcpSet = new Set(TOOL_GROUP_MAP.mcp_discovery)
      for (const name of toolSet) {
        expect(mcpSet.has(name)).toBe(false)
      }
    })

    test('ALL_TOOL_NAMES includes all 6 discovery tools', () => {
      const names = ALL_TOOL_NAMES as readonly string[]
      expect(names).toContain('tool_search')
      expect(names).toContain('tool_install')
      expect(names).toContain('tool_uninstall')
      expect(names).toContain('mcp_search')
      expect(names).toContain('mcp_install')
      expect(names).toContain('mcp_uninstall')
    })

    test('resolveToolNames("tool_discovery") returns Composio tools', () => {
      const resolved = resolveToolNames(['tool_discovery'])
      expect(resolved).toContain('tool_search')
      expect(resolved).toContain('tool_install')
      expect(resolved).toContain('tool_uninstall')
      expect(resolved).not.toContain('mcp_search')
      expect(resolved).not.toContain('mcp_install')
      expect(resolved).not.toContain('mcp_uninstall')
    })

    test('resolveToolNames("mcp_discovery") returns MCP tools', () => {
      const resolved = resolveToolNames(['mcp_discovery'])
      expect(resolved).toContain('mcp_search')
      expect(resolved).toContain('mcp_install')
      expect(resolved).toContain('mcp_uninstall')
      expect(resolved).not.toContain('tool_search')
      expect(resolved).not.toContain('tool_install')
      expect(resolved).not.toContain('tool_uninstall')
    })

    test('tool_search has Composio-only description', () => {
      const tool = getTool(createCtx(), 'tool_search')
      expect(tool.description).toContain('managed OAuth')
      expect(tool.description).toContain('mcp_search')
      expect(tool.description).not.toContain('MCP_CATALOG')
    })

    test('mcp_search has MCP-only description', () => {
      const tool = getTool(createCtx(), 'mcp_search')
      expect(tool.description).toContain('MCP')
      expect(tool.description).toContain('protocol server')
      expect(tool.description).toContain('tool_search')
    })

    test('tool_install has Composio-only description without env/url/headers params', () => {
      const tool = getTool(createCtx(), 'tool_install')
      expect(tool.description).toContain('managed OAuth')
      expect(tool.description).toContain('mcp_install')
      const schema = JSON.stringify(tool.parameters)
      expect(schema).not.toContain('"url"')
      expect(schema).not.toContain('"headers"')
      expect(schema).not.toContain('"env"')
      expect(schema).toContain('"autoBind"')
      expect(schema).toContain('"bind"')
    })

    test('mcp_install has MCP-only description with env/url/headers params', () => {
      const tool = getTool(createCtx(), 'mcp_install')
      expect(tool.description).toContain('MCP')
      expect(tool.description).toContain('tool_install')
      const schema = JSON.stringify(tool.parameters)
      expect(schema).toContain('"url"')
      expect(schema).toContain('"headers"')
      expect(schema).toContain('"env"')
      expect(schema).not.toContain('"autoBind"')
      expect(schema).not.toContain('"bind"')
    })

    test('tool_install rejects non-Composio names and suggests mcp_install', async () => {
      const ctx = createCtx({ mcpClientManager: new MCPClientManager() })
      const result = await exec(ctx, 'tool_install', { name: 'postgres' })
      expect(result.error).toContain('not a managed integration')
      expect(result.error).toContain('mcp_install')
    })

    test('mcp_install rejects non-catalog names and suggests tool_install', async () => {
      const ctx = createCtx({ mcpClientManager: new MCPClientManager() })
      const result = await exec(ctx, 'mcp_install', { name: 'totally-unknown-server' })
      expect(result.error).toContain('not in the MCP catalog')
      expect(result.error).toContain('tool_install')
    })

    test('mcp_search returns catalog results with mcp_install commands', async () => {
      const result = await exec(createCtx(), 'mcp_search', { query: 'postgres' })
      expect(result.results.length).toBeGreaterThan(0)
      const first = result.results[0]
      expect(first.source).toBe('catalog')
      expect(first.installCommand).toContain('mcp_install')
      expect(first.installCommand).not.toContain('tool_install')
    })

    test('tool_search without Composio returns empty and suggests mcp_search', async () => {
      const result = await exec(createCtx(), 'tool_search', { query: 'postgres' })
      expect(result.results).toHaveLength(0)
      expect(result.message).toContain('mcp_search')
    })

    test('mcp_uninstall returns error for non-running server', async () => {
      const ctx = createCtx({ mcpClientManager: new MCPClientManager() })
      const result = await exec(ctx, 'mcp_uninstall', { name: 'postgres' })
      expect(result.error).toContain('not running')
    })

    test('tool_uninstall returns error for non-running integration', async () => {
      const ctx = createCtx({ mcpClientManager: new MCPClientManager() })
      const result = await exec(ctx, 'tool_uninstall', { name: 'slack' })
      expect(result.error).toContain('not running')
    })

    test('tool labels distinguish integrations from MCP servers', () => {
      const tools = createTools(createCtx())
      const toolSearch = tools.find(t => t.name === 'tool_search')!
      const mcpSearch = tools.find(t => t.name === 'mcp_search')!
      const toolInstall = tools.find(t => t.name === 'tool_install')!
      const mcpInstall = tools.find(t => t.name === 'mcp_install')!
      const toolUninstall = tools.find(t => t.name === 'tool_uninstall')!
      const mcpUninstall = tools.find(t => t.name === 'mcp_uninstall')!

      expect(toolSearch.label).toContain('Integration')
      expect(mcpSearch.label).toContain('MCP')
      expect(toolInstall.label).toContain('Integration')
      expect(mcpInstall.label).toContain('MCP')
      expect(toolUninstall.label).toContain('Integration')
      expect(mcpUninstall.label).toContain('MCP')
    })
  })
})
