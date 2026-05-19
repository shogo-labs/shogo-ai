// Reproduces the EPERM rename failure on Windows for build-output-commit.
//
// The user's reported error path:
//   could not move <workspace>/dist.canvas.staging to <workspace>/dist
//   EPERM: operation not permitted, rename ...
//
// Hypothesis: it's not chokidar pinning the source. The real cause is that
// PreviewManager's `vite build --watch` is continuously writing into
// `dist/` while CanvasBuildManager simultaneously tries to atomically
// swap `dist.canvas.staging → dist`. Even after we successfully rotate
// `dist → dist.prev`, vite-watch sees `dist/` disappear and immediately
// recreates it (it mkdirs `dist/assets/` and starts writing new chunks
// because its internal rollup watcher fired). By the time we reach
// `renameSync(staging, dist)`, dist exists again AND has open handles
// → EPERM.
//
// This script reproduces both failure modes:
//   case A: held handle inside dist/ blocks the rotation rename
//   case B: dist/ recreated mid-swap blocks the staging rename
//   case C: full live race with a long-running writer simulating vite-watch

import {
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commitBuildOutput } from '../packages/agent-runtime/src/build-output-commit'

const root = join(tmpdir(), `repro-eperm-${Date.now()}`)
mkdirSync(root, { recursive: true })

function reset(): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
}

function seed(rel: string, files: Record<string, string>): void {
  const full = join(root, rel)
  mkdirSync(full, { recursive: true })
  for (const [n, c] of Object.entries(files)) {
    const dest = join(full, n)
    const lastSep = Math.max(dest.lastIndexOf('\\'), dest.lastIndexOf('/'))
    if (lastSep > full.length) mkdirSync(dest.slice(0, lastSep), { recursive: true })
    writeFileSync(dest, c)
  }
}

// ---------------------------------------------------------------------------
// Case A: Open handle inside dist/ blocks `rename(dist, dist.prev)`.
// This is the rotation step. On POSIX it would succeed.
// ---------------------------------------------------------------------------

console.log('--- Case A: handle in dist/ blocks rotation rename ---')
reset()
seed('dist', { 'index.html': '<html>old</html>' })

// Simulate vite-watch holding `dist/index.html` open for write
// (it's literally mid-write of a chunk when our rename fires).
const handle = openSync(join(root, 'dist', 'index.html'), 'r')
try {
  renameSync(join(root, 'dist'), join(root, 'dist.prev'))
  console.log('  rename succeeded (would only happen on POSIX)')
} catch (e: any) {
  console.log(`  rename failed: code=${e.code} errno=${e.errno}`)
  console.log(`  message: ${e.message}`)
}
closeSync(handle)

// ---------------------------------------------------------------------------
// Case B: dist/ recreated mid-swap blocks `rename(staging, dist)`.
// Simulates: rotation succeeded, then vite-watch recreated dist/ before
// we got to the staging-promotion rename.
// ---------------------------------------------------------------------------

console.log('\n--- Case B: dist/ recreated between rotation and promotion ---')
reset()
seed('dist.canvas.staging', { 'index.html': '<html>new</html>' })
// vite-watch recreates dist/ and opens a chunk for write
seed('dist', { 'assets/dummy.js': 'console.log(1)' })
const h2 = openSync(join(root, 'dist', 'assets', 'dummy.js'), 'r')
try {
  renameSync(join(root, 'dist.canvas.staging'), join(root, 'dist'))
  console.log('  rename succeeded (would only happen on POSIX)')
} catch (e: any) {
  console.log(`  rename failed: code=${e.code} errno=${e.errno}`)
  console.log(`  message: ${e.message}`)
}
closeSync(h2)

// ---------------------------------------------------------------------------
// Case C: Full live race. Spawn a background "vite-watch" simulator
// that continuously writes into dist/ at 50ms intervals while we
// repeatedly call commitBuildOutput against a fresh staging dir.
// Counts how many commits succeed vs fail.
// ---------------------------------------------------------------------------

console.log('\n--- Case C: live race against a continuous dist/ writer ---')
reset()

// Background writer simulating vite-watch's behavior. Uses Bun's
// child_process to write to dist/ from a separate process so its
// handles really are out-of-process (matching the live system).
import { spawn } from 'node:child_process'

const writerScript = `
const { writeFileSync, mkdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const root = ${JSON.stringify(root)}
const dist = join(root, 'dist')
const STOP = join(root, '.stop-writer')
let iter = 0
while (true) {
  if (existsSync(STOP)) break
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'index.html'), '<html>iter=' + iter + '</html>')
    writeFileSync(join(dist, 'assets', 'index-' + (iter % 4) + '.js'), 'console.log(' + iter + ')')
    iter++
  } catch (e) { /* race with our deletes, ignore */ }
  // Tight loop on purpose to maximize collisions.
  const end = Date.now() + 10
  while (Date.now() < end) {}
}
`
const writerFile = join(root, '.writer.cjs')
writeFileSync(writerFile, writerScript)
const writer = spawn(process.execPath, [writerFile], {
  stdio: 'ignore',
  detached: false,
})

// Give the writer a moment to populate dist/ first
await new Promise((r) => setTimeout(r, 200))

let succeeded = 0
let failed = 0
const ITERATIONS = 30
const TRIALS_START = Date.now()
for (let i = 0; i < ITERATIONS; i++) {
  // Fresh staging dir per attempt
  seed('dist.canvas.staging', {
    'index.html': `<html>build-${i}</html>`,
    'assets/main.js': `console.log("build ${i}")`,
  })
  const ok = commitBuildOutput(root, 'dist.canvas.staging')
  if (ok) succeeded++
  else failed++
  // Brief pause between commits to let the writer cycle
  await new Promise((r) => setTimeout(r, 30))
}
const elapsed = Date.now() - TRIALS_START

// Stop the writer
writeFileSync(join(root, '.stop-writer'), '')
writer.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 100))

console.log(`  iterations: ${ITERATIONS}`)
console.log(`  succeeded:  ${succeeded}`)
console.log(`  failed:     ${failed}`)
console.log(`  elapsed:    ${elapsed}ms`)
if (existsSync(join(root, 'dist', 'index.html'))) {
  console.log(`  final dist/index.html: ${readFileSync(join(root, 'dist', 'index.html'), 'utf-8').slice(0, 80)}`)
}

rmSync(root, { recursive: true, force: true })
