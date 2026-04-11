#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verify that a VM image has the runtime-template properly provisioned.
 *
 * Boots a single VM worker, waits for health, then checks:
 * 1. /health endpoint reports workspace.templateSeeded and depsInstalled
 * 2. Workspace contains package.json, vite.config.ts, src/App.tsx
 * 3. node_modules/.bin/vite exists (deps installed)
 *
 * Usage:
 *   bun run packages/agent-runtime/src/evals/verify-vm-image.ts [--mount] [--verbose]
 *
 * Exit codes: 0 = pass, 1 = fail
 */

import { resolve } from 'path'
import { existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'

const REPO_ROOT = resolve(__dirname, '../../../../')
const args = process.argv.slice(2)
const mountFlag = args.includes('--mount')
const verboseFlag = args.includes('--verbose') || args.includes('-v')

async function main() {
  console.log('='.repeat(60))
  console.log('VM IMAGE VERIFICATION')
  console.log('='.repeat(60))
  console.log(`  Mount: ${mountFlag ? 'yes (9p)' : 'no (overlay)'}`)
  console.log('')

  const { startVMWorker, stopVMWorker } = await import('./vm-worker')

  const vmConfig = {
    containerPrefix: 'verify-vm',
    baseHostPort: 39100,
    model: 'claude-sonnet-4-6',
    verbose: verboseFlag,
    mount: mountFlag,
  }

  console.log('Starting VM worker...')
  let worker: any
  try {
    worker = await startVMWorker(0, vmConfig)
    console.log(`  VM ready on port ${worker.port}\n`)
  } catch (err: any) {
    console.error(`FAIL: VM failed to start — ${err.message}`)
    process.exit(1)
  }

  const checks: Array<{ name: string; pass: boolean; detail: string }> = []

  try {
    // Check 1: /health endpoint workspace status
    const healthRes = await fetch(`http://localhost:${worker.port}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const health = await healthRes.json() as any
    const ws = health?.workspace

    checks.push({
      name: 'health.workspace.templateSeeded',
      pass: ws?.templateSeeded === true,
      detail: `${ws?.templateSeeded ?? 'missing'}`,
    })
    checks.push({
      name: 'health.workspace.depsInstalled',
      pass: ws?.depsInstalled === true,
      detail: `${ws?.depsInstalled ?? 'missing'}`,
    })
    checks.push({
      name: 'health.gateway.running',
      pass: health?.gateway?.running === true,
      detail: `${health?.gateway?.running ?? 'missing'}`,
    })

    // Check 2: Workspace file presence (via agent's list_directory tool or direct fs if mounted)
    if (mountFlag && worker.dir) {
      const wsDir = worker.dir
      const fileChecks = [
        ['package.json', existsSync(resolve(wsDir, 'package.json'))],
        ['vite.config.ts', existsSync(resolve(wsDir, 'vite.config.ts'))],
        ['src/App.tsx', existsSync(resolve(wsDir, 'src', 'App.tsx'))],
        ['tsconfig.json', existsSync(resolve(wsDir, 'tsconfig.json'))],
        ['index.html', existsSync(resolve(wsDir, 'index.html'))],
        ['node_modules/.bin/vite', existsSync(resolve(wsDir, 'node_modules', '.bin', 'vite'))],
        ['node_modules/react', existsSync(resolve(wsDir, 'node_modules', 'react'))],
      ] as const

      for (const [name, exists] of fileChecks) {
        checks.push({
          name: `workspace/${name}`,
          pass: exists,
          detail: exists ? 'present' : 'MISSING',
        })
      }
    } else {
      // Non-mount: use the agent's API to check workspace contents
      try {
        const chatRes = await fetch(`http://localhost:${worker.port}/agent/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'List the files in the workspace root directory. Just output the filenames.' }],
            stream: false,
          }),
          signal: AbortSignal.timeout(30_000),
        })
        const chatBody = await chatRes.json() as any
        const response = chatBody?.response || chatBody?.content || ''
        const hasPackageJson = response.toLowerCase().includes('package.json')
        const hasViteConfig = response.toLowerCase().includes('vite.config')
        const hasSrc = response.toLowerCase().includes('src')

        checks.push({
          name: 'agent sees package.json',
          pass: hasPackageJson,
          detail: hasPackageJson ? 'found' : 'not mentioned',
        })
        checks.push({
          name: 'agent sees vite.config',
          pass: hasViteConfig,
          detail: hasViteConfig ? 'found' : 'not mentioned',
        })
        checks.push({
          name: 'agent sees src/',
          pass: hasSrc,
          detail: hasSrc ? 'found' : 'not mentioned',
        })
      } catch (err: any) {
        checks.push({
          name: 'agent workspace listing',
          pass: false,
          detail: `error: ${err.message}`,
        })
      }
    }

    // Print results
    console.log('Results:')
    console.log('-'.repeat(60))
    let allPass = true
    for (const c of checks) {
      const icon = c.pass ? '✓' : '✗'
      console.log(`  ${icon} ${c.name}: ${c.detail}`)
      if (!c.pass) allPass = false
    }
    console.log('-'.repeat(60))
    console.log(allPass ? '\nPASS: VM image is properly provisioned.' : '\nFAIL: VM image is missing template or deps.')

    stopVMWorker(worker)
    process.exit(allPass ? 0 : 1)
  } catch (err: any) {
    console.error(`\nFAIL: Verification error — ${err.message}`)
    stopVMWorker(worker)
    process.exit(1)
  }
}

main()
