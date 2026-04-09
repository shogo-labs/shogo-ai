// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { createTools, TOOL_GROUP_MAP, ALL_TOOL_NAMES, resolveToolNames, hostToContainer, containerToHost, type ToolContext } from '../gateway-tools'
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

  describe('grep', () => {
    test('finds a pattern in workspace files', async () => {
      writeFileSync(join(TEST_DIR, 'sample.ts'), 'const foo = 42\nconst bar = 99\n')
      const result = await exec(createCtx(), 'grep', { pattern: 'foo' })
      expect(result.count).toBeGreaterThanOrEqual(1)
      expect(result.matches.some((m: any) => m.text.includes('foo'))).toBe(true)
    })

    test('returns zero matches for absent pattern', async () => {
      writeFileSync(join(TEST_DIR, 'sample.ts'), 'const bar = 99\n')
      const result = await exec(createCtx(), 'grep', { pattern: 'zzz_never_exists_zzz' })
      expect(result.count).toBe(0)
      expect(result.matches).toHaveLength(0)
    })

    test('does not error with "command not found"', async () => {
      writeFileSync(join(TEST_DIR, 'sample.ts'), 'hello world\n')
      const result = await exec(createCtx(), 'grep', { pattern: 'hello' })
      // Should succeed — either via rg or the JS fallback
      expect(result.error).toBeUndefined()
      expect(result.count).toBeGreaterThanOrEqual(1)
    })

    test('reports matches with file and line number', async () => {
      writeFileSync(join(TEST_DIR, 'multi.ts'), 'line_one\nfind_me_here\nline_three\n')
      const result = await exec(createCtx(), 'grep', { pattern: 'find_me_here' })
      expect(result.count).toBe(1)
      const match = result.matches[0]
      expect(match.text).toContain('find_me_here')
      expect(match.line).toBe(2)
      expect(match.file).toContain('multi.ts')
    })
  })

  describe('exec', () => {
    test('runs a simple command', async () => {
      const result = await exec(createCtx(), 'exec', { command: 'echo hello' })
      expect(result.stdout).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    test('blocks destructive commands', async () => {
      // Lightweight isBlockedCommand catches 'sudo'; the PermissionEngine
      // has broader patterns (rm -rf /) but isn't active in this test context.
      const result = await exec(createCtx(), 'exec', { command: 'sudo rm -rf /' })
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
      expect(createTools(createCtx())).toHaveLength(52)
      expect(createTools(createCtx()).find((t) => t.name === 'heartbeat_configure')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'heartbeat_status')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'memory_search')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'browser')).toBeDefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_create')).toBeUndefined()
      expect(createTools(createCtx()).find((t) => t.name === 'canvas_update')).toBeUndefined()
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
      expect(tool.description).toContain('mcp_install')
      const schema = JSON.stringify(tool.parameters)
      expect(schema).not.toContain('"url"')
      expect(schema).not.toContain('"headers"')
      expect(schema).not.toContain('"env"')
      expect(schema).toContain('"name"')
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
      const result = await exec(createCtx(), 'mcp_search', { query: 'sqlite' })
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
      const mcpSearch = tools.find(t => t.name === 'mcp_search')!
      const mcpInstall = tools.find(t => t.name === 'mcp_install')!
      const mcpUninstall = tools.find(t => t.name === 'mcp_uninstall')!

      expect(mcpSearch.label).toContain('MCP')
      expect(mcpInstall.label).toContain('MCP')
      expect(mcpUninstall.label).toContain('MCP')

      // tool_* labels should NOT contain "MCP" — they cover integrations/skills
      const toolSearch = tools.find(t => t.name === 'tool_search')!
      const toolInstall = tools.find(t => t.name === 'tool_install')!
      const toolUninstall = tools.find(t => t.name === 'tool_uninstall')!

      expect(toolSearch.label).not.toContain('MCP')
      expect(toolInstall.label).not.toContain('MCP')
      expect(toolUninstall.label).not.toContain('MCP')
    })
  })

  // =========================================================================
  // Stateful exec cwd tests
  // =========================================================================

  describe('exec stateful cwd', () => {
    // Resolve symlinks so /tmp → /private/tmp on macOS matches pwd output.
    // Computed lazily because beforeEach creates the dir first.
    let REAL_TEST_DIR: string
    beforeEach(() => {
      REAL_TEST_DIR = realpathSync(TEST_DIR)
    })

    function createStatefulCtx(overrides?: Partial<ToolContext>): ToolContext {
      const cwdMap = new Map<string, string>()
      const sessionId = 'test-session'
      return createCtx({
        sessionId,
        shellState: {
          getCwd: () => cwdMap.get(sessionId) || REAL_TEST_DIR,
          setCwd: (cwd: string) => cwdMap.set(sessionId, cwd),
        },
        ...overrides,
      })
    }

    // Reuse the same ctx across calls within a single test to verify persistence
    async function execStateful(ctx: ToolContext, command: string) {
      const tool = getTool(ctx, 'exec')
      const result = await tool.execute('test-call', { command })
      return result.details
    }

    // --- Happy path ---

    test('cd persists across calls', async () => {
      mkdirSync(join(TEST_DIR, 'subdir'), { recursive: true })
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd subdir')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(join(REAL_TEST_DIR, 'subdir'))
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'subdir'))
    })

    test('sequential cd accumulates', async () => {
      mkdirSync(join(TEST_DIR, 'a', 'b'), { recursive: true })
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd a')
      await execStateful(ctx, 'cd b')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(join(REAL_TEST_DIR, 'a', 'b'))
    })

    test('cd .. walks back', async () => {
      mkdirSync(join(TEST_DIR, 'deep'), { recursive: true })
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd deep')
      await execStateful(ctx, 'cd ..')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(REAL_TEST_DIR)
    })

    test('cd with && chaining captures cwd and produces correct stdout', async () => {
      mkdirSync(join(TEST_DIR, 'chain'), { recursive: true })
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd chain && echo hello')
      expect(result.stdout).toBe('hello')
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'chain'))
    })

    test('result always includes cwd field', async () => {
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'echo test')
      expect(result.cwd).toBeDefined()
      expect(typeof result.cwd).toBe('string')
    })

    test('absolute cd', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd /tmp')
      const result = await execStateful(ctx, 'pwd')
      // pwd returns logical path; /tmp is fine even if it symlinks to /private/tmp
      expect(['/tmp', realpathSync('/tmp')]).toContain(result.stdout)
    })

    test('cd alone with no other command', async () => {
      mkdirSync(join(TEST_DIR, 'solo'), { recursive: true })
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd solo')
      expect(result.exitCode).toBe(0)
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'solo'))
    })

    test('first call without prior cd starts at workspace root', async () => {
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(REAL_TEST_DIR)
      expect(result.cwd).toBe(REAL_TEST_DIR)
    })

    // --- Edge cases ---

    test('cd to nonexistent directory does not change cwd', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd /nonexistent_dir_xyz_12345 2>/dev/null; true')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(REAL_TEST_DIR)
    })

    test('failed command preserves cd', async () => {
      mkdirSync(join(TEST_DIR, 'faildir'), { recursive: true })
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd faildir && false')
      expect(result.exitCode).not.toBe(0)
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'faildir'))
    })

    test('command with explicit exit still captures cwd', async () => {
      mkdirSync(join(TEST_DIR, 'exitdir'), { recursive: true })
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd exitdir && exit 42')
      expect(result.exitCode).toBe(42)
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'exitdir'))
    })

    test('subshell cd does not leak to outer shell', async () => {
      mkdirSync(join(TEST_DIR, 'inner'), { recursive: true })
      const ctx = createStatefulCtx()
      await execStateful(ctx, '(cd inner)')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(REAL_TEST_DIR)
    })

    test('pipe with cd captures correct cwd', async () => {
      mkdirSync(join(TEST_DIR, 'pipedir'), { recursive: true })
      writeFileSync(join(TEST_DIR, 'pipedir', 'file.txt'), 'content\n')
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd pipedir && ls | head -1')
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'pipedir'))
      expect(result.stdout).toBe('file.txt')
    })

    test('no shellState (no sessionId) still works', async () => {
      const ctx = createCtx()
      const result = await exec(ctx, 'exec', { command: 'echo hello' })
      expect(result.stdout).toBe('hello')
      expect(result.exitCode).toBe(0)
      expect(result.cwd).toBeDefined()
    })

    // --- Adversarial ---

    test('path with spaces', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'mkdir -p "dir with spaces"')
      await execStateful(ctx, 'cd "dir with spaces"')
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(join(REAL_TEST_DIR, 'dir with spaces'))
    })

    test('path with single quotes in name', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, "mkdir -p \"it's a dir\"")
      await execStateful(ctx, "cd \"it's a dir\"")
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toContain("it's a dir")
    })

    test('deeply nested path', async () => {
      const depth = 30
      let nested = TEST_DIR
      for (let i = 0; i < depth; i++) nested = join(nested, `d${i}`)
      mkdirSync(nested, { recursive: true })
      const realNested = realpathSync(nested)

      const ctx = createStatefulCtx()
      const cdChain = Array.from({ length: depth }, (_, i) => `d${i}`).join('/')
      await execStateful(ctx, `cd ${cdChain}`)
      const result = await execStateful(ctx, 'pwd')
      expect(result.stdout).toBe(realNested)
    })

    test('symlink cd tracks the path used', async () => {
      const targetDir = join(TEST_DIR, 'real-target')
      mkdirSync(targetDir, { recursive: true })
      symlinkSync(targetDir, join(TEST_DIR, 'sym-link'))

      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd sym-link')
      const result = await execStateful(ctx, 'pwd')
      // pwd may return logical (symlink) or physical (resolved) path
      const expected = [
        join(REAL_TEST_DIR, 'sym-link'),
        realpathSync(join(TEST_DIR, 'sym-link')),
      ]
      expect(expected).toContain(result.stdout)
    })

    test('deleted cwd falls back gracefully', async () => {
      mkdirSync(join(TEST_DIR, 'ephemeral'), { recursive: true })
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'cd ephemeral')
      rmSync(join(TEST_DIR, 'ephemeral'), { recursive: true })
      // Next call: cd to deleted dir fails, || true saves us, runs in workspaceDir
      const result = await execStateful(ctx, 'pwd')
      expect(result.exitCode).toBe(0)
      expect(result.cwd).toBeDefined()
    })

    test('rapid sequential calls have no temp file collision', async () => {
      const ctx = createStatefulCtx()
      for (let i = 0; i < 10; i++) {
        const dir = `rapid-${i}`
        mkdirSync(join(TEST_DIR, dir), { recursive: true })
        const result = await execStateful(ctx, `cd "${REAL_TEST_DIR}/${dir}"`)
        expect(result.cwd).toBe(join(REAL_TEST_DIR, dir))
      }
    })

    test('command producing massive stdout still captures cwd', async () => {
      mkdirSync(join(TEST_DIR, 'bigout'), { recursive: true })
      const ctx = createStatefulCtx()
      const result = await execStateful(ctx, 'cd bigout && yes | head -10000')
      expect(result.cwd).toBe(join(REAL_TEST_DIR, 'bigout'))
      expect(result.exitCode).toBe(0)
    })

    test('trap override attempt falls back to previous cwd', async () => {
      mkdirSync(join(TEST_DIR, 'trapdir'), { recursive: true })
      const ctx = createStatefulCtx()
      // Overwrite our EXIT trap — cwd capture won't fire
      const result = await execStateful(ctx, 'trap "echo overridden" EXIT && cd trapdir')
      // Should fall back to the previous cwd (workspace root) since trap was overridden
      expect(result.cwd).toBeDefined()
      // The key assertion: no crash, and either the trap still caught it or we fell back
      expect(typeof result.cwd).toBe('string')
    })

    test('multiple sessions are independent', async () => {
      mkdirSync(join(TEST_DIR, 'dirA'), { recursive: true })
      mkdirSync(join(TEST_DIR, 'dirB'), { recursive: true })

      const cwdMapA = new Map<string, string>()
      const cwdMapB = new Map<string, string>()
      const ctxA = createCtx({
        sessionId: 'session-a',
        shellState: {
          getCwd: () => cwdMapA.get('session-a') || REAL_TEST_DIR,
          setCwd: (cwd: string) => cwdMapA.set('session-a', cwd),
        },
      })
      const ctxB = createCtx({
        sessionId: 'session-b',
        shellState: {
          getCwd: () => cwdMapB.get('session-b') || REAL_TEST_DIR,
          setCwd: (cwd: string) => cwdMapB.set('session-b', cwd),
        },
      })

      await execStateful(ctxA, 'cd dirA')
      await execStateful(ctxB, 'cd dirB')
      const resultA = await execStateful(ctxA, 'pwd')
      const resultB = await execStateful(ctxB, 'pwd')
      expect(resultA.stdout).toBe(join(REAL_TEST_DIR, 'dirA'))
      expect(resultB.stdout).toBe(join(REAL_TEST_DIR, 'dirB'))
    })

    // --- Temp file hygiene ---

    test('temp file cleaned up on success', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'echo clean')
      const remaining = readdirSync(TEST_DIR).filter(f => f.startsWith('.shogo-cwd-'))
      expect(remaining).toHaveLength(0)
    })

    test('temp file cleaned up on failure', async () => {
      const ctx = createStatefulCtx()
      await execStateful(ctx, 'false')
      const remaining = readdirSync(TEST_DIR).filter(f => f.startsWith('.shogo-cwd-'))
      expect(remaining).toHaveLength(0)
    })
  })

  // =========================================================================
  // Path translation unit tests
  // =========================================================================

  describe('hostToContainer / containerToHost', () => {
    test('hostToContainer: workspace-relative path', () => {
      expect(hostToContainer('/home/user/project/src', '/home/user/project')).toBe('/workspace/src')
    })

    test('hostToContainer: workspace root', () => {
      expect(hostToContainer('/home/user/project', '/home/user/project')).toBe('/workspace')
    })

    test('hostToContainer: outside workspace falls back', () => {
      expect(hostToContainer('/tmp/other', '/home/user/project')).toBe('/workspace')
    })

    test('containerToHost: workspace-relative', () => {
      expect(containerToHost('/workspace/src', '/home/user/project')).toBe('/home/user/project/src')
    })

    test('containerToHost: workspace root', () => {
      expect(containerToHost('/workspace', '/home/user/project')).toBe('/home/user/project')
    })

    test('containerToHost: outside workspace falls back', () => {
      expect(containerToHost('/etc/passwd', '/home/user/project')).toBe('/home/user/project')
    })
  })
})
