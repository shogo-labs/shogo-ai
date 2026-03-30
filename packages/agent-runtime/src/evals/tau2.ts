#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tau2-bench Benchmark Runner
 *
 * Evaluates the Shogo agent on multi-turn customer service scenarios using
 * the Tau2-bench framework. Tau2 provides a user simulator + domain-specific
 * tools (airline, retail, telecom) and handles the dual-control conversation
 * loop natively.
 *
 * This runner uses a wrapper approach: it shells out to the `tau2` CLI,
 * configuring it to use the Shogo agent endpoint as the agent LLM.
 *
 * Prerequisites:
 *   pip install "git+https://github.com/sierra-research/tau2-bench@v1.0.0"
 *
 * Usage:
 *   bun run src/evals/tau2.ts --model haiku --domain airline
 *   bun run src/evals/tau2.ts --model sonnet --domain retail --num-trials 3
 *   bun run src/evals/tau2.ts --model haiku --domain all --verbose
 *   bun run src/evals/tau2.ts --model haiku --domain airline --build
 */

import { execSync, spawn } from 'child_process'
import {
  mkdirSync, existsSync, writeFileSync, readFileSync,
} from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

import {
  type DockerWorker,
  type DockerWorkerConfig,
  loadEnvFromDisk,
  getArg,
  MODEL_MAP,
  PRICING,
  REPO_ROOT,
  DEFAULT_RUNTIME_IMAGE,
  writeDockerEnvFile,
  cleanupDockerEnvFile,
  ensureDockerImage,
  startDockerWorker,
  stopDockerWorker,
  configureWorkerForTask,
  registerCleanupHandlers,
} from './docker-worker'

loadEnvFromDisk(REPO_ROOT)

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

const modelArg = getArg(args, 'model', 'haiku')!
const domainArg = getArg(args, 'domain', 'airline')!
const numTrials = parseInt(getArg(args, 'num-trials', '1')!)
const userLlm = getArg(args, 'user-llm', 'gpt-4.1')!
const splitArg = getArg(args, 'split', 'base')!
const verboseFlag = args.includes('--verbose') || args.includes('-v')
const buildFlag = args.includes('--build')

const BASE_PORT = 7500

const DOMAINS = domainArg === 'all' ? ['airline', 'retail', 'telecom'] : [domainArg]

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface DomainResult {
  domain: string
  total: number
  passed: number
  passRate: number
  durationS: number
  rawOutput: string
}

// ---------------------------------------------------------------------------
// Run tau2 CLI for a domain
// ---------------------------------------------------------------------------

async function runTau2Domain(
  domain: string,
  agentPort: number,
): Promise<DomainResult> {
  const startTime = Date.now()

  const outputDir = resolve(tmpdir(), `tau2-${domain}-${Date.now()}`)
  mkdirSync(outputDir, { recursive: true })

  // The tau2 CLI accepts model names for its built-in LLM adapters.
  // For our integration, we use the Anthropic model name since tau2
  // supports Anthropic directly, and we let tau2 handle the agent-side
  // model calls. The agent LLM config points to the model we want to test.
  const agentModel = MODEL_MAP[modelArg] || modelArg

  const tau2Args = [
    'run',
    '--domain', domain,
    '--agent-llm', agentModel,
    '--user-llm', userLlm,
    '--num-trials', String(numTrials),
    '--split', splitArg,
    '--output-dir', outputDir,
  ]

  console.log(`  Running tau2 ${tau2Args.join(' ')}...`)

  return new Promise<DomainResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('tau2', tau2Args, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      if (verboseFlag) process.stdout.write(text)
    })

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      if (verboseFlag) process.stderr.write(text)
    })

    proc.on('error', (err) => {
      reject(new Error(`tau2 CLI not found. Install with: pip install "git+https://github.com/sierra-research/tau2-bench@v1.0.0"\n${err.message}`))
    })

    proc.on('close', (code) => {
      const duration = (Date.now() - startTime) / 1000
      const output = stdout + stderr

      // Parse results from tau2 output
      let total = 0, passed = 0
      const scoreMatch = output.match(/(?:pass|success)\s*(?:rate)?[:\s]*(\d+)\s*\/\s*(\d+)/i)
      if (scoreMatch) {
        passed = parseInt(scoreMatch[1])
        total = parseInt(scoreMatch[2])
      }

      const rateMatch = output.match(/(?:accuracy|pass.?rate|score)[:\s]*([\d.]+)%/i)
      if (rateMatch && total === 0) {
        const rate = parseFloat(rateMatch[1]) / 100
        const countMatch = output.match(/(?:total|tasks|episodes)[:\s]*(\d+)/i)
        if (countMatch) {
          total = parseInt(countMatch[1])
          passed = Math.round(rate * total)
        }
      }

      // Try to read results JSON from output dir
      try {
        const resultsFile = join(outputDir, 'results.json')
        if (existsSync(resultsFile)) {
          const data = JSON.parse(readFileSync(resultsFile, 'utf-8'))
          if (data.total) total = data.total
          if (data.passed !== undefined) passed = data.passed
          else if (data.pass_rate !== undefined) passed = Math.round(data.pass_rate * total)
        }
      } catch {}

      resolve({
        domain,
        total,
        passed,
        passRate: total > 0 ? (passed / total) * 100 : 0,
        durationS: duration,
        rawOutput: output,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let globalWorkers: DockerWorker[] = []

registerCleanupHandlers(() => globalWorkers, 'tau2-crash.log')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('')
  console.log('='.repeat(60))
  console.log('TAU2-BENCH BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:      ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Domains:    ${DOMAINS.join(', ')}`)
  console.log(`  User LLM:   ${userLlm}`)
  console.log(`  Trials:     ${numTrials}`)
  console.log(`  Split:      ${splitArg}`)
  console.log('')

  // Verify tau2 is installed
  try {
    execSync('tau2 --help', { stdio: 'pipe', timeout: 10_000 })
  } catch {
    console.error('tau2 CLI not found.')
    console.error('Install with: pip install "git+https://github.com/sierra-research/tau2-bench@v1.0.0"')
    process.exit(1)
  }

  const overallStart = Date.now()
  const allResults: DomainResult[] = []

  console.log('Running evaluations...')
  console.log('-'.repeat(60))

  for (const domain of DOMAINS) {
    console.log('')
    console.log(`Domain: ${domain}`)
    console.log('-'.repeat(30))

    try {
      const result = await runTau2Domain(domain, BASE_PORT)
      allResults.push(result)

      console.log(`  ${domain}: ${result.passed}/${result.total} (${result.passRate.toFixed(1)}%) in ${result.durationS.toFixed(1)}s`)
    } catch (err: any) {
      console.error(`  ${domain}: ERROR — ${err.message}`)
      allResults.push({
        domain,
        total: 0,
        passed: 0,
        passRate: 0,
        durationS: 0,
        rawOutput: err.message,
      })
    }
  }

  const totalTime = (Date.now() - overallStart) / 1000

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const totalTasks = allResults.reduce((s, r) => s + r.total, 0)
  const totalPassed = allResults.reduce((s, r) => s + r.passed, 0)

  console.log('')
  console.log('='.repeat(60))
  console.log('TAU2-BENCH RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Total tasks:  ${totalTasks}`)
  console.log(`  Passed:       ${totalPassed} (${totalTasks > 0 ? (totalPassed / totalTasks * 100).toFixed(1) : 0}%)`)
  console.log('')

  for (const r of allResults) {
    console.log(`  ${r.domain.padEnd(12)} ${r.passed}/${r.total} (${r.passRate.toFixed(1)}%) — ${r.durationS.toFixed(1)}s`)
  }
  console.log('')
  console.log(`  Total duration: ${totalTime.toFixed(1)}s`)

  // Write results
  const resultsPath = resolve(tmpdir(), `tau2-results-${modelArg}-${Date.now()}.json`)
  writeFileSync(resultsPath, JSON.stringify({
    benchmark: 'tau2-bench',
    model: MODEL_MAP[modelArg] || modelArg,
    userLlm,
    numTrials,
    split: splitArg,
    timestamp: new Date().toISOString(),
    domains: allResults,
    summary: {
      totalTasks,
      totalPassed,
      overallPassRate: totalTasks > 0 ? `${(totalPassed / totalTasks * 100).toFixed(1)}%` : '0%',
      totalDurationS: Math.round(totalTime),
    },
  }, null, 2))
  console.log(`Results saved: ${resultsPath}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
