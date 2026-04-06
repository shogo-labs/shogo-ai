// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for MCP pre-install resolution and whitelist enforcement.
 *
 * Verifies that the MCPClientManager correctly detects pre-installed packages,
 * resolves npx commands to direct node invocations, and rejects non-whitelisted servers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const TEST_PREINSTALL_DIR = join(import.meta.dir, '.test-mcp-packages')
const TEST_WORKSPACE_DIR = join(import.meta.dir, '.test-workspace')

// Set env BEFORE importing the module so the const picks it up
process.env.MCP_PREINSTALL_DIR = TEST_PREINSTALL_DIR

// Dynamic import so env is set first
const { MCPClientManager } = await import('../mcp-client')
const { isPreinstalledMcpId, getPreinstalledPackages, getPreinstalledEntry, MCP_CATALOG } = await import('../mcp-catalog')

function setupFakePackage(pkgName: string, binEntry: string | Record<string, string>) {
  const pkgDir = join(TEST_PREINSTALL_DIR, 'node_modules', pkgName)
  mkdirSync(pkgDir, { recursive: true })

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, bin: binEntry }))

  const entryFile = typeof binEntry === 'string' ? binEntry : Object.values(binEntry)[0]
  const entryPath = join(pkgDir, entryFile)
  mkdirSync(join(entryPath, '..'), { recursive: true })
  writeFileSync(entryPath, '#!/usr/bin/env node\nconsole.log("ok")')
}

describe('MCP pre-install resolution', () => {
  beforeAll(() => {
    mkdirSync(TEST_WORKSPACE_DIR, { recursive: true })

    setupFakePackage('@openbnb/mcp-server-airbnb', { 'mcp-server-airbnb': 'dist/index.js' })
    setupFakePackage('mcp-fetch-node', { 'mcp-fetch-node': 'index.js' })
    setupFakePackage('mcp-server-sqlite', 'src/index.js')
  })

  afterAll(() => {
    rmSync(TEST_PREINSTALL_DIR, { recursive: true, force: true })
    rmSync(TEST_WORKSPACE_DIR, { recursive: true, force: true })
  })

  function createManager(): InstanceType<typeof MCPClientManager> {
    const manager = new MCPClientManager()
    manager.setWorkspaceDir(TEST_WORKSPACE_DIR)
    return manager
  }

  test('resolves npx command for pre-installed package with object bin', () => {
    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@openbnb/mcp-server-airbnb@latest'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args[0]).toContain('mcp-server-airbnb')
    expect(resolved.args[0]).toContain('dist/index.js')
    expect(resolved.args).not.toContain('-y')
    expect(resolved.args).not.toContain('@openbnb/mcp-server-airbnb@latest')
  })

  test('resolves npx command for pre-installed package with string bin', () => {
    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', 'mcp-server-sqlite@latest'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args[0]).toContain('mcp-server-sqlite')
    expect(resolved.args[0]).toContain('src/index.js')
  })

  test('strips version specifiers correctly', () => {
    const manager = createManager()

    const withLatest = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', 'mcp-fetch-node@latest'],
    })
    expect(withLatest.command).toBe('node')

    const withVersion = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', 'mcp-fetch-node@1.2.3'],
    })
    expect(withVersion.command).toBe('node')
  })

  test('passes through non-npx commands unchanged', () => {
    const manager = createManager()
    const config = { command: 'bun', args: ['run', 'server.ts'] }
    const resolved = (manager as any).resolvePreinstalled(config)

    expect(resolved).toBe(config)
  })

  test('falls through for non-pre-installed packages', () => {
    const manager = createManager()
    const config = {
      command: 'npx',
      args: ['-y', 'some-unknown-mcp-package@latest'],
    }
    const resolved = (manager as any).resolvePreinstalled(config)

    expect(resolved.command).toBe('npx')
    expect(resolved.args).toEqual(['-y', 'some-unknown-mcp-package@latest'])
  })

  test('preserves extra args after the package name', () => {
    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@openbnb/mcp-server-airbnb@latest', '--port', '3000'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args).toContain('--port')
    expect(resolved.args).toContain('3000')
  })

  test('preserves env and cwd from original config', () => {
    const manager = createManager()
    const resolved = (manager as any).resolvePreinstalled({
      command: 'npx',
      args: ['-y', '@openbnb/mcp-server-airbnb@latest'],
      env: { FOO: 'bar' },
      cwd: '/tmp/test',
    })

    expect(resolved.command).toBe('node')
    expect(resolved.env).toEqual({ FOO: 'bar' })
    expect(resolved.cwd).toBe('/tmp/test')
  })

  test('does not mutate the original config (persistence safety)', () => {
    const manager = createManager()
    const originalConfig = {
      command: 'npx' as const,
      args: ['-y', '@openbnb/mcp-server-airbnb@latest'],
    }
    const argsCopy = [...originalConfig.args]

    const resolved = (manager as any).resolvePreinstalled(originalConfig)

    expect(originalConfig.command).toBe('npx')
    expect(originalConfig.args).toEqual(argsCopy)
    expect(resolved).not.toBe(originalConfig)
  })
})

describe('MCP whitelist enforcement', () => {
  test('isPreinstalledMcpId returns true for whitelisted servers', () => {
    expect(isPreinstalledMcpId('fetch')).toBe(true)
    expect(isPreinstalledMcpId('airbnb')).toBe(true)
    expect(isPreinstalledMcpId('filesystem')).toBe(true)
    expect(isPreinstalledMcpId('playwright')).toBe(true)
    expect(isPreinstalledMcpId('mongodb')).toBe(true)
    expect(isPreinstalledMcpId('discourse')).toBe(true)
    expect(isPreinstalledMcpId('sqlite')).toBe(true)
    expect(isPreinstalledMcpId('stripe')).toBe(true)
    expect(isPreinstalledMcpId('exa')).toBe(true)
    expect(isPreinstalledMcpId('sentry')).toBe(true)
  })

  test('removed deprecated @modelcontextprotocol packages are no longer preinstalled', () => {
    expect(isPreinstalledMcpId('postgres')).toBe(false)
    expect(isPreinstalledMcpId('github')).toBe(false)
    expect(isPreinstalledMcpId('gitlab')).toBe(false)
    expect(isPreinstalledMcpId('brave-search')).toBe(false)
    expect(isPreinstalledMcpId('slack')).toBe(false)
  })

  test('isPreinstalledMcpId returns false for arbitrary names', () => {
    expect(isPreinstalledMcpId('malicious-server')).toBe(false)
    expect(isPreinstalledMcpId('')).toBe(false)
    expect(isPreinstalledMcpId('custom-mcp')).toBe(false)
  })

  test('getPreinstalledPackages returns all preinstalled entries', () => {
    const preinstalled = getPreinstalledPackages()
    const ids = preinstalled.map(e => e.id)

    expect(ids).toContain('fetch')
    expect(ids).toContain('airbnb')
    expect(ids).toContain('filesystem')
    expect(ids).toContain('playwright')
    expect(ids).toContain('mongodb')
    expect(ids).toContain('discourse')
    expect(ids).toContain('sqlite')
    expect(ids).toContain('exa')
    expect(ids).toContain('sentry')

    expect(ids).not.toContain('postgres')
    expect(ids).not.toContain('github')
    expect(ids).not.toContain('gitlab')
    expect(ids).not.toContain('brave-search')
    expect(ids).not.toContain('slack')

    expect(preinstalled.every(e => e.preinstalled === true)).toBe(true)
  })

  test('getPreinstalledEntry returns entry for preinstalled, undefined for unknown', () => {
    const fetchEntry = getPreinstalledEntry('fetch')
    expect(fetchEntry).toBeDefined()
    expect(fetchEntry!.id).toBe('fetch')
    expect(fetchEntry!.preinstalled).toBe(true)

    const mongoEntry = getPreinstalledEntry('mongodb')
    expect(mongoEntry).toBeDefined()
    expect(mongoEntry!.package).toBe('mongodb-mcp-server@latest')

    const playwrightEntry = getPreinstalledEntry('playwright')
    expect(playwrightEntry).toBeDefined()
    expect(playwrightEntry!.package).toBe('@playwright/mcp@latest')

    expect(getPreinstalledEntry('postgres')).toBeUndefined()
    expect(getPreinstalledEntry('github')).toBeUndefined()
    expect(getPreinstalledEntry('gitlab')).toBeUndefined()
    expect(getPreinstalledEntry('brave-search')).toBeUndefined()
    expect(getPreinstalledEntry('slack')).toBeUndefined()
    expect(getPreinstalledEntry('unknown')).toBeUndefined()
  })

  test('Composio-only entries (gmail, google-drive, google-calendar) are not preinstalled', () => {
    const gmail = MCP_CATALOG.find(e => e.id === 'gmail')
    expect(gmail).toBeDefined()
    expect(gmail!.preinstalled).toBeUndefined()

    const drive = MCP_CATALOG.find(e => e.id === 'google-drive')
    expect(drive).toBeDefined()
    expect(drive!.preinstalled).toBeUndefined()
  })

  test('startServer rejects non-catalog server names', async () => {
    const manager = new MCPClientManager()
    manager.setWorkspaceDir(TEST_WORKSPACE_DIR)

    await expect(
      manager.startServer('evil-mcp', { command: 'npx', args: ['evil-package@latest'] })
    ).rejects.toThrow(/not in the catalog/)
  })

  test('hotAddServer rejects non-catalog server names', async () => {
    const manager = new MCPClientManager()
    manager.setWorkspaceDir(TEST_WORKSPACE_DIR)

    await expect(
      manager.hotAddServer('totally-unknown', { command: 'node', args: ['malicious.js'] })
    ).rejects.toThrow(/not in the catalog/)
  })

  test('startAll skips non-catalog entries from config', async () => {
    const manager = new MCPClientManager()
    manager.setWorkspaceDir(TEST_WORKSPACE_DIR)

    const configs = {
      'custom-bad': { command: 'node', args: ['malicious.js'] },
    }

    const tools = await manager.startAll(configs)
    expect(tools).toEqual([])
  })
})

describe('Proxy tool groups (Composio integration)', () => {
  function createManager(): InstanceType<typeof MCPClientManager> {
    const manager = new MCPClientManager()
    manager.setWorkspaceDir(TEST_WORKSPACE_DIR)
    return manager
  }

  function makeFakeTool(name: string) {
    return {
      name,
      description: `Fake tool: ${name}`,
      parameters: {},
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    } as any
  }

  test('addProxyTools stores tools under a named group', () => {
    const manager = createManager()
    const tools = [makeFakeTool('GCAL_LIST'), makeFakeTool('GCAL_CREATE')]
    manager.addProxyTools('googlecalendar', tools)

    expect(manager.hasProxyToolGroup('googlecalendar')).toBe(true)
    expect(manager.hasProxyToolGroup('slack')).toBe(false)
  })

  test('getTools includes proxy tool group tools', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST'), makeFakeTool('GCAL_CREATE')])
    manager.addProxyTools('slack', [makeFakeTool('SLACK_SEND')])

    const allTools = manager.getTools()
    const names = allTools.map(t => t.name)
    expect(names).toContain('GCAL_LIST')
    expect(names).toContain('GCAL_CREATE')
    expect(names).toContain('SLACK_SEND')
  })

  test('getServerInfo includes proxy tool groups with composio-proxy command', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST'), makeFakeTool('GCAL_CREATE')])

    const info = manager.getServerInfo()
    const gcalInfo = info.find(s => s.name === 'googlecalendar')

    expect(gcalInfo).toBeDefined()
    expect(gcalInfo!.toolCount).toBe(2)
    expect(gcalInfo!.toolNames).toEqual(['GCAL_LIST', 'GCAL_CREATE'])
    expect(gcalInfo!.config.command).toBe('composio-proxy')
  })

  test('isRunning returns true for proxy tool groups', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST')])

    expect(manager.isRunning('googlecalendar')).toBe(true)
    expect(manager.isRunning('slack')).toBe(false)
  })

  test('removeProxyToolGroup removes the group and its tools', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST')])
    manager.addProxyTools('slack', [makeFakeTool('SLACK_SEND')])

    expect(manager.hasProxyToolGroup('googlecalendar')).toBe(true)
    const removed = manager.removeProxyToolGroup('googlecalendar')
    expect(removed).toBe(true)
    expect(manager.hasProxyToolGroup('googlecalendar')).toBe(false)
    expect(manager.isRunning('googlecalendar')).toBe(false)

    // slack should still be there
    expect(manager.hasProxyToolGroup('slack')).toBe(true)
    const allTools = manager.getTools()
    expect(allTools.map(t => t.name)).toEqual(['SLACK_SEND'])
  })

  test('addProxyTools deduplicates within a group', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST')])
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST'), makeFakeTool('GCAL_CREATE')])

    const info = manager.getServerInfo().find(s => s.name === 'googlecalendar')
    expect(info!.toolCount).toBe(2)
    expect(info!.toolNames).toEqual(['GCAL_LIST', 'GCAL_CREATE'])
  })

  test('getServerInfo returns both MCP servers and proxy groups together', () => {
    const manager = createManager()
    manager.addProxyTools('googlecalendar', [makeFakeTool('GCAL_LIST')])

    const info = manager.getServerInfo()
    const names = info.map(s => s.name)
    expect(names).toContain('googlecalendar')

    const gcal = info.find(s => s.name === 'googlecalendar')!
    expect(gcal.config.command).toBe('composio-proxy')
  })

  test('removeProxyToolGroup returns false for non-existent group', () => {
    const manager = createManager()
    expect(manager.removeProxyToolGroup('nonexistent')).toBe(false)
  })
})
