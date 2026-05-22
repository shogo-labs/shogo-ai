// Seed coverage/coverage-tasks.json from per-package gap reports.
// Replacement for seed-coverage-tasks.ts (which is apps/api-only).
//
// Reads coverage/baselines/{apps-api,packages-agent-runtime,packages-sdk,
// packages-shared-runtime,packages-model-catalog}.gaps.json and emits a
// unified queue with a `package` field per task.
//
// Run: bun run scripts/seed-coverage-tasks-all.ts [--force]
//
// Phase split: <10 uncov = phase 1, <50 = phase 2, else phase 3.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outPath = resolve(root, 'coverage/coverage-tasks.json')
const force = process.argv.includes('--force')

if (existsSync(outPath) && !force) {
  console.log(`[seed-all] ${outPath} already exists — pass --force to rewrite`)
  process.exit(0)
}

const PACKAGES: Record<string, string> = {
  'apps/api': 'apps-api',
  'packages/agent-runtime': 'packages-agent-runtime',
  'packages/sdk': 'packages-sdk',
  'packages/shared-runtime': 'packages-shared-runtime',
  'packages/model-catalog': 'packages-model-catalog',
}

type Gap = {
  file: string
  uncoveredLines: number
  linePct: number
  funcPct: number
}
type GapReport = {
  totals: {
    linesHit: number; linesFound: number
    funcsHit: number; funcsFound: number
    linePct: number;  funcPct: number
  }
  files: Gap[]
}

const now = new Date().toISOString()
const tasks: any[] = []
const perPackageTotals: Record<string, any> = {}

for (const [pkg, slug] of Object.entries(PACKAGES)) {
  const path = resolve(root, `coverage/baselines/${slug}.gaps.json`)
  if (!existsSync(path)) {
    console.log(`[seed-all] skip ${pkg} — no baseline at ${path}`)
    continue
  }
  const g = JSON.parse(readFileSync(path, 'utf8')) as GapReport
  perPackageTotals[pkg] = {
    lines: `${g.totals.linesHit}/${g.totals.linesFound}`,
    linePct: Number(g.totals.linePct.toFixed(2)),
    funcs: `${g.totals.funcsHit}/${g.totals.funcsFound}`,
    funcPct: Number(g.totals.funcPct.toFixed(2)),
  }
  for (const f of g.files) {
    if (f.uncoveredLines <= 0) continue
    const fp = f.file.startsWith('apps/') || f.file.startsWith('packages/')
      ? f.file
      : `${pkg}/${f.file}`
    tasks.push({
      file: fp,
      package: pkg,
      uncoveredLines: f.uncoveredLines,
      linePct: Number(f.linePct.toFixed(4)),
      funcPct: Number((f.funcPct ?? 0).toFixed(4)),
      phase: f.uncoveredLines < 10 ? 1 : f.uncoveredLines < 50 ? 2 : 3,
      status: 'pending',
      createdAt: now,
    })
  }
}

tasks.sort((a, b) =>
  a.phase - b.phase || a.uncoveredLines - b.uncoveredLines || a.file.localeCompare(b.file)
)

const phaseBreakdown: Record<string, number> = {}
const byPackage: Record<string, number> = {}
for (const t of tasks) {
  phaseBreakdown[String(t.phase)] = (phaseBreakdown[String(t.phase)] ?? 0) + 1
  byPackage[t.package] = (byPackage[t.package] ?? 0) + 1
}

writeFileSync(outPath, JSON.stringify({
  generatedAt: now,
  campaign: 'backend-coverage-to-100-v2',
  branch: 'fix/unit-backend-testCases',
  scope: Object.keys(PACKAGES),
  total: tasks.length,
  perPackageTotals,
  phaseBreakdown,
  byPackage,
  tasks,
}, null, 2) + '\n')

console.log(`[seed-all] wrote ${tasks.length} tasks → ${outPath}`)
console.log(`[seed-all] phases: ${JSON.stringify(phaseBreakdown)}  packages: ${JSON.stringify(byPackage)}`)
console.log(`[seed-all] total uncov lines: ${tasks.reduce((s, t) => s + t.uncoveredLines, 0)}`)
