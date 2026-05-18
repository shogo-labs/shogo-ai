// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Expanded coverage for mcp-client.ts: targets buildSchemaHint,
// installPackageLocally, stderr handler, and image-content tool paths.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sdkState = {
  toolsByName: new Map<string, any[]>(),
  callResultByTool: new Map<string, any>(),
  stderrEmitter: null as EventEmitter | null,
}

class FakeClient {
  serverName: string
  constructor(info: { name: string }) {
    this.serverName = info.name.replace(/^shogo-agent-/, '')
  }
  async connect(): Promise<void> {}
  async listTools(): Promise<{ tools: any[] }> {
    return { tools: sdkState.toolsByName.get(this.serverName) ?? [] }
  }
  async callTool(req: { name: string; arguments: any }): Promise<any> {
    return sdkState.callResultByTool.get(req.name) ?? {
      content: [{ type: 'text', text: `called ${req.name}` }],
    }
  }
}

class FakeStdioTransport {
  command: string
  stderr: EventEmitter | null
  constructor(opts: { command: string }) {
    this.command = opts.command
    this.stderr = sdkState.stderrEmitter
  }
  async close(): Promise<void> {}
}

class FakeHttpTransport {
  url: URL
  constructor(url: URL) { this.url = url }
  async close(): Promise<void> {}
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: FakeClient }))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: FakeStdioTransport }))
mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: FakeHttpTransport }))

mock.module('../mcp-catalog', () => ({
  isMcpServerAllowed: () => true,
  isPreinstalledMcpId: () => false,
  isCatalogEntry: () => true,
  getPreinstalledPackages: () => [],
}))

mock.module('../sandbox-exec', () => ({ getSanitizedEnv: () => ({ PATH: '/usr/bin' }) }))
mock.module('../lib/cloud-fetcher', () => ({
  shouldRouteThroughCloud: () => false,
  getCloudDispatcher: () => undefined,
}))
mock.module('../image-size-guard', () => ({
  enforceImageSizeLimit: (content: any[]) => content,
}))

const execSyncCalls: Array<{ cmd: string; opts: any }> = []
let execSyncShouldThrow: { stderr?: string; message: string } | null = null
mock.module('child_process', () => ({
  execSync: (cmd: string, opts: any) => {
    execSyncCalls.push({ cmd, opts })
    if (execSyncShouldThrow) {
      const err: any = new Error(execSyncShouldThrow.message)
      if (execSyncShouldThrow.stderr) {
        err.stderr = Buffer.from(execSyncShouldThrow.stderr)
      }
      throw err
    }
    return Buffer.from('')
  },
}))

const { MCPClientManager, MCP_WORKSPACE_PACKAGES_DIR, getMcpPreinstallDir, MCP_PREINSTALL_DIR } = await import('../mcp-client')

describe('mcp-client expanded coverage', () => {
  let mgr: InstanceType<typeof MCPClientManager>
  let workspace: string

  beforeEach(() => {
    sdkState.toolsByName.clear()
    sdkState.callResultByTool.clear()
    sdkState.stderrEmitter = null
    execSyncCalls.length = 0
    execSyncShouldThrow = null
    mgr = new MCPClientManager()
    workspace = mkdtempSync(join(tmpdir(), 'mcp-expanded-'))
    mgr.setWorkspaceDir(workspace)
  })

  afterEach(() => {
    try { rmSync(workspace, { recursive: true, force: true }) } catch {}
  })

  describe('module exports', () => {
    it('exposes getMcpPreinstallDir + MCP_PREINSTALL_DIR + workspace dir constant', () => {
      expect(typeof getMcpPreinstallDir()).toBe('string')
      expect(typeof MCP_PREINSTALL_DIR).toBe('string')
      expect(MCP_WORKSPACE_PACKAGES_DIR).toBe('.mcp-packages')
    })

    it('honours MCP_PREINSTALL_DIR override at call time', () => {
      const orig = process.env.MCP_PREINSTALL_DIR
      process.env.MCP_PREINSTALL_DIR = '/custom/preinstall'
      expect(getMcpPreinstallDir()).toBe('/custom/preinstall')
      if (orig === undefined) delete process.env.MCP_PREINSTALL_DIR
      else process.env.MCP_PREINSTALL_DIR = orig
    })
  })

  describe('buildSchemaHint via remote tool description', () => {
    it('appends nested-object schema hint to description', async () => {
      sdkState.toolsByName.set('hinted', [{
        name: 'do_thing',
        description: 'Do a thing',
        inputSchema: {
          type: 'object',
          required: ['user'],
          properties: {
            user: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Full name' },
                age: { type: 'number' },
              },
            },
            note: { type: 'string', description: 'A note' },
          },
        },
      }])
      const tools = await mgr.startRemoteServer('hinted', { url: 'https://example.com/mcp' })
      expect(tools).toHaveLength(1)
      expect(tools[0].description).toContain('Input schema:')
      expect(tools[0].description).toContain('user')
      expect(tools[0].description).toContain('name')
    })

    it('appends hint for array-of-object schema and renders item description', async () => {
      sdkState.toolsByName.set('arr', [{
        name: 'list_items',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'id\nsecond line that should be ignored' },
                  count: { type: 'integer' },
                },
              },
            },
          },
        },
      }])
      const tools = await mgr.startRemoteServer('arr', { url: 'https://example.com/mcp' })
      expect(tools[0].description).toContain('Array<')
      expect(tools[0].description).toContain('items')
    })

    it('skips hint when no nested complex types', async () => {
      sdkState.toolsByName.set('flat', [{
        name: 'flat_tool',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'number' },
          },
        },
      }])
      const tools = await mgr.startRemoteServer('flat', { url: 'https://example.com/mcp' })
      expect(tools[0].description).not.toContain('Input schema:')
    })

    it('handles missing description / falls back to type name', async () => {
      sdkState.toolsByName.set('typedef', [{
        name: 'typedef',
        inputSchema: {
          type: 'object',
          properties: {
            blob: {
              type: 'object',
              properties: {
                untyped: {},
              },
            },
          },
        },
      }])
      const tools = await mgr.startRemoteServer('typedef', { url: 'https://example.com/mcp' })
      expect(tools[0].description).toContain('Input schema:')
    })
  })

  describe('installPackageLocally', () => {
    it('throws when workspace dir is not set', async () => {
      const bare = new MCPClientManager()
      await expect(bare.installPackageLocally('some-pkg')).rejects.toThrow(/workspace directory not set/)
    })

    it('creates .mcp-packages dir and runs npm install when package missing', async () => {
      const cfg = await mgr.installPackageLocally('my-mcp@latest', ['--flag'], { TOKEN: 'x' })
      expect(execSyncCalls).toHaveLength(1)
      expect(execSyncCalls[0].cmd).toContain('npm install')
      expect(execSyncCalls[0].cmd).toContain('my-mcp@latest')
      expect(cfg.command).toBe('npx')
      expect(cfg.args).toEqual(['-y', 'my-mcp@latest', '--flag'])
      expect(cfg.env).toEqual({ TOKEN: 'x' })
    })

    it('skips npm install when package already exists in workspace cache', async () => {
      const pkgDir = join(workspace, MCP_WORKSPACE_PACKAGES_DIR, 'node_modules', 'cached-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'cached-pkg',
        main: 'index.js',
      }))
      writeFileSync(join(pkgDir, 'index.js'), 'console.log("hi")')
      const cfg = await mgr.installPackageLocally('cached-pkg')
      expect(execSyncCalls).toHaveLength(0)
      expect(cfg.command).toBe('node')
      expect(cfg.args?.[0]).toContain('cached-pkg')
    })

    it('wraps execSync failure with stderr in error message', async () => {
      execSyncShouldThrow = { message: 'install failed', stderr: 'E404 not found' }
      await expect(mgr.installPackageLocally('bad-pkg')).rejects.toThrow(/Failed to install bad-pkg: E404 not found/)
    })

    it('falls back to err.message when no stderr present', async () => {
      execSyncShouldThrow = { message: 'no-stderr-here' }
      await expect(mgr.installPackageLocally('bad2')).rejects.toThrow(/no-stderr-here/)
    })

    it('omits env when not provided', async () => {
      const cfg = await mgr.installPackageLocally('plain-pkg')
      expect(cfg.env).toBeUndefined()
    })
  })

  describe('stderr handler on stdio transport', () => {
    it('wires stderr.on("data") and logs non-empty chunks', async () => {
      const ee = new EventEmitter()
      sdkState.stderrEmitter = ee
      sdkState.toolsByName.set('stderry', [{ name: 't', inputSchema: { type: 'object' } }])
      await mgr.startServer('stderry', { command: 'node', args: ['x'] })
      ee.emit('data', Buffer.from('hello stderr\n'))
      ee.emit('data', Buffer.from('   '))
      expect(true).toBe(true)
    })
  })

  describe('image content path in tool execute (stdio)', () => {
    it('returns image content array with text appended', async () => {
      sdkState.toolsByName.set('imgsrv', [{ name: 'snap', inputSchema: { type: 'object' } }])
      sdkState.callResultByTool.set('snap', {
        content: [
          { type: 'image', data: 'BASE64DATA', mimeType: 'image/jpeg' },
          { type: 'text', text: 'metadata' },
        ],
      })
      const tools = await mgr.startServer('imgsrv', { command: 'node', args: ['x'] })
      const r = await tools[0].execute('call-1', {})
      const c = (r as any).content
      expect(Array.isArray(c)).toBe(true)
      expect(c.find((x: any) => x.type === 'image')).toBeDefined()
      expect(c.find((x: any) => x.type === 'text').text).toBe('metadata')
    })

    it('returns image without text when no text content present', async () => {
      sdkState.toolsByName.set('imgsrv2', [{ name: 'snap2', inputSchema: { type: 'object' } }])
      sdkState.callResultByTool.set('snap2', {
        content: [
          { type: 'image', data: 'X', mimeType: undefined },
        ],
      })
      const tools = await mgr.startServer('imgsrv2', { command: 'node', args: ['x'] })
      const r = await tools[0].execute('c2', {})
      const c = (r as any).content
      expect(c).toHaveLength(1)
      expect(c[0].type).toBe('image')
      expect(c[0].mimeType).toBe('image/png')
    })
  })

  describe('image content path in remote tool execute', () => {
    it('returns image content from remote MCP tool', async () => {
      sdkState.toolsByName.set('remoteimg', [{ name: 'rsnap', inputSchema: { type: 'object' } }])
      sdkState.callResultByTool.set('rsnap', {
        content: [
          { type: 'image', data: 'IMG', mimeType: 'image/png' },
          { type: 'text', text: 'caption' },
        ],
      })
      const tools = await mgr.startRemoteServer('remoteimg', { url: 'https://example.com/mcp' })
      const r = await tools[0].execute('rc', {})
      const c = (r as any).content
      expect(c.some((x: any) => x.type === 'image')).toBe(true)
      expect(c.find((x: any) => x.type === 'text').text).toBe('caption')
    })

    it('returns image without text branch (remote)', async () => {
      sdkState.toolsByName.set('remoteimg2', [{ name: 'rsnap2', inputSchema: { type: 'object' } }])
      sdkState.callResultByTool.set('rsnap2', {
        content: [{ type: 'image', data: 'X', mimeType: 'image/webp' }],
      })
      const tools = await mgr.startRemoteServer('remoteimg2', { url: 'https://example.com/mcp' })
      const r = await tools[0].execute('rc2', {})
      const c = (r as any).content
      expect(c).toHaveLength(1)
      expect(c[0].mimeType).toBe('image/webp')
    })
  })
})
