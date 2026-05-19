// Seed coverage/coverage-tasks.json from coverage/baselines/apps-api.gaps.json
// Run: bun run scripts/seed-coverage-tasks.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const gapsPath = resolve(root, 'coverage/baselines/apps-api.gaps.json')
const outPath = resolve(root, 'coverage/coverage-tasks.json')

const force = process.argv.includes('--force')
if (existsSync(outPath) && !force) {
  console.log(`[seed] ${outPath} already exists — pass --force to rewrite`)
  process.exit(0)
}

type Gap = { file: string; uncoveredLines: number; linePct: number }
const gaps = JSON.parse(readFileSync(gapsPath, 'utf8')) as { files: Gap[] }

const now = new Date().toISOString()
const tasks = gaps.files
  .filter((f) => f.uncoveredLines > 0)
  .sort((a, b) => a.uncoveredLines - b.uncoveredLines)
  .map((f) => ({
    file: f.file,
    uncoveredLines: f.uncoveredLines,
    linePct: f.linePct,
    phase: f.uncoveredLines < 10 ? 1 : f.uncoveredLines < 50 ? 2 : 3,
    status: 'pending' as const,
    createdAt: now,
  }))

writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: now, total: tasks.length, tasks },
    null,
    2,
  ) + '\n',
)
console.log(`[seed] wrote ${tasks.length} tasks → ${outPath}`)
console.log(
  `[seed] phase 1: ${tasks.filter((t) => t.phase === 1).length}, ` +
    `phase 2: ${tasks.filter((t) => t.phase === 2).length}, ` +
    `phase 3: ${tasks.filter((t) => t.phase === 3).length}`,
)
