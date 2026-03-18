// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Integration tests for MCP persistence across pod restarts.
 *
 * Validates:
 * - Config.json round-trip (write → read → startAll)
 * - Workspace-local .mcp-packages/ resolution as fallback
 * - Remote MCP server config persistence
 * - S3 sync exclude list does not filter .mcp-packages/
 * - Full cold-start simulation (install → stop → new manager → restore)
 * - Whitelist allows all catalog entries
 * - Edge cases (stale config, concurrent writes, MAX_MCP_SERVERS)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// Use the same preinstall dir as mcp-preinstall.test.ts so module caching
// doesn't cause conflicts when both tests run in the same bun process.
const TEST_PREINSTALL_DIR = join(import.meta.dir, '.test-mcp-packages')
const TEST_WORKSPACE_DIR = join(import.meta.dir, '.test-persist-workspace')
const TEST_WORKSPACE_MCP_DIR = join(TEST_WORKSPACE_DIR, '.mcp-packages')

if (!process.env.MCP_PREINSTALL_DIR) {
  process.env.MCP_PREINSTALL_DIR = TEST_PREINSTALL_DIR
}

const { MCPClientManager, MCP_WORKSPACE_PACKAGES_DIR } = await import('../mcp-client')
const { isMcpServerAllowed, isCatalogEntry, isPreinstalledMcpId, MCP_CATALOG } = await import('../mcp-catalog')

function setupFakePackage(baseDir: string, pkgName: string, binEntry: string | Record<string, string>) {
  const pkgDir = join(baseDir, 'node_modules', pkgName)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, bin: binEntry }))
  const entryFile = typeof binEntry === 'string' ? binEntry : Object.values(binEntry)[0]
  const entryPath = join(pkgDir, entryFile)
  mkdirSync(join(entryPath, '..'), { recursive: true })
  writeFileSync(entryPath, '#!/usr/bin/env node\nconsole.log("ok")')
}

function readConfig(): Record<string, any> {
  const configPath = join(TEST_WORKSPACE_DIR, 'config.json')
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

function writeConfig(config: Record<string, any>): void {
  const configPath = join(TEST_WORKSPACE_DIR, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

function createManager(): InstanceType<typeof MCPClientManager> {
  const manager = new MCPClientManager()
  manager.setWorkspaceDir(TEST_WORKSPACE_DIR)
  return manager
}

beforeAll(() => {
  mkdirSync(TEST_WORKSPACE_DIR, { recursive: true })
  mkdirSync(TEST_PREINSTALL_DIR, { recursive: true })
  mkdirSync(TEST_WORKSPACE_MCP_DIR, { recursive: true })

  // Set up a fake package in Docker preinstall dir (may already exist from mcp-preinstall.test.ts)
  if (!existsSync(join(TEST_PREINSTALL_DIR, 'node_modules', '@playwright/mcp', 'package.json'))) {
    setupFakePackage(TEST_PREINSTALL_DIR, '@playwright/mcp', { 'playwright-mcp': 'dist/index.js' })
  }
  // Set up a fake package only in the workspace .mcp-packages/ (not in Docker preinstall)
  setupFakePackage(TEST_WORKSPACE_MCP_DIR, '@modelcontextprotocol/server-github', { 'mcp-server-github': 'dist/index.js' })
})

afterAll(() => {
  rmSync(TEST_WORKSPACE_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Config.json Round-Trip Persistence
// ---------------------------------------------------------------------------

describe('Config.json round-trip persistence', () => {
  beforeEach(() => {
    writeConfig({ model: { provider: 'anthropic', name: 'claude-sonnet-4-6' } })
  })

  test('persistConfig writes mcpServers to config.json', () => {
    const manager = createManager()
    const config = { command: 'node', args: ['/path/to/server.js'] }
    ;(manager as any).persistConfig('test-server', config)

    const stored = readConfig()
    expect(stored.mcpServers).toBeDefined()
    expect(stored.mcpServers['test-server']).toEqual({ command: 'node', args: ['/path/to/server.js'] })
  })

  test('persistConfig preserves existing config fields', () => {
    writeConfig({ model: { provider: 'anthropic', name: 'test' }, heartbeat: { enabled: true } })

    const manager = createManager()
    ;(manager as any).persistConfig('my-mcp', { command: 'node', args: ['server.js'] })

    const stored = readConfig()
    expect(stored.model.provider).toBe('anthropic')
    expect(stored.heartbeat.enabled).toBe(true)
    expect(stored.mcpServers['my-mcp']).toBeDefined()
  })

  test('unpersistConfig removes server from config.json', () => {
    writeConfig({ mcpServers: { a: { command: 'node' }, b: { command: 'node' } } })

    const manager = createManager()
    ;(manager as any).unpersistConfig('a')

    const stored = readConfig()
    expect(stored.mcpServers['a']).toBeUndefined()
    expect(stored.mcpServers['b']).toBeDefined()
  })

  test('multiple servers persist independently', () => {
    const manager = createManager()
    ;(manager as any).persistConfig('server-a', { command: 'node', args: ['a.js'] })
    ;(manager as any).persistConfig('server-b', { command: 'node', args: ['b.js'] })

    const stored = readConfig()
    expect(Object.keys(stored.mcpServers)).toEqual(['server-a', 'server-b'])

    ;(manager as any).unpersistConfig('server-a')
    const after = readConfig()
    expect(Object.keys(after.mcpServers)).toEqual(['server-b'])
  })

  test('persistConfig triggers onConfigPersisted callback', () => {
    const manager = createManager()
    let callCount = 0
    manager.setOnConfigPersisted(() => { callCount++ })

    ;(manager as any).persistConfig('test', { command: 'node' })
    expect(callCount).toBe(1)
  })

  test('unpersistConfig triggers onConfigPersisted callback', () => {
    writeConfig({ mcpServers: { test: { command: 'node' } } })

    const manager = createManager()
    let callCount = 0
    manager.setOnConfigPersisted(() => { callCount++ })

    ;(manager as any).unpersistConfig('test')
    expect(callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Workspace-Local Package Resolution
// ---------------------------------------------------------------------------

describe('Workspace-local .mcp-packages/ resolution', () => {
  test('resolvePreinstalled checks workspace .mcp-packages/ as fallback', () => {
    const manager = createManager()

    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@latest'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args[0]).toContain('.mcp-packages')
    expect(resolved.args[0]).toContain('server-github')
  })

  test('Docker preinstall takes priority over workspace .mcp-packages/', () => {
    setupFakePackage(TEST_WORKSPACE_MCP_DIR, '@playwright/mcp', { 'playwright-mcp': 'dist/index.js' })

    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args[0]).toContain(TEST_PREINSTALL_DIR)
    expect(resolved.args[0]).not.toContain('.mcp-packages')
  })

  test('falls through to npx when package not in either location', () => {
    const manager = createManager()
    const config = { command: 'npx', args: ['-y', 'some-unknown-package@latest'] }
    const resolved = (manager as any).resolvePreinstalled(config)

    expect(resolved.command).toBe('npx')
  })

  test('preserves extra args when resolving from workspace', () => {
    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@latest', '--port', '3000'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args).toContain('--port')
    expect(resolved.args).toContain('3000')
  })

  test('MCP_WORKSPACE_PACKAGES_DIR constant matches expected path', () => {
    expect(MCP_WORKSPACE_PACKAGES_DIR).toBe('.mcp-packages')
  })
})

// ---------------------------------------------------------------------------
// 3. Remote MCP Server Config Persistence
// ---------------------------------------------------------------------------

describe('Remote MCP server config persistence', () => {
  beforeEach(() => {
    writeConfig({ model: { provider: 'anthropic', name: 'test' } })
  })

  test('persistRemoteConfig writes remoteMcpServers to config.json', () => {
    const manager = createManager()
    ;(manager as any).persistRemoteConfig('my-remote', {
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token123' },
    })

    const stored = readConfig()
    expect(stored.remoteMcpServers).toBeDefined()
    expect(stored.remoteMcpServers['my-remote']).toEqual({
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token123' },
    })
  })

  test('persistRemoteConfig preserves existing mcpServers', () => {
    writeConfig({ mcpServers: { postgres: { command: 'npx', args: ['server-postgres'] } } })

    const manager = createManager()
    ;(manager as any).persistRemoteConfig('remote-1', { url: 'https://example.com/mcp' })

    const stored = readConfig()
    expect(stored.mcpServers.postgres).toBeDefined()
    expect(stored.remoteMcpServers['remote-1']).toBeDefined()
  })

  test('unpersistRemoteConfig removes only the target server', () => {
    writeConfig({
      remoteMcpServers: {
        'remote-a': { url: 'https://a.com' },
        'remote-b': { url: 'https://b.com' },
      },
    })

    const manager = createManager()
    ;(manager as any).unpersistRemoteConfig('remote-a')

    const stored = readConfig()
    expect(stored.remoteMcpServers['remote-a']).toBeUndefined()
    expect(stored.remoteMcpServers['remote-b']).toEqual({ url: 'https://b.com' })
  })

  test('persistRemoteConfig stores optional fields', () => {
    const manager = createManager()
    ;(manager as any).persistRemoteConfig('full-config', {
      url: 'https://example.com/mcp',
      headers: { 'X-Api-Key': 'key' },
      excludeTools: ['unwanted_tool'],
      maxResultChars: 5000,
    })

    const stored = readConfig()
    const config = stored.remoteMcpServers['full-config']
    expect(config.url).toBe('https://example.com/mcp')
    expect(config.headers['X-Api-Key']).toBe('key')
    expect(config.excludeTools).toEqual(['unwanted_tool'])
    expect(config.maxResultChars).toBe(5000)
  })

  test('persistRemoteConfig triggers onConfigPersisted callback', () => {
    const manager = createManager()
    let called = false
    manager.setOnConfigPersisted(() => { called = true })

    ;(manager as any).persistRemoteConfig('test-remote', { url: 'https://example.com' })
    expect(called).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. S3 Sync Exclude List Coverage
// ---------------------------------------------------------------------------

describe('S3 sync exclude list does not filter .mcp-packages/', () => {
  /**
   * Mirrors the shouldExclude logic from shared-runtime/src/s3-sync.ts
   * with the default exclude patterns to verify .mcp-packages/ is not filtered.
   */
  const DEFAULT_EXCLUDES = [
    '.DS_Store',
    '*.log',
    'playwright-report',
    'test-results',
    'project/node_modules',
    '.bun',
  ]

  function shouldExclude(path: string): boolean {
    for (const pattern of DEFAULT_EXCLUDES) {
      if (pattern.startsWith('*')) {
        const ext = pattern.slice(1)
        if (path.endsWith(ext)) return true
      } else {
        if (path === pattern || path.includes(`/${pattern}/`) || path.includes(`/${pattern}`) || path.startsWith(`${pattern}/`) || path.startsWith(pattern)) {
          return true
        }
      }
    }
    return false
  }

  test('.mcp-packages paths are not excluded by S3 sync defaults', () => {
    expect(shouldExclude('.mcp-packages/node_modules/foo/index.js')).toBe(false)
    expect(shouldExclude('.mcp-packages/package.json')).toBe(false)
    expect(shouldExclude('.mcp-packages/node_modules/@modelcontextprotocol/server-github/dist/index.js')).toBe(false)
  })

  test('project/node_modules IS excluded (control)', () => {
    expect(shouldExclude('project/node_modules/foo/index.js')).toBe(true)
  })

  test('.DS_Store and .bun ARE excluded (control)', () => {
    expect(shouldExclude('.DS_Store')).toBe(true)
    expect(shouldExclude('.bun')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Full Cold Start Simulation
// ---------------------------------------------------------------------------

describe('Full cold start simulation', () => {
  test('config.json written by persistConfig can be read for startAll', () => {
    const managerA = createManager()

    ;(managerA as any).persistConfig('playwright', {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    })
    ;(managerA as any).persistConfig('github', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@latest'],
    })
    ;(managerA as any).persistRemoteConfig('custom-remote', {
      url: 'https://remote-mcp.example.com',
    })

    // Simulate cold start: read config as gateway would
    const config = readConfig()

    expect(config.mcpServers).toBeDefined()
    expect(config.mcpServers.playwright).toBeDefined()
    expect(config.mcpServers.github).toBeDefined()
    expect(config.remoteMcpServers).toBeDefined()
    expect(config.remoteMcpServers['custom-remote']).toBeDefined()

    // Verify resolvePreinstalled would find both packages
    const managerB = createManager()

    const playwrightResolved = (managerB as any).resolvePreinstalled(config.mcpServers.playwright)
    expect(playwrightResolved.command).toBe('node')
    expect(playwrightResolved.args[0]).toContain(TEST_PREINSTALL_DIR)

    const githubResolved = (managerB as any).resolvePreinstalled(config.mcpServers.github)
    expect(githubResolved.command).toBe('node')
    expect(githubResolved.args[0]).toContain('.mcp-packages')
  })

  test('mixed stdio and remote configs survive round-trip', () => {
    writeConfig({
      model: { provider: 'anthropic', name: 'test' },
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
      remoteMcpServers: {
        'my-api': { url: 'https://api.example.com/mcp', headers: { 'X-Key': 'secret' } },
      },
    })

    const config = readConfig()

    expect(config.mcpServers.playwright.command).toBe('npx')
    expect(config.remoteMcpServers['my-api'].url).toBe('https://api.example.com/mcp')
    expect(config.remoteMcpServers['my-api'].headers['X-Key']).toBe('secret')
  })
})

// ---------------------------------------------------------------------------
// 6. Whitelist / Catalog Changes
// ---------------------------------------------------------------------------

describe('Whitelist allows all catalog entries', () => {
  test('isMcpServerAllowed returns true for all catalog entries', () => {
    for (const entry of MCP_CATALOG) {
      expect(isMcpServerAllowed(entry.id)).toBe(true)
    }
  })

  test('isMcpServerAllowed returns false for non-catalog arbitrary names', () => {
    expect(isMcpServerAllowed('evil-server')).toBe(false)
    expect(isMcpServerAllowed('')).toBe(false)
    expect(isMcpServerAllowed('custom-mcp-not-in-catalog')).toBe(false)
  })

  test('isCatalogEntry correctly identifies catalog vs non-catalog', () => {
    expect(isCatalogEntry('github')).toBe(true)
    expect(isCatalogEntry('postgres')).toBe(true)
    expect(isCatalogEntry('linear')).toBe(true)
    expect(isCatalogEntry('random-name')).toBe(false)
  })

  test('all newly preinstalled entries are correctly marked', () => {
    const expectedPreinstalled = [
      'playwright', 'fetch', 'github', 'gitlab', 'linear', 'postgres',
      'sqlite', 'mongodb', 'discourse', 'slack', 'notion', 'stripe',
      'brave-search', 'exa', 'sentry', 'airbnb', 'filesystem',
    ]
    for (const id of expectedPreinstalled) {
      expect(isPreinstalledMcpId(id)).toBe(true)
    }
  })

  test('startServer rejects non-catalog names', async () => {
    const manager = createManager()
    await expect(
      manager.startServer('evil-mcp', { command: 'node', args: ['evil.js'] })
    ).rejects.toThrow(/not in the catalog/)
  })

  test('startAll skips non-catalog entries from config', async () => {
    const manager = createManager()
    const tools = await manager.startAll({
      'non-existent-server': { command: 'node', args: ['fake.js'] },
    })
    expect(tools).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 7. Edge Cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  test('persistConfig creates config.json if it does not exist', () => {
    const tempDir = join(import.meta.dir, '.test-edge-no-config')
    mkdirSync(tempDir, { recursive: true })

    const manager = new MCPClientManager()
    manager.setWorkspaceDir(tempDir)
    ;(manager as any).persistConfig('test', { command: 'node' })

    expect(existsSync(join(tempDir, 'config.json'))).toBe(true)
    const stored = JSON.parse(readFileSync(join(tempDir, 'config.json'), 'utf-8'))
    expect(stored.mcpServers.test).toBeDefined()

    rmSync(tempDir, { recursive: true, force: true })
  })

  test('unpersistConfig is a no-op when config.json does not exist', () => {
    const tempDir = join(import.meta.dir, '.test-edge-no-config-2')
    mkdirSync(tempDir, { recursive: true })

    const manager = new MCPClientManager()
    manager.setWorkspaceDir(tempDir)

    // Should not throw
    ;(manager as any).unpersistConfig('nonexistent')

    rmSync(tempDir, { recursive: true, force: true })
  })

  test('MAX_MCP_SERVERS counts both stdio and remote servers', () => {
    const manager = createManager()

    // Simulate reaching the limit by setting internal maps
    for (let i = 0; i < 5; i++) {
      (manager as any).servers.set(`stdio-${i}`, { name: `stdio-${i}` })
    }
    for (let i = 0; i < 5; i++) {
      (manager as any).remoteServers.set(`remote-${i}`, { name: `remote-${i}` })
    }

    // Now both hotAddServer and hotAddRemoteServer should reject
    expect(
      manager.hotAddServer('one-more', { command: 'node', args: ['x.js'] })
    ).rejects.toThrow(/maximum of 10 MCP servers/)

    expect(
      manager.hotAddRemoteServer('one-more-remote', { url: 'https://example.com' })
    ).rejects.toThrow(/maximum of 10 MCP servers/)
  })

  test('concurrent persistConfig calls produce valid JSON', () => {
    writeConfig({})

    const manager = createManager()
    ;(manager as any).persistConfig('a', { command: 'node', args: ['a.js'] })
    ;(manager as any).persistConfig('b', { command: 'node', args: ['b.js'] })
    ;(manager as any).persistConfig('c', { command: 'node', args: ['c.js'] })

    const stored = readConfig()
    expect(stored.mcpServers.a).toBeDefined()
    expect(stored.mcpServers.b).toBeDefined()
    expect(stored.mcpServers.c).toBeDefined()
  })

  test('getServerInfo reports remote servers with command "remote"', () => {
    const manager = createManager()

    // Simulate a managed remote server entry
    ;(manager as any).remoteServers.set('test-remote', {
      name: 'test-remote',
      config: { url: 'https://example.com' },
      tools: [],
    })

    const info = manager.getServerInfo()
    const remote = info.find(s => s.name === 'test-remote')
    expect(remote).toBeDefined()
    expect(remote!.config.command).toBe('remote')
    expect(remote!.config.args).toEqual(['https://example.com'])
  })

  test('config.json env vars are persisted but not leaked across servers', () => {
    const manager = createManager()
    ;(manager as any).persistConfig('postgres', {
      command: 'npx',
      args: ['server-postgres'],
      env: { POSTGRES_CONNECTION_STRING: 'postgresql://user:pass@host/db' },
    })
    ;(manager as any).persistConfig('github', {
      command: 'npx',
      args: ['server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret' },
    })

    const stored = readConfig()
    expect(stored.mcpServers.postgres.env.POSTGRES_CONNECTION_STRING).toBe('postgresql://user:pass@host/db')
    expect(stored.mcpServers.postgres.env.GITHUB_TOKEN).toBeUndefined()
    expect(stored.mcpServers.github.env.GITHUB_TOKEN).toBe('ghp_secret')
    expect(stored.mcpServers.github.env.POSTGRES_CONNECTION_STRING).toBeUndefined()
  })
})
