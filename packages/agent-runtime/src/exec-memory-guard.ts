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
 *   - this guard enforces SHOGO_EXEC_MEMORY_MB on those trees instead. On a
 *     sustained breach it stops the largest command and leaves a note in its
 *     output, so the agent sees why in the tool result or `[Task update]`.
 */

import { execFile } from '@shogo/shared-runtime/child-process'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface TrackedExec {
  pid: number
  /** Stop the command's whole process tree, appending `note` to its output. */
  killForMemory: (note: string) => void
}

const tracked = new Map<number, TrackedExec>()
let timer: ReturnType<typeof setInterval> | null = null
let sampling = false
let strikes = 0

function budgetMB(): number {
  const mb = parseInt(process.env.SHOGO_EXEC_MEMORY_MB || '', 10)
  return Number.isFinite(mb) && mb > 0 ? mb : 0
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
  if (timer || budgetMB() <= 0) return
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
  const ceilingMB = budgetMB()
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
    const note = memoryKillNote(Math.floor(largestKb / 1024), totalMB, ceilingMB)
    console.warn(`[exec-memory-guard] stopping pid ${largestPid}: ${note}`)
    try { victim.killForMemory(note) } catch { /* already gone */ }
    if (tracked.size === 0) stopTimer()
  } catch {
    strikes = 0
  } finally {
    sampling = false
  }
}

export function memoryKillNote(commandMB: number, totalMB: number, ceilingMB: number): string {
  return (
    `[shogo] Stopped: out of memory. This command's processes were using ${formatMB(commandMB)}` +
    (totalMB > commandMB ? ` (${formatMB(totalMB)} across all running commands)` : '') +
    `, over the ${formatMB(ceilingMB)} limit for this project's commands. ` +
    'Run fewer or lighter processes at once. If the workload really needs more memory, tell the user: ' +
    'on Shogo desktop the limit is hostRuntime.memoryMB in config.json.'
  )
}

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
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
