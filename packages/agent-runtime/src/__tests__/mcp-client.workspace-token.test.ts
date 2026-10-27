// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-228: an MCP server is third-party code, and so is the npm package the
 * install tool fetches — npm runs its lifecycle scripts. On a workspace
 * runtime the token either of them would inherit is the **workspace** token
 * (`wrt_v1_…`), valid for every project in the workspace, so neither may
 * receive one. A single-project runtime is left alone.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as realCatalog from '../mcp-catalog'
import * as realSandboxExec from '../sandbox-exec'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const WORKSPACE_TOKEN = 'wrt_v1_ws-int_workspacehmac'
const PROJECT_TOKEN = 'rt_v1_proj-a_projecthmac'

/** What the real `getSanitizedEnv()` hands over: the runtime's own env. */
let sanitizedEnv: Record<string, string> = {}

const transportOpts: Array<Record<string, any>> = []
const execSyncCalls: Array<{ cmd: string; opts: any }> = []

class FakeClient {
  async connect(): Promise<void> {}
  async listTools(): Promise<{ tools: any[] }> {
    return { tools: [] }
  }
  async callTool(): Promise<any> {
    return { content: [] }
  }
}

class FakeStdioTransport {
  constructor(opts: Record<string, any>) {
    transportOpts.push(opts)
  }
  async close(): Promise<void> {}
}

class FakeHttpTransport {
  constructor() {}
  async close(): Promise<void> {}
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: FakeClient }))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: FakeStdioTransport }))
mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: FakeHttpTransport }))

mock.module('../mcp-catalog', () => ({
  ...realCatalog,
  isMcpServerAllowed: () => true,
  isPreinstalledMcpId: () => false,
  isCatalogEntry: () => true,
  getPreinstalledPackages: () => [],
}))

mock.module('../sandbox-exec', () => ({ ...realSandboxExec, getSanitizedEnv: () => ({ ...sanitizedEnv }) }))
mock.module('../lib/cloud-fetcher', () => ({
  shouldRouteThroughCloud: () => false,
  getCloudDispatcher: () => undefined,
}))
mock.module('../image-size-guard', () => ({
  enforceImageSizeLimit: (content: any[]) => content,
}))
mock.module('child_process', () => ({
  execSync: (cmd: string, opts: any) => {
    execSyncCalls.push({ cmd, opts })
    return Buffer.from('')
  },
}))

const { MCPClientManager } = await import('../mcp-client')

const savedEnv = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
}

/** Every value a spawned process would see, as one string to search. */
function values(env: Record<string, string | undefined> | undefined): string[] {
  return Object.values(env ?? {}).filter((v): v is string => typeof v === 'string')
}

describe('MCP servers never receive the workspace runtime token', () => {
  let workspace: string
  let mgr: InstanceType<typeof MCPClientManager>

  beforeEach(() => {
    transportOpts.length = 0
    execSyncCalls.length = 0
    mgr = new MCPClientManager()
    workspace = mkdtempSync(join(tmpdir(), 'mcp-workspace-token-'))
    mgr.setWorkspaceDir(workspace)
  })

  afterEach(() => {
    restoreEnv()
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {}
  })

  it('strips the workspace token from an npm install (lifecycle scripts included)', async () => {
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.RUNTIME_AUTH_SECRET = WORKSPACE_TOKEN
    process.env.PROJECT_ID = 'ws:ws-int'
    process.env.PATH = '/usr/bin'
    sanitizedEnv = { PATH: '/usr/bin', RUNTIME_AUTH_SECRET: WORKSPACE_TOKEN, PROJECT_ID: 'ws:ws-int' }

    await mgr.installPackageLocally('@modelcontextprotocol/server-filesystem')

    expect(execSyncCalls).toHaveLength(1)
    const env = execSyncCalls[0].opts.env as Record<string, string>
    expect(values(env).some((v) => v.startsWith('wrt_v1_'))).toBe(false)
    expect(env.RUNTIME_AUTH_SECRET).toBeUndefined()
    // The install still gets the env it needs.
    expect(env.HOME).toBe(workspace)
    expect(env.PATH).toBe('/usr/bin')
  })

  it('strips the workspace token from the MCP server process', async () => {
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.RUNTIME_AUTH_SECRET = WORKSPACE_TOKEN
    process.env.PROJECT_ID = 'ws:ws-int'
    sanitizedEnv = { PATH: '/usr/bin', RUNTIME_AUTH_SECRET: WORKSPACE_TOKEN, PROJECT_ID: 'ws:ws-int' }

    await mgr.startServer('filesystem', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })

    expect(transportOpts).toHaveLength(1)
    const env = transportOpts[0].env as Record<string, string>
    expect(values(env).some((v) => v.startsWith('wrt_v1_'))).toBe(false)
    expect(env.RUNTIME_AUTH_SECRET).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe(workspace)
  })

  it('leaves a single-project runtime untouched', async () => {
    delete process.env.WORKSPACE_RUNTIME
    process.env.RUNTIME_AUTH_SECRET = PROJECT_TOKEN
    process.env.PROJECT_ID = 'proj-a'
    sanitizedEnv = { PATH: '/usr/bin', RUNTIME_AUTH_SECRET: PROJECT_TOKEN, PROJECT_ID: 'proj-a' }

    await mgr.installPackageLocally('@modelcontextprotocol/server-filesystem')
    await mgr.startServer('filesystem', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] })

    expect(execSyncCalls[0].opts.env.RUNTIME_AUTH_SECRET).toBe(PROJECT_TOKEN)
    expect(transportOpts[0].env.RUNTIME_AUTH_SECRET).toBe(PROJECT_TOKEN)
  })
})
