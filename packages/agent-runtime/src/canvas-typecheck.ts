// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasTypecheckGate — runs `tsc --noEmit` after a successful Vite/Expo
 * build and surfaces any type errors that the bundler ignored.
 *
 * Why this exists
 * ---------------
 * Vite/Expo builds go through esbuild, which **transpiles without
 * type-checking**. A boolean rendered as a component (`<row.icon/>` where
 * `icon: true`), a missing import (`Tabs is not defined`), or any other type
 * error compiles clean and then throws at render time in the browser. In
 * production this is the dominant source of the auto-generated
 * "Debug: runtime error" chats: the build log says `built in N ms`, the
 * agent reports success, and the user is the first to see the crash.
 *
 * This gate closes that hole. After each build completes it runs the
 * project's own `tsc --noEmit` (honoring its tsconfig) and, when errors are
 * found, does three things:
 *
 *   1. Writes a compact summary into `.shogo/logs/build.log` — right where
 *      the agent habitually looks (`tail -5 .shogo/logs/build.log`). A green
 *      `built in N ms` is now followed by `✗ tsc --noEmit: N type error(s)`.
 *   2. Pushes a `phase: 'compile'` entry into the canvas runtime-error ring
 *      buffer so `read_lints` and the next `write_file`/`edit_file` result
 *      surface it in-band — the same channel that eventually caught the
 *      boolean bug, but now *before* the browser renders.
 *   3. Emits the `canvas_typecheck_blocked` SLO signal (see `canvas-slo.ts`).
 *
 * It is intentionally NOT a hard build gate: the previous `dist/` keeps
 * serving and the reload still fires. Blocking the build on a type error
 * would strand users mid-iteration (many transient states don't typecheck).
 * The goal is to make the error *impossible to miss*, not to stop the build.
 *
 * Cost control: single-flight (a run in progress coalesces later triggers),
 * debounced off the build-complete signal, and hard-capped on wall time.
 * Only runs when both `tsconfig.json` and a `tsc` bin are present, so
 * non-TS / marker-less workspaces skip it entirely.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { resolveBinInvocation } from '@shogo/shared-runtime'
import { pushCanvasRuntimeError } from './canvas-runtime-errors'
import { previewBuildLogPath, ensureRuntimeLogDir } from './runtime-log-paths'
import { scheduleLogWrite } from './runtime-log-writer'
import { recordBuildEntry } from './runtime-log-dispatcher'
import { classifyCanvasError, recordCanvasTypecheckBlocked } from './canvas-slo'

export interface TypecheckError {
  file: string
  line: number
  col: number
  code: string
  message: string
}

const LOG_PREFIX = '[CanvasTypecheckGate]'
const BUILD_LOG_TAG = '[typecheck]'

/** Debounce between the build-complete signal and the actual tsc run. */
const DEFAULT_DEBOUNCE_MS = 800
/** Hard ceiling on a single tsc run so a pathological project can't hang. */
const DEFAULT_TIMEOUT_MS = 60_000
/** Max individual error lines echoed into build.log / the in-band surface. */
const MAX_REPORTED_ERRORS = 10

/**
 * Parse `tsc --noEmit --pretty false` stdout into structured errors.
 *
 * Header lines look like:
 *   src/App.tsx(37,18): error TS2604: JSX element type ... has no ...
 * Continuation lines (indented elaboration of a preceding error) don't match
 * the pattern and are ignored — we only count/report the header of each
 * diagnostic. Exported for unit testing.
 */
export function parseTscOutput(output: string): TypecheckError[] {
  const errors: TypecheckError[] = []
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/
  for (const raw of output.split(/\r?\n/)) {
    const m = re.exec(raw.trim())
    if (!m) continue
    errors.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5],
    })
  }
  return errors
}

export interface CanvasTypecheckGateOptions {
  debounceMs?: number
  timeoutMs?: number
  /**
   * Injectable spawn for tests. Must resolve with the combined tsc output and
   * exit code. Defaults to spawning the workspace's real `tsc` bin.
   */
  runTypecheck?: (workspaceDir: string, timeoutMs: number) => Promise<{ output: string; code: number | null }>
}

export class CanvasTypecheckGate {
  private workspaceDir: string
  private debounceMs: number
  private timeoutMs: number
  private runTypecheck: (workspaceDir: string, timeoutMs: number) => Promise<{ output: string; code: number | null }>

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private pending = false
  /** True when the previous run reported errors — used to emit a single
   *  "clean" confirmation line only on the dirty→clean transition so the
   *  happy path stays quiet in build.log. */
  private lastHadErrors = false

  constructor(workspaceDir: string, opts: CanvasTypecheckGateOptions = {}) {
    this.workspaceDir = workspaceDir
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.runTypecheck = opts.runTypecheck ?? defaultRunTypecheck
  }

  /** Debounced entry point — call after each successful build. */
  trigger(): void {
    if (!this.isApplicable()) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.run()
    }, this.debounceMs)
  }

  /** Only run for TS workspaces that actually have a tsc to invoke. */
  private isApplicable(): boolean {
    if (!existsSync(join(this.workspaceDir, 'tsconfig.json'))) return false
    return resolveTscInvocation(this.workspaceDir) !== null
  }

  /**
   * Run tsc now (bypasses the debounce). Single-flight: if a run is already
   * in flight, mark a follow-up and return — the follow-up fires once the
   * current run settles so we always end on the latest source state.
   */
  async run(): Promise<void> {
    if (this.running) {
      this.pending = true
      return
    }
    this.running = true
    try {
      const { output, code } = await this.runTypecheck(this.workspaceDir, this.timeoutMs)
      // tsc exits 0 with no diagnostics; non-zero with diagnostics. Parse
      // regardless of code so a tsc that also printed a config warning still
      // yields the real errors.
      const errors = parseTscOutput(output)

      if (errors.length === 0) {
        // Only announce clean-ness if we were previously dirty, so we don't
        // spam build.log on every keystroke-driven rebuild.
        if (this.lastHadErrors) {
          this.emitBuildLine(`${BUILD_LOG_TAG} ✓ tsc --noEmit clean`, 'stdout')
        }
        this.lastHadErrors = false
        // A non-zero exit with no parseable errors usually means tsc itself
        // failed to start (bad tsconfig, OOM). Surface it once, quietly.
        if (code !== 0 && output.trim()) {
          this.emitBuildLine(`${BUILD_LOG_TAG} tsc exited ${code} (no diagnostics parsed)`, 'stdout')
        }
        return
      }

      this.lastHadErrors = true
      this.report(errors)
    } catch (err: any) {
      // Never let a typecheck failure affect the build/reload path.
      console.warn(`${LOG_PREFIX} typecheck run failed (non-fatal): ${err?.message ?? err}`)
    } finally {
      this.running = false
      if (this.pending) {
        this.pending = false
        void this.run()
      }
    }
  }

  /** Surface the errors to build.log, the in-band error buffer, and the SLO. */
  private report(errors: TypecheckError[]): void {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS)
    const lines = shown.map((e) => `${e.file}(${e.line},${e.col}): ${e.code} ${e.message}`)

    // 1) build.log — where the agent looks. Mark as 'stderr' so the unseen-
    //    error indicator lights up, matching how real build failures render.
    this.emitBuildLine(
      `${BUILD_LOG_TAG} ✗ tsc --noEmit found ${errors.length} type error(s) — these compile under Vite but will crash at runtime:`,
      'stderr',
    )
    for (const line of lines) this.emitBuildLine(`${BUILD_LOG_TAG}   ${line}`, 'stderr')
    if (errors.length > shown.length) {
      this.emitBuildLine(`${BUILD_LOG_TAG}   …and ${errors.length - shown.length} more`, 'stderr')
    }

    // 2) In-band canvas error buffer (read_lints + next write/edit result).
    const summary = [
      `tsc --noEmit found ${errors.length} type error(s) that Vite transpiled anyway (these will throw at runtime):`,
      ...lines,
      errors.length > shown.length ? `…and ${errors.length - shown.length} more` : '',
    ]
      .filter(Boolean)
      .join('\n')
    pushCanvasRuntimeError({ phase: 'compile', error: summary, timestamp: Date.now() })

    // 3) SLO signal — escapes prevented.
    recordCanvasTypecheckBlocked({
      errorCount: errors.length,
      sampleCodes: shown.map((e) => e.code),
      sampleClasses: shown.map((e) => classifyCanvasError(e.message)),
    })

    console.warn(`${LOG_PREFIX} ${errors.length} type error(s) surfaced (Vite build was green)`)
  }

  private emitBuildLine(line: string, stream: 'stdout' | 'stderr'): void {
    try {
      const buildLogPath = previewBuildLogPath(this.workspaceDir)
      ensureRuntimeLogDir(this.workspaceDir)
      scheduleLogWrite(buildLogPath, `${line}\n`)
      recordBuildEntry(line, stream === 'stderr' ? 'error' : 'info')
    } catch {
      /* best-effort logging */
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}

/**
 * Resolve how to invoke the workspace's `tsc`. Returns null when no tsc bin
 * is installed (so the gate no-ops rather than shelling out to a global).
 */
function resolveTscInvocation(workspaceDir: string): { cmd: string; argsPrefix: string[] } | null {
  const isWindows = process.platform === 'win32'
  const binDir = join(workspaceDir, 'node_modules', '.bin')
  const candidates = isWindows
    ? [join(binDir, 'tsc.CMD'), join(binDir, 'tsc.cmd'), join(binDir, 'tsc.exe')]
    : [join(binDir, 'tsc')]
  const bin = candidates.find((p) => existsSync(p))
  if (!bin) return null
  return resolveBinInvocation(workspaceDir, 'tsc') ?? { cmd: bin, argsPrefix: [] }
}

/** Default tsc runner — spawns the real bin and collects stdout+stderr. */
async function defaultRunTypecheck(
  workspaceDir: string,
  timeoutMs: number,
): Promise<{ output: string; code: number | null }> {
  const invocation = resolveTscInvocation(workspaceDir)
  if (!invocation) return { output: '', code: 0 }

  const isWindows = process.platform === 'win32'
  return await new Promise((resolve) => {
    let settled = false
    let proc: ChildProcess
    try {
      proc = spawn(
        isWindows ? `"${invocation.cmd}"` : invocation.cmd,
        [...invocation.argsPrefix, '--noEmit', '--pretty', 'false'],
        {
          cwd: workspaceDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: isWindows,
          env: { ...process.env, NODE_ENV: 'development' },
        },
      )
    } catch (err: any) {
      resolve({ output: String(err?.message ?? err), code: 1 })
      return
    }

    let out = ''
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    proc.stderr?.on('data', (c: Buffer) => { out += c.toString() })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      resolve({ output: out, code: null })
    }, timeoutMs)

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ output: out, code })
    })
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ output: out, code: 1 })
    })
  })
}
