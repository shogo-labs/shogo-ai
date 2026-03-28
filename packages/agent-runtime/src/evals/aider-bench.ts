#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Aider Polyglot Benchmark Runner
 *
 * Runs the Python + JavaScript subset of the Aider Polyglot benchmark
 * through the Shogo agent and records pass/fail per exercise.
 *
 * Usage:
 *   bun run src/evals/aider-bench.ts --model haiku
 *   bun run src/evals/aider-bench.ts --model sonnet --lang python --workers 3
 *   bun run src/evals/aider-bench.ts --model haiku --filter affine --verbose
 */

import { spawn, type Subprocess } from 'bun'
import { execSync } from 'child_process'
import {
  mkdirSync, rmSync, existsSync, writeFileSync, readFileSync,
  readdirSync, copyFileSync, appendFileSync, statSync,
} from 'fs'
import { resolve, join, dirname, basename, relative } from 'path'
import { tmpdir } from 'os'

import { sendTurn, type EvalRunnerConfig, type ParsedAgentResponse } from './runner'
import { resetWorkspaceDefaults } from '../workspace-defaults'
import { encodeSecurityPolicy } from '../permission-engine'
import { buildBenchPrompt, buildRetryPrompt } from './aider-bench-prompt'

// ---------------------------------------------------------------------------
// Load .env.local from repo root so workers inherit API keys
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
for (const envFile of ['.env.local', '.env']) {
  const envPath = resolve(REPO_ROOT, envFile)
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx)
      const val = trimmed.slice(eqIdx + 1)
      if (!process.env[key]) process.env[key] = val
    }
    break
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

function getArg(name: string, defaultValue?: string): string | undefined {
  const eqArg = args.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=')[1]
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1]
  return defaultValue
}

const modelArg = getArg('model', 'haiku')!
const langArg = getArg('lang', 'python,javascript')!
const workersArg = parseInt(getArg('workers', '1')!)
const filterArg = getArg('filter')
const repoArg = getArg('repo', 'C:\\dev\\polyglot-benchmark')!
const verboseFlag = args.includes('--verbose') || args.includes('-v')

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
}

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  haiku:  { input: 0.0000008, output: 0.000004,  cacheRead: 0.00000008, cacheWrite: 0.000001 },
  sonnet: { input: 0.000003,  output: 0.000015,   cacheRead: 0.0000003,  cacheWrite: 0.00000375 },
}

let nextPort = 7100
const AGENT_RUNTIME_SERVER = resolve(REPO_ROOT, 'packages/agent-runtime/src/server.ts')

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

function detectPython(): string | null {
  const candidates: string[] = []

  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const condaEnvPython = join(home, 'miniconda3', 'envs', 'shogo-bench', 'python.exe')
    const condaBasePython = join(home, 'miniconda3', 'python.exe')
    const anacondaPython = join(home, 'anaconda3', 'python.exe')
    candidates.push(condaEnvPython, condaBasePython, anacondaPython, 'py -3', 'python', 'python3')
  } else {
    candidates.push('python3', 'python')
  }

  for (const cmd of candidates) {
    try {
      const out = execSync(`"${cmd}" --version`, {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      })
      if (out.includes('Python 3')) return cmd
    } catch {}
  }
  return null
}

function detectNode(): boolean {
  try {
    execSync('node --version', { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch { return false }
}

// ---------------------------------------------------------------------------
// Exercise discovery
// ---------------------------------------------------------------------------

interface Exercise {
  id: string
  language: 'python' | 'javascript'
  dir: string
  stubFile: string
  testFile: string
  instructions: string
  extraFiles: string[]
}

function discoverExercises(benchmarkDir: string, languages: string[]): Exercise[] {
  const exercises: Exercise[] = []

  for (const lang of languages) {
    const practiceDir = join(benchmarkDir, lang, 'exercises', 'practice')
    if (!existsSync(practiceDir)) {
      console.warn(`  [warn] No exercises found for ${lang} at ${practiceDir}`)
      continue
    }

    for (const entry of readdirSync(practiceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const exDir = join(practiceDir, entry.name)
      const docsDir = join(exDir, '.docs')
      const instrPath = join(docsDir, 'instructions.md')
      if (!existsSync(instrPath)) continue

      const instructions = readFileSync(instrPath, 'utf-8')

      const files = readdirSync(exDir).filter(f => {
        const s = statSync(join(exDir, f))
        return s.isFile()
      })

      let stubFile: string | undefined
      let testFile: string | undefined
      const extraFiles: string[] = []

      if (lang === 'python') {
        stubFile = files.find(f => f.endsWith('.py') && !f.endsWith('_test.py'))
        testFile = files.find(f => f.endsWith('_test.py'))
      } else {
        stubFile = files.find(f => f.endsWith('.js') && !f.endsWith('.spec.js') && f !== 'babel.config.js')
        testFile = files.find(f => f.endsWith('.spec.js'))
        for (const f of files) {
          if (f === 'package.json' || f === 'babel.config.js' || f === '.npmrc' || f === '.eslintrc') {
            extraFiles.push(f)
          }
        }
      }

      if (!stubFile || !testFile) continue

      exercises.push({
        id: `${lang}/${entry.name}`,
        language: lang as 'python' | 'javascript',
        dir: exDir,
        stubFile,
        testFile,
        instructions,
        extraFiles,
      })
    }
  }

  exercises.sort((a, b) => a.id.localeCompare(b.id))
  return exercises
}

// ---------------------------------------------------------------------------
// Worker management (adapted from run-eval.ts)
// ---------------------------------------------------------------------------

interface Worker {
  id: number
  port: number
  dir: string
  process: Subprocess | null
}

function isPortFree(port: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).Count"`,
        { stdio: 'pipe', encoding: 'utf-8' },
      ).trim()
      return out === '0' || out === ''
    } else {
      execSync(`lsof -ti:${port}`, { stdio: 'pipe' })
      return false
    }
  } catch {
    return true
  }
}

async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isPortFree(port)) return
    await Bun.sleep(1_000)
  }
  console.warn(`  Port ${port} still in use after ${timeoutMs}ms, proceeding anyway`)
}

function findFreePort(): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = nextPort++
    if (isPortFree(port)) return port
  }
  throw new Error('Could not find a free port after 100 attempts')
}

async function startWorker(id: number): Promise<Worker> {
  const port = findFreePort()
  const dir = resolve(tmpdir(), `aider-bench-worker-${id}`)

  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch (e: any) {
    console.warn(`  [Worker ${id}] Cleanup warning: ${e.message}`)
  }
  resetWorkspaceDefaults(dir)

  const proc = spawn({
    cmd: ['bun', 'run', AGENT_RUNTIME_SERVER],
    env: {
      ...process.env,
      PORT: String(port),
      WORKSPACE_DIR: dir,
      AGENT_DIR: dir,
      PROJECT_DIR: dir,
      PROJECT_ID: `aider-bench-worker-${id}`,
      AGENT_MODEL: modelArg,
      SECURITY_POLICY: encodeSecurityPolicy({ mode: 'full_autonomy' }),
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (proc.exitCode !== null) {
    throw new Error(`Worker ${id} exited immediately with code ${proc.exitCode}`)
  }

  const maxWait = 45_000
  const start = Date.now()
  let delay = 500

  while (Date.now() - start < maxWait) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(`http://localhost:${port}/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        console.log(`  Worker ${id} ready on port ${port} (${Date.now() - start}ms)`)
        return { id, port, dir, process: proc }
      }
    } catch {
      if (proc.exitCode !== null) throw new Error(`Worker ${id} died with code ${proc.exitCode}`)
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2_000)
  }

  proc.kill()
  throw new Error(`Worker ${id} failed to start within ${maxWait}ms`)
}

function stopWorker(w: Worker) {
  w.process?.kill()
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Get-NetTCPConnection -LocalPort ${w.port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: 'pipe' })
    } else {
      execSync(`lsof -ti:${w.port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' })
    }
  } catch {}
  try {
    if (existsSync(w.dir)) rmSync(w.dir, { recursive: true, force: true })
  } catch {}
}

// ---------------------------------------------------------------------------
// Workspace prep
// ---------------------------------------------------------------------------

function prepWorkspace(worker: Worker, exercise: Exercise) {
  const safeDirs = ['canvas', 'files', '.shogo/server']
  for (const sub of safeDirs) {
    const p = join(worker.dir, sub)
    try { if (existsSync(p)) rmSync(p, { recursive: true, force: true }) } catch {}
  }
  try {
    for (const entry of readdirSync(worker.dir, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.startsWith('.')) {
        try { rmSync(join(worker.dir, entry.name), { force: true }) } catch {}
      }
    }
  } catch {}
  resetWorkspaceDefaults(worker.dir)

  copyFileSync(join(exercise.dir, exercise.stubFile), join(worker.dir, exercise.stubFile))

  let testContent = readFileSync(join(exercise.dir, exercise.testFile), 'utf-8')
  if (exercise.language === 'javascript') {
    testContent = testContent.replace(/\bxtest\(/g, 'test(')
  }
  writeFileSync(join(worker.dir, exercise.testFile), testContent, 'utf-8')

  mkdirSync(join(worker.dir, '.docs'), { recursive: true })
  writeFileSync(join(worker.dir, '.docs', 'instructions.md'), exercise.instructions, 'utf-8')

  for (const extra of exercise.extraFiles) {
    copyFileSync(join(exercise.dir, extra), join(worker.dir, extra))
  }
}

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

let pythonCmd: string | null = null

function runTests(worker: Worker, exercise: Exercise): { passed: boolean; output: string } {
  let cmd: string
  if (exercise.language === 'python') {
    cmd = `cd "${worker.dir}" && "${pythonCmd}" -m pytest ${exercise.testFile} -x --tb=short 2>&1`
  } else {
    cmd = `cd "${worker.dir}" && npx jest --no-cache 2>&1`
  }

  try {
    const output = execSync(cmd, {
      timeout: 60_000,
      encoding: 'utf-8',
      cwd: worker.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    })
    return { passed: true, output }
  } catch (err: any) {
    const output = (err.stdout || '') + '\n' + (err.stderr || '')
    return { passed: false, output }
  }
}

function npmInstall(worker: Worker) {
  try {
    execSync('npm install --silent 2>&1', {
      cwd: worker.dir,
      timeout: 60_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    })
  } catch (err: any) {
    console.warn(`  [npm install] Warning: ${(err.stderr || err.message || '').slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// Exercise result
// ---------------------------------------------------------------------------

interface ExerciseResult {
  id: string
  language: string
  passed: boolean
  attempt: number
  durationS: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  error?: string
}

// ---------------------------------------------------------------------------
// Run a single exercise
// ---------------------------------------------------------------------------

async function runExercise(
  worker: Worker,
  exercise: Exercise,
  index: number,
  total: number,
): Promise<ExerciseResult> {
  const startTime = Date.now()

  try { Bun.gc(true) } catch {}

  if (verboseFlag) console.log(`      [prep] Setting up workspace for ${exercise.id}...`)
  prepWorkspace(worker, exercise)

  if (exercise.language === 'javascript') {
    if (verboseFlag) console.log(`      [prep] Running npm install...`)
    npmInstall(worker)
  }

  const resolvedModel = MODEL_MAP[modelArg] || modelArg
  const defaultModel = 'claude-sonnet-4-6'
  if (resolvedModel !== defaultModel) {
    try {
      await fetch(`http://localhost:${worker.port}/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: { provider: 'anthropic', name: resolvedModel } }),
      })
    } catch (e: any) {
      console.warn(`      [setup] Model override failed: ${e.message}`)
    }
  }

  try {
    await fetch(`http://localhost:${worker.port}/agent/session/reset`, { method: 'POST' })
  } catch {}

  try {
    await fetch(`http://localhost:${worker.port}/agent/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'none' }),
    })
  } catch {}

  const testCommand = exercise.language === 'python'
    ? `${pythonCmd} -m pytest ${exercise.testFile} -x --tb=short`
    : 'npx jest --no-cache'

  const prompt = buildBenchPrompt({
    language: exercise.language,
    stubFile: exercise.stubFile,
    testFile: exercise.testFile,
    testCommand,
    instructions: exercise.instructions,
  })

  const config: EvalRunnerConfig = {
    agentEndpoint: `http://localhost:${worker.port}/agent/chat`,
    timeoutMs: 300_000,
    verbose: verboseFlag,
    workspaceDir: worker.dir,
  }

  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0

  // Attempt 1
  console.log(`[${index + 1}/${total}] ${exercise.id} — attempt 1...`)
  const messages: Array<{ role: string; parts: Array<{ type: string; text: string }> }> = [
    { role: 'user', parts: [{ type: 'text', text: prompt }] },
  ]

  let resp: ParsedAgentResponse
  try {
    resp = await sendTurn(messages, config)
    totalInput += resp.inputTokens
    totalOutput += resp.outputTokens
    totalCacheRead += resp.cacheReadTokens
    totalCacheWrite += resp.cacheWriteTokens
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR ${exercise.id}: ${err.message}`)
    return {
      id: exercise.id, language: exercise.language, passed: false, attempt: 1,
      durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
      error: err.message,
    }
  }

  if (verboseFlag) console.log(`      [test] Running tests (attempt 1)...`)
  let testResult = runTests(worker, exercise)

  if (testResult.passed) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] PASS ${exercise.id} (attempt 1, ${duration.toFixed(1)}s)`)
    return {
      id: exercise.id, language: exercise.language, passed: true, attempt: 1,
      durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
    }
  }

  // Attempt 2
  console.log(`[${index + 1}/${total}] ${exercise.id} — attempt 2 (tests failed)...`)
  if (verboseFlag) console.log(`      [test] Failure output:\n${testResult.output.slice(0, 500)}`)

  const retryPrompt = buildRetryPrompt(testResult.output)
  messages.push(
    { role: 'assistant', parts: [{ type: 'text', text: resp.text || 'I implemented the solution.' }] },
    { role: 'user', parts: [{ type: 'text', text: retryPrompt }] },
  )

  try {
    const resp2 = await sendTurn(messages, config)
    totalInput += resp2.inputTokens
    totalOutput += resp2.outputTokens
    totalCacheRead += resp2.cacheReadTokens
    totalCacheWrite += resp2.cacheWriteTokens
  } catch (err: any) {
    const duration = (Date.now() - startTime) / 1000
    console.log(`[${index + 1}/${total}] ERROR ${exercise.id} attempt 2: ${err.message}`)
    return {
      id: exercise.id, language: exercise.language, passed: false, attempt: 2,
      durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
      error: err.message,
    }
  }

  if (verboseFlag) console.log(`      [test] Running tests (attempt 2)...`)
  testResult = runTests(worker, exercise)

  const duration = (Date.now() - startTime) / 1000
  const status = testResult.passed ? 'PASS' : 'FAIL'
  const attempt = 2
  console.log(`[${index + 1}/${total}] ${status} ${exercise.id} (attempt ${attempt}, ${duration.toFixed(1)}s)`)

  return {
    id: exercise.id, language: exercise.language, passed: testResult.passed, attempt,
    durationS: duration, inputTokens: totalInput, outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite,
  }
}

// ---------------------------------------------------------------------------
// Cleanup & signal handling
// ---------------------------------------------------------------------------

let globalWorkers: Worker[] = []

function cleanup() {
  console.log('\nCleaning up workers...')
  globalWorkers.forEach(stopWorker)
  globalWorkers = []
}

function crashLog(label: string, err: any) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err?.stack || err?.message || err}\n`
  console.error(msg)
  try { appendFileSync(join(tmpdir(), 'aider-bench-crash.log'), msg) } catch {}
}

process.on('SIGINT',  () => { crashLog('SIGINT', 'interrupted'); cleanup(); process.exit(130) })
process.on('SIGTERM', () => { crashLog('SIGTERM', 'terminated'); cleanup(); process.exit(143) })
process.on('uncaughtException',  (err) => { crashLog('UNCAUGHT EXCEPTION', err); cleanup(); process.exit(1) })
process.on('unhandledRejection', (reason) => { crashLog('UNHANDLED REJECTION', reason); cleanup(); process.exit(1) })
process.on('exit', (code) => { if (code !== 0 && code !== 130 && code !== 143) crashLog('EXIT', `code=${code}`) })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const languages = langArg.split(',').map(l => l.trim()).filter(Boolean)

  console.log('')
  console.log('='.repeat(60))
  console.log('AIDER POLYGLOT BENCHMARK')
  console.log('='.repeat(60))
  console.log(`  Model:     ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers:   ${workersArg}`)
  console.log(`  Languages: ${languages.join(', ')}`)
  console.log(`  Repo:      ${repoArg}`)
  console.log('')

  if (!existsSync(repoArg)) {
    console.error(`Benchmark repo not found at ${repoArg}`)
    console.error('Clone it first: git clone https://github.com/Aider-AI/polyglot-benchmark.git')
    process.exit(1)
  }

  // Detect runtimes and skip unavailable languages
  const availableLangs: string[] = []
  const skippedLangs: string[] = []

  if (languages.includes('python')) {
    pythonCmd = detectPython()
    if (pythonCmd) {
      console.log(`  Python:    ${pythonCmd} ✓`)
      availableLangs.push('python')
    } else {
      console.log(`  Python:    NOT FOUND — skipping Python exercises`)
      console.log(`             Install Python 3.10+ and pytest, or set PATH`)
      skippedLangs.push('python')
    }
  }
  if (languages.includes('javascript')) {
    if (detectNode()) {
      console.log(`  Node.js:   ✓`)
      availableLangs.push('javascript')
    } else {
      console.log(`  Node.js:   NOT FOUND — skipping JavaScript exercises`)
      skippedLangs.push('javascript')
    }
  }
  console.log('')

  if (availableLangs.length === 0) {
    console.error('No runtimes available for the selected languages.')
    process.exit(1)
  }

  let exercises = discoverExercises(repoArg, availableLangs)
  if (filterArg) {
    const f = filterArg.toLowerCase()
    exercises = exercises.filter(e => e.id.toLowerCase().includes(f))
  }

  console.log(`  Exercises: ${exercises.length}`)
  for (const lang of availableLangs) {
    const count = exercises.filter(e => e.language === lang).length
    console.log(`    ${lang}: ${count}`)
  }
  if (skippedLangs.length > 0) {
    console.log(`  Skipped:   ${skippedLangs.join(', ')} (runtime not found)`)
  }
  console.log('')

  if (exercises.length === 0) {
    console.log('No exercises found')
    process.exit(1)
  }

  // Start workers
  const numWorkers = Math.min(workersArg, exercises.length)
  console.log(`Starting ${numWorkers} worker(s)...`)
  const workers: Worker[] = []
  try {
    for (let i = 0; i < numWorkers; i++) {
      const w = await startWorker(i)
      workers.push(w)
      globalWorkers.push(w)
      if (i < numWorkers - 1) await Bun.sleep(1_000)
    }
  } catch (err: any) {
    console.error(`Failed to start workers: ${err.message}`)
    cleanup()
    process.exit(1)
  }

  console.log('')
  console.log('Running benchmark...')
  console.log('-'.repeat(60))

  const overallStart = Date.now()
  const results: ExerciseResult[] = new Array(exercises.length)
  const partialPath = resolve(tmpdir(), `aider-bench-partial-${modelArg}-${Date.now()}.json`)

  let nextIndex = 0
  let completed = 0

  function savePartial() {
    try {
      const partial = results.filter(Boolean)
      writeFileSync(partialPath, JSON.stringify(partial, null, 2))
    } catch {}
  }

  async function restartWorker(worker: Worker, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        stopWorker(worker)
        await waitForPort(worker.port)
        const fresh = await startWorker(worker.id)
        Object.assign(worker, fresh)
        globalWorkers = globalWorkers.map(w => w.id === worker.id ? worker : w)
        return
      } catch (err: any) {
        console.warn(`  [worker ${worker.id}] Restart attempt ${attempt}/${maxRetries} failed: ${err.message}`)
        if (attempt === maxRetries) throw err
        await Bun.sleep(3_000 * attempt)
      }
    }
  }

  async function workerLoop(worker: Worker, isFirst: boolean) {
    while (true) {
      const idx = nextIndex++
      if (idx >= exercises.length) break

      const exercise = exercises[idx]

      if (!isFirst) {
        if (verboseFlag) console.log(`  [worker ${worker.id}] Restarting for ${exercise.id}...`)
        try {
          await restartWorker(worker)
        } catch (err: any) {
          console.error(`  [worker ${worker.id}] Failed to restart after retries: ${err.message}`)
          results[idx] = {
            id: exercise.id, language: exercise.language, passed: false, attempt: 0,
            durationS: 0, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            error: `Worker restart failed: ${err.message}`,
          }
          completed++
          savePartial()
          continue
        }
      }
      isFirst = false

      try {
        const result = await runExercise(worker, exercise, idx, exercises.length)
        results[idx] = result
        completed++
        savePartial()
      } catch (err: any) {
        console.error(`[${idx + 1}/${exercises.length}] CRASH ${exercise.id}: ${err.message}`)
        results[idx] = {
          id: exercise.id, language: exercise.language, passed: false, attempt: 0,
          durationS: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          error: err.message,
        }
        completed++
        savePartial()
      }
    }
  }

  await Promise.all(workers.map(w => workerLoop(w, true)))

  const totalTime = (Date.now() - overallStart) / 1000

  // Stop workers
  console.log('')
  console.log('Stopping workers...')
  cleanup()

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const finalResults = results.filter(Boolean)
  const passed = finalResults.filter(r => r.passed).length
  const failed = finalResults.filter(r => !r.passed).length
  const firstAttempt = finalResults.filter(r => r.passed && r.attempt === 1).length
  const secondAttempt = finalResults.filter(r => r.passed && r.attempt === 2).length

  const totalInput = finalResults.reduce((s, r) => s + r.inputTokens, 0)
  const totalOutput = finalResults.reduce((s, r) => s + r.outputTokens, 0)
  const totalCacheRead = finalResults.reduce((s, r) => s + r.cacheReadTokens, 0)
  const totalCacheWrite = finalResults.reduce((s, r) => s + r.cacheWriteTokens, 0)
  const pricing = PRICING[modelArg] || PRICING.haiku
  const totalCost =
    totalInput * pricing.input +
    totalOutput * pricing.output +
    totalCacheRead * pricing.cacheRead +
    totalCacheWrite * pricing.cacheWrite

  const byLanguage: Record<string, { total: number; passed: number; passRate: string }> = {}
  for (const lang of availableLangs) {
    const langResults = finalResults.filter(r => r.language === lang)
    const langPassed = langResults.filter(r => r.passed).length
    byLanguage[lang] = {
      total: langResults.length,
      passed: langPassed,
      passRate: langResults.length > 0 ? (langPassed / langResults.length * 100).toFixed(1) + '%' : '0%',
    }
  }

  console.log('')
  console.log('='.repeat(60))
  console.log('AIDER POLYGLOT BENCHMARK RESULTS')
  console.log('='.repeat(60))
  console.log(`  Model:        ${MODEL_MAP[modelArg] || modelArg}`)
  console.log(`  Workers:      ${numWorkers}`)
  console.log(`  Total:        ${finalResults.length}`)
  console.log(`  Passed:       ${passed} (${(passed / finalResults.length * 100).toFixed(1)}%)`)
  console.log(`  Failed:       ${failed}`)
  console.log(`  1st attempt:  ${firstAttempt}`)
  console.log(`  2nd attempt:  ${secondAttempt}`)
  console.log('')

  console.log('BY LANGUAGE')
  console.log('-'.repeat(40))
  for (const [lang, stats] of Object.entries(byLanguage)) {
    console.log(`  ${lang}: ${stats.passed}/${stats.total} (${stats.passRate})`)
  }
  console.log('')

  console.log('COST')
  console.log('-'.repeat(40))
  console.log(`  Input tokens:       ${totalInput.toLocaleString()}`)
  console.log(`  Output tokens:      ${totalOutput.toLocaleString()}`)
  console.log(`  Cache read tokens:  ${totalCacheRead.toLocaleString()}`)
  console.log(`  Cache write tokens: ${totalCacheWrite.toLocaleString()}`)
  console.log(`  Total cost:         $${totalCost.toFixed(4)}`)
  console.log(`  Cost/exercise:      $${(totalCost / finalResults.length).toFixed(4)}`)
  console.log(`  Duration:           ${totalTime.toFixed(1)}s`)
  console.log('')

  // Failed exercises
  const failures = finalResults.filter(r => !r.passed)
  if (failures.length > 0) {
    console.log('FAILED EXERCISES')
    console.log('-'.repeat(40))
    for (const f of failures) {
      console.log(`  ${f.id}${f.error ? ` — ${f.error.slice(0, 80)}` : ''}`)
    }
    console.log('')
  }

  // Save results JSON
  const output = {
    benchmark: 'aider-polyglot',
    model: MODEL_MAP[modelArg] || modelArg,
    languages: availableLangs,
    timestamp: new Date().toISOString(),
    results: finalResults,
    summary: {
      total: finalResults.length,
      passed,
      passRate: (passed / results.length * 100).toFixed(1) + '%',
      byLanguage,
      attemptBreakdown: { firstAttempt, secondAttempt },
      totalCost: '$' + totalCost.toFixed(2),
      totalDurationS: Math.round(totalTime),
    },
  }

  const outPath = resolve(
    tmpdir(),
    `aider-bench-results-${modelArg}-${Date.now()}.json`,
  )
  writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`Results saved to: ${outPath}`)

  // Clean up partial file
  try { if (existsSync(partialPath)) rmSync(partialPath) } catch {}
}

main().catch(err => {
  crashLog('MAIN', err)
  cleanup()
  process.exit(1)
})
