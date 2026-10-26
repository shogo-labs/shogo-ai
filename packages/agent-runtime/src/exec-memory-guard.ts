// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Process-wide registry of live `exec` shells, and the memory budget for them.
 *
 * The runtime manager's memory ceiling exists to catch leaks in the runtime's
 * own processes (vite, the preview server, language servers). Commands the
 * agent runs are the user's workload — a game engine, a test suite, a Docker
 * build — and restarting the runtime because of them kills the turn. So:
 *
 *   - the PIDs of live exec shells are published to SHOGO_EXEC_PIDS_FILE,
 *     and the manager's watchdog leaves those process trees out of its sum;
 *   - this guard enforces the command budget on those trees instead. On a
 *     sustained breach it stops the largest command and leaves a note in its
 *     output, so the agent sees why in the tool result or `[Task update]`.
 *
 * The budget comes from `SHOGO_EXEC_MEMORY_MB` when it is set explicitly, and
 * otherwise from the desktop's `host-limits.json` (SHOGO_HOST_LIMITS_FILE),
 * which is re-read on every sample so a Settings change lands on a command that
 * is already running (SHO-203).
 */

import { execFile } from '@shogo/shared-runtime/child-process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface TrackedExec {
  pid: number
  /** Stop the command's whole process tree, appending `note` to its output. */
  killForMemory: (note: string) => void
}

/** What the budget was read from, so the OOM note can name the right fix. */
export type ExecBudgetSource = 'env' | 'settings'

export interface ExecBudget {
  /** MB the agent's commands may use. 0 = no limit configured. */
  mb: number
  source: ExecBudgetSource
  /** Total physical RAM in MB, when the limits file reports it. */
  totalMemMB?: number
}

/** `host-limits.json`, as published by the desktop app (SHO-203). */
interface HostLimitsFile {
  execMemoryMB?: number
  totalMemMB?: number
}

const tracked = new Map<number, TrackedExec>()
let timer: ReturnType<typeof setInterval> | null = null
let sampling = false
let strikes = 0

/**
 * The limits file, cached by mtime: one `stat` per sample instead of a read of
 * a file that changes only when the user moves the setting.
 */
let cachedLimits: { path: string; mtimeMs: number; value: HostLimitsFile | null } | null = null

function readHostLimits(path: string): HostLimitsFile | null {
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (cachedLimits?.path === path && cachedLimits.mtimeMs === mtimeMs) return cachedLimits.value
    let value: HostLimitsFile | null = null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as HostLimitsFile
      value = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      value = null
    }
    cachedLimits = { path, mtimeMs, value }
    return value
  } catch {
    cachedLimits = null
    return null
  }
}

/**
 * The budget for the commands the agent runs.
 *
 * An explicit `SHOGO_EXEC_MEMORY_MB` wins (headless worker, tests) and names
 * itself in the OOM note. Otherwise the desktop's `host-limits.json` does, and
 * because it is read on every sample, changing the setting applies to a command
 * that is already running — the app and runtime never restart (SHO-203).
 */
export function execBudget(): ExecBudget {
  const envMB = parseInt(process.env.SHOGO_EXEC_MEMORY_MB || '', 10)
  if (Number.isFinite(envMB) && envMB > 0) return { mb: envMB, source: 'env' }

  const file = process.env.SHOGO_HOST_LIMITS_FILE
  if (!file) return { mb: 0, source: 'settings' }
  const limits = readHostLimits(file)
  const mb = limits?.execMemoryMB
  if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return { mb: 0, source: 'settings' }
  const totalMemMB = limits?.totalMemMB
  return {
    mb: Math.floor(mb),
    source: 'settings',
    totalMemMB: typeof totalMemMB === 'number' && totalMemMB > 0 ? Math.floor(totalMemMB) : undefined,
  }
}

function budgetMB(): number {
  return execBudget().mb
}

/** True when a budget could exist now or appear later (env or watched file). */
function hasBudgetSource(): boolean {
  return budgetMB() > 0 || !!process.env.SHOGO_HOST_LIMITS_FILE
}

function intervalMs(): number {
  const ms = parseInt(process.env.SHOGO_EXEC_MEMORY_SAMPLE_MS || '15000', 10)
  return Math.max(2000, Number.isFinite(ms) ? ms : 15000)
}

function strikesRequired(): number {
  const n = parseInt(process.env.SHOGO_EXEC_MEMORY_STRIKES || '2', 10)
  return Number.isFinite(n) && n > 0 ? n : 2
}

/** Start tracking an exec shell. Returns an idempotent untrack function. */
export function trackExecProcess(entry: TrackedExec): () => void {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return () => {}
  tracked.set(entry.pid, entry)
  publishPids()
  ensureTimer()
  let done = false
  return () => {
    if (done) return
    done = true
    if (tracked.get(entry.pid) === entry) tracked.delete(entry.pid)
    publishPids()
    if (tracked.size === 0) stopTimer()
  }
}

/** PIDs of the exec shells currently tracked. For tests and diagnostics. */
export function trackedExecPids(): number[] {
  return [...tracked.keys()]
}

function publishPids(): void {
  const file = process.env.SHOGO_EXEC_PIDS_FILE
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pids: [...tracked.keys()] }))
    renameSync(tmp, file)
  } catch {
    // The watchdog then counts these trees again; never fail an exec over it.
  }
}

function ensureTimer(): void {
  // Not `budgetMB() > 0`: with a limits file the budget may only appear after
  // the command is already running (the user moves the setting), and that
  // change has to land on it.
  if (timer || !hasBudgetSource()) return
  timer = setInterval(() => { void sampleOnce() }, intervalMs())
  try { (timer as any).unref?.() } catch { /* unref is best-effort */ }
}

function stopTimer(): void {
  if (timer) clearInterval(timer)
  timer = null
  strikes = 0
}

/**
 * Take one sample and act on it. Exported so tests can drive the guard
 * without waiting on the interval.
 */
export async function sampleOnce(
  sample: (roots: number[]) => Promise<Map<number, number>> = sampleTreeRssKb,
): Promise<void> {
  const budget = execBudget()
  const ceilingMB = budget.mb
  if (sampling || ceilingMB <= 0 || tracked.size === 0) return
  sampling = true
  try {
    const sizes = await sample([...tracked.keys()])
    let totalKb = 0
    let largestPid = 0
    let largestKb = -1
    for (const [pid, kb] of sizes) {
      if (!tracked.has(pid)) continue
      totalKb += kb
      if (kb > largestKb) { largestKb = kb; largestPid = pid }
    }
    const totalMB = Math.floor(totalKb / 1024)
    if (totalMB <= ceilingMB || !largestPid) { strikes = 0; return }
    strikes += 1
    console.warn(
      `[exec-memory-guard] agent commands using ${totalMB}MB, over ${ceilingMB}MB ` +
        `(strike ${strikes}/${strikesRequired()})`,
    )
    if (strikes < strikesRequired()) return
    strikes = 0
    const victim = tracked.get(largestPid)
    if (!victim) return
    tracked.delete(largestPid)
    publishPids()
    const note = memoryKillNote(Math.floor(largestKb / 1024), totalMB, ceilingMB, budget)
    console.warn(`[exec-memory-guard] stopping pid ${largestPid}: ${note}`)
    try { victim.killForMemory(note) } catch { /* already gone */ }
    if (tracked.size === 0) stopTimer()
  } catch {
    strikes = 0
  } finally {
    sampling = false
  }
}

/** Where the ceiling came from, and the host it belongs to. */
export interface MemoryLimitOrigin {
  source?: ExecBudgetSource
  /** Total physical RAM in MB, when known — so the note can name the machine. */
  totalMemMB?: number
}

export function memoryKillNote(
  commandMB: number,
  totalMB: number,
  ceilingMB: number,
  origin: MemoryLimitOrigin = {},
): string {
  const several = totalMB > commandMB
  const fromEnv = origin.source === 'env'
  const ram = origin.totalMemMB ? `; this computer has ${formatMB(origin.totalMemMB)}` : ''
  const where = fromEnv
    ? `for agent commands on this computer (SHOGO_EXEC_MEMORY_MB)${ram}`
    : `for agent commands on this computer (set in Settings → Computer and files → ` +
      `Memory for agent commands${ram})`
  const fix = fromEnv
    ? 'Raise SHOGO_EXEC_MEMORY_MB where it is set, restart the runtime, then retry the command.'
    : 'Ask the user to raise it there — it applies right away, with no restart — then retry the command.'
  return (
    `[shogo] Stopped: out of memory. This command's processes were using ${formatMB(commandMB)}` +
    (several ? ` (${formatMB(totalMB)} across all running commands)` : '') +
    `, over the ${formatMB(ceilingMB)} limit ${where}. ` +
    (several ? 'Run fewer or lighter processes at once. ' : '') +
    fix
  )
}

function formatMB(mb: number): string {
  if (mb < 1024) return `${mb} MB`
  const gb = mb / 1024
  // Whole hundreds of gigabytes read better without the `.0` ("128 GB", not
  // "128.0 GB"); everything smaller keeps a decimal for the precision.
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}

/**
 * Resident memory (KB) of each root's process tree, in one OS query.
 *
 *   - Windows: working set of the root plus descendants, by ParentProcessId.
 *   - POSIX: RSS summed by process group; exec shells are spawned detached,
 *     so each one leads a group holding its whole command.
 */
export async function sampleTreeRssKb(roots: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (roots.length === 0) return out
  if (process.platform === 'win32') {
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `$kids=@{};$ws=@{};` +
      `foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize){` +
      `$id="$($p.ProcessId)";$ws[$id]=[int64]$p.WorkingSetSize;$k="$($p.ParentProcessId)";` +
      `if(-not $kids.ContainsKey($k)){$kids[$k]=New-Object System.Collections.ArrayList};[void]$kids[$k].Add($id)};` +
      `foreach($r in @(${roots.join(',')})){$sum=[int64]0;$seen=@{};$st=New-Object System.Collections.Stack;$st.Push("$r");` +
      `while($st.Count -gt 0){$id=$st.Pop();if($seen.ContainsKey($id)){continue};$seen[$id]=$true;` +
      `if($ws.ContainsKey($id)){$sum+=$ws[$id]};if($kids.ContainsKey($id)){foreach($c in $kids[$id]){$st.Push($c)}}};` +
      `"$r $([math]::Floor($sum/1024))"}`
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, kb] = line.trim().split(/\s+/).map((v) => parseInt(v, 10))
      if (Number.isFinite(pid) && Number.isFinite(kb)) out.set(pid!, kb!)
    }
    return out
  }
  const wanted = new Set(roots)
  const stdout = await run('ps', ['-A', '-o', 'pgid=,rss='])
  for (const line of stdout.split('\n')) {
    const [pgid, rss] = line.trim().split(/\s+/).map((v) => parseInt(v, 10))
    if (!Number.isFinite(pgid) || !Number.isFinite(rss) || !wanted.has(pgid!)) continue
    out.set(pgid!, (out.get(pgid!) ?? 0) + rss!)
  }
  return out
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf-8', timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}
