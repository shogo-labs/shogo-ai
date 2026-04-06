#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Standalone smoke-test runner for Docker image validation.
 *
 * Runs outside of bun:test so it can be invoked directly:
 *   bun run src/__tests__/docker-smoke-runner.ts
 *
 * Exit code 0 = all pass, 1 = any failure.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const MCP_PREINSTALL_DIR = process.env.MCP_PREINSTALL_DIR || '/app/mcp-packages'
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium'

let passed = 0
let failed = 0

function ok(name: string) { passed++; console.log(`  ✓ ${name}`) }
function fail(name: string, err: any) { failed++; console.error(`  ✗ ${name}: ${err?.message || err}`) }

// ---------------------------------------------------------------------------
// 1. Playwright / Browser
// ---------------------------------------------------------------------------
console.log('\n═══ Playwright Browser ═══')

try {
  const pw = await import('playwright-core')
  if (!pw?.chromium) throw new Error('chromium launcher missing')
  ok('playwright-core imports successfully')
} catch (e) { fail('playwright-core imports successfully', e) }

try {
  if (!existsSync(CHROMIUM_PATH)) throw new Error(`Not found: ${CHROMIUM_PATH}`)
  ok(`system Chromium exists at ${CHROMIUM_PATH}`)
} catch (e) { fail(`system Chromium exists at ${CHROMIUM_PATH}`, e) }

try {
  const ver = execSync(`${CHROMIUM_PATH} --version 2>&1`, { timeout: 10_000, encoding: 'utf-8' }).trim()
  if (!/chromium/i.test(ver)) throw new Error(`Unexpected version output: ${ver}`)
  ok(`Chromium version: ${ver}`)
} catch (e) { fail('Chromium --version', e) }

try {
  const pw = await import('playwright-core')
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const page = await browser.newPage()
  await page.goto('data:text/html,<h1>Shogo Smoke Test</h1>')
  const title = await page.evaluate(() => document.querySelector('h1')?.textContent)
  if (title !== 'Shogo Smoke Test') throw new Error(`Expected "Shogo Smoke Test", got "${title}"`)
  await page.close()
  await browser.close()
  ok('launch headless Chromium, navigate, read DOM')
} catch (e) { fail('launch headless Chromium', e) }

// ---------------------------------------------------------------------------
// 2. Airbnb MCP Server
// ---------------------------------------------------------------------------
console.log('\n═══ Airbnb MCP Server ═══')

const AIRBNB_PKG = '@openbnb/mcp-server-airbnb'
const airbnbPkgJson = join(MCP_PREINSTALL_DIR, 'node_modules', AIRBNB_PKG, 'package.json')

try {
  if (!existsSync(airbnbPkgJson)) throw new Error(`Not found: ${airbnbPkgJson}`)
  ok('package pre-installed')
} catch (e) { fail('package pre-installed', e) }

let airbnbEntrypoint = ''
try {
  const pkg = JSON.parse(readFileSync(airbnbPkgJson, 'utf-8'))
  const binEntry = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0] as string
  if (!binEntry) throw new Error('No bin entry')
  airbnbEntrypoint = join(MCP_PREINSTALL_DIR, 'node_modules', AIRBNB_PKG, binEntry)
  if (!existsSync(airbnbEntrypoint)) throw new Error(`Entrypoint not found: ${airbnbEntrypoint}`)
  ok(`bin entrypoint resolves: ${binEntry}`)
} catch (e) { fail('bin entrypoint resolves', e) }

if (airbnbEntrypoint) {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

    const transport = new StdioClientTransport({
      command: 'node',
      args: [airbnbEntrypoint, '--ignore-robots-txt'],
      env: { ...process.env, HOME: '/tmp' } as Record<string, string>,
      stderr: 'pipe',
    })

    const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} })

    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout 30s')), 30_000)),
    ])

    const result = await Promise.race([
      client.listTools(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listTools timeout 15s')), 15_000)),
    ])

    const toolNames = (result.tools || []).map((t: any) => t.name)
    if (!toolNames.includes('airbnb_search')) throw new Error(`Missing tool: airbnb_search (got: ${toolNames})`)
    if (!toolNames.includes('airbnb_listing_details')) throw new Error(`Missing tool: airbnb_listing_details`)
    ok(`MCP server connected, tools: ${toolNames.join(', ')}`)

    try { await transport.close() } catch {}
  } catch (e) { fail('MCP server starts and lists tools', e) }
}

// ---------------------------------------------------------------------------
// 3. All pre-installed packages: basic file resolution
// ---------------------------------------------------------------------------
console.log('\n═══ Pre-installed MCP Package Resolution ═══')

const { MCP_CATALOG } = await import('../mcp-catalog')
const preinstalled = MCP_CATALOG.filter((e: any) => e.preinstalled)

for (const entry of preinstalled) {
  const pkgName = entry.package.replace(/@(latest|[\d^~>=<].*)$/, '')
  const pkgPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, 'package.json')
  try {
    if (!existsSync(pkgPath)) throw new Error(`Not found: ${pkgPath}`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    let binEntry: string | undefined
    if (typeof pkg.bin === 'string') binEntry = pkg.bin
    else if (pkg.bin && typeof pkg.bin === 'object') binEntry = Object.values(pkg.bin)[0] as string
    if (!binEntry && pkg.main) binEntry = pkg.main
    if (!binEntry) throw new Error('No bin or main entry in package.json')
    const fullPath = join(MCP_PREINSTALL_DIR, 'node_modules', pkgName, binEntry)
    if (!existsSync(fullPath)) throw new Error(`Entrypoint missing: ${fullPath}`)
    ok(`${entry.id} → ${pkgName}`)
  } catch (e) { fail(`${entry.id} → ${pkgName}`, e) }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`)
process.exit(failed > 0 ? 1 : 0)
