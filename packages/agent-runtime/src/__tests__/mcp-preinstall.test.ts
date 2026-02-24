/**
 * Tests for MCP pre-install resolution.
 *
 * Verifies that the MCPClientManager correctly detects pre-installed packages
 * and resolves npx commands to direct node invocations.
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
    setupFakePackage('@modelcontextprotocol/server-github', 'dist/index.js')
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
      args: ['-y', '@modelcontextprotocol/server-github@latest'],
    })

    expect(resolved.command).toBe('node')
    expect(resolved.args[0]).toContain('server-github')
    expect(resolved.args[0]).toContain('dist/index.js')
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
