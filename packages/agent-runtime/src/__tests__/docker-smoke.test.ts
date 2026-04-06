// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Docker Smoke Tests — Playwright Browser & Airbnb MCP
 *
 * Validates that pre-installed packages in the Docker image actually work:
 *   1. Playwright can import playwright-core and launch system Chromium
 *   2. Airbnb MCP server starts, connects, and exposes expected tools
 *
 * Run inside the Docker container:
 *   bun test src/__tests__/docker-smoke.test.ts
 *
 * Or standalone (for CI):
 *   bun run src/__tests__/docker-smoke.test.ts
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync, spawn } from 'child_process'

const MCP_PREINSTALL_DIR = process.env.MCP_PREINSTALL_DIR || '/app/mcp-packages'
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium'

// ---------------------------------------------------------------------------
// Playwright / Browser
// ---------------------------------------------------------------------------
describe('Playwright browser launch', () => {
  let browser: any = null

  afterAll(async () => {
    if (browser) {
      try { await browser.close() } catch {}
    }
  })

  test('playwright-core can be imported', async () => {
    const pw = await import('playwright-core')
    expect(pw).toBeDefined()
    expect(pw.chromium).toBeDefined()
  })

  test('system Chromium binary exists', () => {
    expect(existsSync(CHROMIUM_PATH)).toBe(true)
  })

  test('Chromium binary is executable', () => {
    const output = execSync(`${CHROMIUM_PATH} --version 2>&1 || true`, {
      timeout: 10_000,
      encoding: 'utf-8',
    })
    expect(output.toLowerCase()).toMatch(/chromium/)
  })

  test('can launch headless Chromium and navigate', async () => {
    const pw = await import('playwright-core')

    browser = await pw.chromium.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    expect(browser).toBeDefined()

    const page = await browser.newPage()
    await page.goto('data:text/html,<h1>Shogo Smoke Test</h1>')

    const title = await page.evaluate(() => document.querySelector('h1')?.textContent)
    expect(title).toBe('Shogo Smoke Test')

    await page.close()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Airbnb MCP Server
// ---------------------------------------------------------------------------
describe('Airbnb MCP server', () => {
  const PKG_NAME = '@openbnb/mcp-server-airbnb'
  const pkgJsonPath = join(MCP_PREINSTALL_DIR, 'node_modules', PKG_NAME, 'package.json')

  test('package is pre-installed in Docker image', () => {
    expect(existsSync(pkgJsonPath)).toBe(true)
  })

  test('package.json has a valid bin entry', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    const binEntry = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin && Object.values(pkg.bin)[0]
    expect(binEntry).toBeDefined()
    expect(typeof binEntry).toBe('string')

    const fullPath = join(MCP_PREINSTALL_DIR, 'node_modules', PKG_NAME, binEntry as string)
    expect(existsSync(fullPath)).toBe(true)
  })

  test('MCP server starts and lists tools via stdio', async () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    const binEntry = typeof pkg.bin === 'string'
      ? pkg.bin
      : Object.values(pkg.bin)[0] as string
    const entrypoint = join(MCP_PREINSTALL_DIR, 'node_modules', PKG_NAME, binEntry)

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

    const transport = new StdioClientTransport({
      command: 'node',
      args: [entrypoint, '--ignore-robots-txt'],
      env: { ...process.env, HOME: '/tmp' } as Record<string, string>,
      stderr: 'pipe',
    })

    const client = new Client(
      { name: 'smoke-test', version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('MCP connect timed out after 30s')), 30_000)
        ),
      ])

      const result = await Promise.race([
        client.listTools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('listTools timed out after 15s')), 15_000)
        ),
      ])

      const toolNames = (result.tools || []).map((t: any) => t.name)
      expect(toolNames).toContain('airbnb_search')
      expect(toolNames).toContain('airbnb_listing_details')
      expect(toolNames.length).toBeGreaterThanOrEqual(2)
    } finally {
      try { await transport.close() } catch {}
    }
  }, 45_000)
})

// ---------------------------------------------------------------------------
// All pre-installed MCP packages: basic resolution check
// ---------------------------------------------------------------------------
describe('Pre-installed MCP packages resolution', () => {
  const { MCP_CATALOG } = require('../mcp-catalog')
  const preinstalled = MCP_CATALOG.filter((e: any) => e.preinstalled)

  for (const entry of preinstalled) {
    test(`${entry.id}: package exists in pre-install dir`, () => {
      const pkgName = entry.package.replace(/@(latest|[\d^~>=<].*)$/, '')
      const pkgPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, 'package.json')
      expect(existsSync(pkgPath)).toBe(true)
    })

    test(`${entry.id}: bin entrypoint resolves`, () => {
      const pkgName = entry.package.replace(/@(latest|[\d^~>=<].*)$/, '')
      const pkgPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

      let binEntry: string | undefined
      if (typeof pkg.bin === 'string') {
        binEntry = pkg.bin
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        binEntry = Object.values(pkg.bin)[0] as string
      }
      if (!binEntry && pkg.main) {
        binEntry = pkg.main
      }

      expect(binEntry).toBeDefined()
      const fullPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, binEntry!)
      expect(existsSync(fullPath)).toBe(true)
    })
  }
})
