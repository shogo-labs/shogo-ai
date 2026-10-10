// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whole-tree memory sampler for the desktop app.
 *
 * Electron processes come from `app.getAppMetrics()` (`workingSetSize` —
 * `privateBytes` is Windows-only and reads 0 on macOS and Linux). Everything
 * else is a `ps` process-group sample, labeled by command line.
 *
 *   bun scripts/bench/memory-report-cli.ts --pid <api-pid> --label launch-idle
 *
 * The Playwright spec in `apps/desktop/e2e/memory-budget.spec.ts` imports
 * the pure helpers and fills in Electron metrics itself.
 */
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { hostname, platform, totalmem } from 'os'
import { join } from 'path'

export type ProcessRole =
  | 'api'
  | 'agent-runtime'
  | 'tsserver'
  | 'vite'
  | 'project-server'
  | 'code-oss'
  | 'mcp'
  | 'chromium'
  | 'electron'
  | 'other'

export interface ProcessSample {
  pid: number
  ppid: number
  rssKb: number
  command: string
  role: ProcessRole
}

export interface ElectronProcessSample {
  pid: number
  type: string
  serviceName?: string
  workingSetKb: number
}

export interface Checkpoint {
  name: string
  at: string
  electronMb: number
  otherMb: number
  totalMb: number
  webContents?: number
  rendererHeapMb?: number
  rolesMb: Partial<Record<ProcessRole, number>>
  electronByTypeMb: Record<string, number>
  footprintMb?: number
}

export interface MemoryBudgets {
  idleTotalMb: number
  projectOpenTotalMb: number
  /** Max growth from project-open to the settled idle checkpoint. */
  idleGrowthPct: number
  /** After a leak cycle, memory must return to within this percent of baseline. */
  leakReturnPct: number
  apiMb: number
}

/** Starting budgets from the 2026-09-21 8 GB-tier report. Tighten as fixes land. */
export const MEMORY_BUDGETS: MemoryBudgets = {
  idleTotalMb: 1200,
  projectOpenTotalMb: 2500,
  idleGrowthPct: 10,
  leakReturnPct: 5,
  apiMb: 350,
}

/** Entry `index-*.js` plus the shared `__common-*.js` Metro emits with async routes. */
export const MAIN_WEB_CHUNK_BUDGET_BYTES = 2_500_000 + 12_000_000

export function classifyCommand(command: string): ProcessRole {
  const c = command.toLowerCase()
  if (/electron|shogo helper|shogo\.app/.test(c) && !/agent-runtime|apps\/api/.test(c)) return 'electron'
  if (/tsserver|typescript[\\/]+lib[\\/]+tsc/.test(c)) return 'tsserver'
  if (/code-oss|shogo-ide[\\/]|vscode-server/.test(c)) return 'code-oss'
  if (/mcp|computer-use-mcp|modelcontextprotocol/.test(c)) return 'mcp'
  if (/playwright|ms-playwright|chromium/.test(c) && !/electron/.test(c)) return 'chromium'
  if (/agent-runtime/.test(c)) return 'agent-runtime'
  if (/\bvite\b|vite[\\/]+bin/.test(c)) return 'vite'
  if (/apps[\\/]+api|bundle[\\/]+api\.js|local-server|src[\\/]+entry\.ts/.test(c)) return 'api'
  if (/server\.tsx|preview-manager|bun run server/.test(c)) return 'project-server'
  return 'other'
}

/** Parse `ps -ax -o pid=,ppid=,rss=,command=` (whitespace-padded columns). */
export function parsePs(text: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\s\S]+)$/)
    if (!match) continue
    const command = match[4].trim()
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command,
      role: classifyCommand(command),
    })
  }
  return samples
}

export function kbToMb(kb: number): number {
  return Math.round((kb / 1024) * 10) / 10
}

export function rolesMb(samples: ProcessSample[]): Partial<Record<ProcessRole, number>> {
  const totalsKb: Partial<Record<ProcessRole, number>> = {}
  for (const sample of samples) {
    totalsKb[sample.role] = (totalsKb[sample.role] ?? 0) + sample.rssKb
  }
  const out: Partial<Record<ProcessRole, number>> = {}
  for (const [role, kb] of Object.entries(totalsKb)) {
    out[role as ProcessRole] = kbToMb(kb ?? 0)
  }
  return out
}

export function electronMb(metrics: ElectronProcessSample[]): {
  totalMb: number
  byTypeMb: Record<string, number>
} {
  const byTypeKb: Record<string, number> = {}
  let totalKb = 0
  for (const metric of metrics) {
    const key = metric.serviceName ? `${metric.type}:${metric.serviceName}` : metric.type
    byTypeKb[key] = (byTypeKb[key] ?? 0) + metric.workingSetKb
    totalKb += metric.workingSetKb
  }
  const byTypeMb: Record<string, number> = {}
  for (const [key, kb] of Object.entries(byTypeKb)) byTypeMb[key] = kbToMb(kb)
  return { totalMb: kbToMb(totalKb), byTypeMb }
}

export function growthPercent(fromMb: number, toMb: number): number {
  if (!Number.isFinite(fromMb) || fromMb <= 0) return 0
  return Math.round(((toMb - fromMb) / fromMb) * 1000) / 10
}

export function withinLeakBudget(baselineMb: number, afterMb: number, pct = MEMORY_BUDGETS.leakReturnPct): boolean {
  if (!Number.isFinite(baselineMb) || baselineMb <= 0) return afterMb <= 0
  return afterMb <= baselineMb * (1 + pct / 100)
}

export interface BudgetFailure {
  check: string
  actual: number
  limit: number
}

export function evaluateBudgets(
  checkpoints: Checkpoint[],
  budgets: MemoryBudgets = MEMORY_BUDGETS,
): BudgetFailure[] {
  const failures: BudgetFailure[] = []
  const idle = checkpoints.find((c) => c.name === 'launch+60s-idle' || c.name === 'launch-idle')
  const project = checkpoints.find((c) => c.name === 'project-open')
  const settled = checkpoints.find((c) => c.name === 'idle+5min' || c.name === 'idle+1min')
  if (idle && idle.totalMb > budgets.idleTotalMb) {
    failures.push({ check: `${idle.name} total`, actual: idle.totalMb, limit: budgets.idleTotalMb })
  }
  if (project && project.totalMb > budgets.projectOpenTotalMb) {
    failures.push({ check: 'project-open total', actual: project.totalMb, limit: budgets.projectOpenTotalMb })
  }
  if (project && settled) {
    const growth = growthPercent(project.totalMb, settled.totalMb)
    if (growth > budgets.idleGrowthPct) {
      failures.push({ check: 'idle growth %', actual: growth, limit: budgets.idleGrowthPct })
    }
  }
  for (const checkpoint of checkpoints) {
    const api = checkpoint.rolesMb.api
    if (api !== undefined && api > budgets.apiMb) {
      failures.push({ check: `${checkpoint.name} api`, actual: api, limit: budgets.apiMb })
    }
  }
  return failures
}

/** macOS `footprint -p` prints `phys_footprint: 123.4M`. Returns MB or null. */
export function parseFootprint(text: string): number | null {
  const match = text.match(/phys_footprint:\s+([0-9.]+)\s*([KMG])?/i)
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] || 'M').toUpperCase()
  if (!Number.isFinite(value)) return null
  if (unit === 'K') return kbToMb(value)
  if (unit === 'G') return Math.round(value * 1024 * 10) / 10
  return Math.round(value * 10) / 10
}

export function sampleProcessList(): ProcessSample[] {
  const args = platform() === 'win32'
    ? ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, [int]($_.WorkingSetSize/1KB), $_.CommandLine }']
    : ['-ax', '-o', 'pid=,ppid=,rss=,command=']
  const bin = platform() === 'win32' ? 'powershell' : 'ps'
  const text = execFileSync(bin, args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
  return parsePs(text)
}

export function descendants(samples: ProcessSample[], rootPid: number): ProcessSample[] {
  const children = new Map<number, number[]>()
  for (const sample of samples) {
    const list = children.get(sample.ppid) ?? []
    list.push(sample.pid)
    children.set(sample.ppid, list)
  }
  const keep = new Set<number>()
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()!
    if (keep.has(pid)) continue
    keep.add(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return samples.filter((sample) => keep.has(sample.pid))
}

export function readFootprintMb(pid: number): number | null {
  if (platform() !== 'darwin') return null
  try {
    const text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf-8' })
    return parseFootprint(text)
  } catch {
    return null
  }
}

export function buildCheckpoint(input: {
  name: string
  electron: ElectronProcessSample[]
  processes: ProcessSample[]
  electronPids?: number[]
  webContents?: number
  rendererHeapMb?: number
  footprintMb?: number
}): Checkpoint {
  const electronIds = new Set(input.electronPids ?? input.electron.map((m) => m.pid))
  const other = input.processes.filter((sample) => !electronIds.has(sample.pid) && sample.role !== 'electron')
  const electron = electronMb(input.electron)
  const roles = rolesMb(other)
  const otherMb = kbToMb(other.reduce((sum, sample) => sum + sample.rssKb, 0))
  return {
    name: input.name,
    at: new Date().toISOString(),
    electronMb: electron.totalMb,
    otherMb,
    totalMb: kbToMb(electron.totalMb * 1024 + otherMb * 1024),
    webContents: input.webContents,
    rendererHeapMb: input.rendererHeapMb,
    rolesMb: roles,
    electronByTypeMb: electron.byTypeMb,
    footprintMb: input.footprintMb,
  }
}

export function renderMarkdown(checkpoints: Checkpoint[], budgets: MemoryBudgets = MEMORY_BUDGETS): string {
  const lines = [
    '# Desktop memory report',
    '',
    `Host: ${hostname()} (${platform()}, ${Math.round(totalmem() / 1024 / 1024)} MB RAM)`,
    '',
    '| Checkpoint | Electron (MB) | Other (MB) | Total (MB) | Result |',
    '|---|---:|---:|---:|---|',
  ]
  const failures = evaluateBudgets(checkpoints, budgets)
  const failedChecks = new Set(failures.map((f) => f.check))
  for (const checkpoint of checkpoints) {
    const relevant = [...failedChecks].filter((check) => check.startsWith(checkpoint.name) || (checkpoint.name === 'project-open' && check.startsWith('project-open')))
    const result = relevant.length ? 'fail' : 'ok'
    lines.push(`| ${checkpoint.name} | ${checkpoint.electronMb} | ${checkpoint.otherMb} | ${checkpoint.totalMb} | ${result} |`)
  }
  if (failures.length) {
    lines.push('', '## Budget failures', '')
    for (const failure of failures) {
      lines.push(`- ${failure.check}: ${failure.actual} > ${failure.limit}`)
    }
  }
  const peak = [...checkpoints].sort((a, b) => b.totalMb - a.totalMb)[0]
  if (peak) {
    lines.push('', `### Role breakdown (${peak.name})`, '', '| Role | MB |', '|---|---:|')
    for (const [role, mb] of Object.entries(peak.rolesMb).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
      lines.push(`| ${role} | ${mb} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function writeReport(dir: string, checkpoints: Checkpoint[], budgets = MEMORY_BUDGETS): { jsonPath: string; mdPath: string } {
  mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const jsonPath = join(dir, `${platform()}-memory-${stamp}.json`)
  const mdPath = join(dir, `memory-report-${stamp}.md`)
  writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: platform(),
    totalMemMb: Math.round(totalmem() / 1024 / 1024),
    budgets,
    checkpoints,
    failures: evaluateBudgets(checkpoints, budgets),
  }, null, 2))
  writeFileSync(mdPath, renderMarkdown(checkpoints, budgets))
  return { jsonPath, mdPath }
}

