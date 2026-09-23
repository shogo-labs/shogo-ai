// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Baseline/verification harness for the local API footprint.
 *
 * The API is started through the same scratch harness used by the lifecycle
 * benchmark, then this script samples the API process and its descendants
 * after /api/health is ready.  It intentionally measures the process tree
 * rather than only Bun's heap: native modules, SQLite, JIT pages, and mapped
 * Prisma code all contribute to the desktop memory budget.
 *
 * Usage:
 *   bun scripts/bench/api-import-cost.ts
 *   bun scripts/bench/api-import-cost.ts --output-dir bench-results
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

type ProcessRow = {
  pid: number
  ppid: number
  rssKb: number
  command: string
}

type Result = {
  generatedAt: string
  apiPid: number | null
  apiRssMb: number
  apiTreeRssMb: number
  apiTree: ProcessRow[]
  serverImportCount: number
  serverImportSpecifiers: string[]
  measuredComposer: string
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const outputDir = resolve(valueAfter('--output-dir') ?? join(repoRoot, 'bench-results'))
const port = Number(valueAfter('--port') ?? '39280')
const dataDir = resolve(valueAfter('--data-dir') ?? join(tmpdir(), 'shogo-api-import-cost'))
const timeoutMs = Number(valueAfter('--timeout-ms') ?? '120000')

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseComposerImports(): { path: string; specifiers: string[] } {
  const path = process.env.SHOGO_API_PROFILE === 'cloud'
    ? join(repoRoot, 'apps/api/src/server.ts')
    : join(repoRoot, 'apps/api/src/local-server.ts')
  const source = readFileSync(path, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(/^\s*import(?: type)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    specifiers.push(match[1])
  }
  return { path, specifiers: [...new Set(specifiers)] }
}

function listProcesses(): ProcessRow[] {
  if (process.platform === 'win32') return []
  try {
    const output = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout.toString()
    return output
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) return null
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssKb: Number(match[3]),
          command: match[4],
        }
      })
      .filter((row): row is ProcessRow => row !== null)
  } catch {
    return []
  }
}

function descendants(rows: ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const out: ProcessRow[] = []
  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`local API harness exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {
      // The harness performs migrations and seeds before the API is ready.
    }
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for API health on port ${port}`)
}

function shutdown(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      Bun.spawnSync(['taskkill', '/PID', String(child.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
    } catch {
      // The harness may already have exited.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

const composer = parseComposerImports()
const output: Buffer[] = []
const harness = spawn(process.execPath, [
  '--no-env-file',
  'scripts/bench/local-api.ts',
  '--port',
  String(port),
  '--data-dir',
  dataDir,
  '--env',
  'DESKTOP_STARTUP_PREWARM_PROJECTS=0',
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SHOGO_LOCAL_MODE: 'true',
    DESKTOP_STARTUP_PREWARM_PROJECTS: '0',
  },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
})

harness.stdout?.on('data', (chunk: Buffer) => output.push(chunk))
harness.stderr?.on('data', (chunk: Buffer) => output.push(chunk))

try {
  await waitForReady(harness)
  const rows = listProcesses()
  const api = rows.find((row) => row.command.includes(`apps/api/src/entry.ts`) && row.ppid === harness.pid)
  const tree = api ? [api, ...descendants(rows, api.pid)] : []
  const result: Result = {
    generatedAt: new Date().toISOString(),
    apiPid: api?.pid ?? null,
    apiRssMb: Number(((api?.rssKb ?? 0) / 1024).toFixed(1)),
    apiTreeRssMb: Number((tree.reduce((sum, row) => sum + row.rssKb, 0) / 1024).toFixed(1)),
    apiTree: tree,
    serverImportCount: composer.specifiers.length,
    serverImportSpecifiers: composer.specifiers,
    measuredComposer: composer.path,
  }
  mkdirSync(outputDir, { recursive: true })
  const path = join(outputDir, `api-import-cost-${process.platform}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  console.log(`Wrote ${path}`)
} finally {
  shutdown(harness)
  await new Promise<void>((resolve) => {
    if (harness.exitCode !== null) return resolve()
    harness.once('exit', () => resolve())
    setTimeout(resolve, 10_000).unref?.()
  })
}
