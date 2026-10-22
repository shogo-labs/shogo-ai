// TEMPORARY diagnostic for SHO-154 — deleted before the PR.
//
// Question: on an ubuntu-latest runner, why does `sampleTreeRssKb([handle.pid])`
// read ~52 MB for a child that allocated a 192 MB Buffer? Two candidates:
//
//   (a) the pages are not resident (the allocation is not committed), or
//   (b) the sample misses the process that holds them.
//
// It answers both by printing, per variant: what the child says it holds
// (/proc/self/status VmRSS + VmHWM), the group's per-pid RSS from
// /proc/<pid>/status, and the same figure from `ps -A -o pgid=,rss=` — the
// query `sampleTreeRssKb` itself runs.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { sampleTreeRssKb } from '../src/exec-memory-guard'
import { sandboxExecAsync, type CommandHandle } from '../src/sandbox-exec'

const MB = 1024 * 1024
const HOLD_MB = 192

const VARIANTS: Record<string, string> = {
  'one-big-alloc': `
const hog = Buffer.alloc(${HOLD_MB} * ${MB}, 1)
if (hog[0] !== 1 || hog[hog.length - 1] !== 1) process.exit(2)
`,
  'many-small-allocs': `
const chunks = []
for (let i = 0; i < ${HOLD_MB}; i++) chunks.push(Buffer.alloc(${MB}, 1))
if (chunks.length !== ${HOLD_MB} || chunks[${HOLD_MB - 1}][${MB} - 1] !== 1) process.exit(2)
`,
  'one-big-alloc-touched': `
const hog = Buffer.allocUnsafe(${HOLD_MB} * ${MB})
for (let i = 0; i < hog.length; i += 4096) hog[i] = 1
hog[hog.length - 1] = 1
`,
}

const REPORT_TAIL = `
const fs = require('fs')
const usage = process.memoryUsage()
let vmRss = -1
let vmHwm = -1
try {
  const status = fs.readFileSync('/proc/self/status', 'utf-8')
  const grab = (key) => {
    const m = new RegExp('^' + key + ':\\\\s*(\\\\d+)', 'm').exec(status)
    return m ? Number(m[1]) : -1
  }
  vmRss = grab('VmRSS')
  vmHwm = grab('VmHWM')
} catch {}
console.log(
  '[hog] pid=' + process.pid +
  ' rss=' + usage.rss +
  ' heapTotal=' + usage.heapTotal +
  ' external=' + usage.external +
  ' vmRssKb=' + vmRss +
  ' vmHwmKb=' + vmHwm,
)
setTimeout(() => process.exit(0), 60000)
`

function childRssKb(pid: number): number {
  try {
    const m = /^VmRSS:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf-8'))
    return m ? Number(m[1]) : -1
  } catch {
    return -1
  }
}

function psTable(): string {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,args='], { encoding: 'utf-8' })
  } catch (err) {
    return `ps failed: ${err}`
  }
}

function pidsInGroup(pgid: number): number[] {
  const out: number[] = []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf-8')
      // pgrp is field 5; fields after `comm` are safe to split from the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(rest[2]) === pgid) out.push(Number(entry))
    } catch { /* raced with exit */ }
  }
  return out
}

async function probe(name: string, body: string, dir: string): Promise<void> {
  const script = join(dir, `${name}.js`)
  writeFileSync(script, body + REPORT_TAIL)
  const handle: CommandHandle = sandboxExecAsync({
    command: `${process.execPath} ${script}`,
    workspaceDir: dir,
  })
  const pid = handle.pid!
  console.log(`\n===== variant: ${name} (root pid ${pid}) =====`)

  await new Promise((resolve) => setTimeout(resolve, 3000))

  const sizes = await sampleTreeRssKb([pid])
  console.log(`sampleTreeRssKb([${pid}]) = ${sizes.get(pid) ?? 0} KB`)
  console.log(`[hog] self-reported: ${handle.stdout().trim() || '(nothing yet)'}`)
  console.log(`[hog] exited=${handle.exited()} stderr=${JSON.stringify(handle.stderr().slice(0, 400))}`)

  const group = pidsInGroup(pid)
  console.log(`pids in process group ${pid}: ${JSON.stringify(group)}`)
  for (const p of group) console.log(`  /proc/${p}/status VmRSS = ${childRssKb(p)} KB`)

  try {
    const raw = execFileSync('ps', ['-A', '-o', 'pgid=,rss='], { encoding: 'utf-8' })
    const mine = raw
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pgid]) => pgid === pid)
    console.log(`ps lines with pgid ${pid}: ${JSON.stringify(mine)}`)
  } catch (err) {
    console.log(`ps sum failed: ${err}`)
  }

  console.log('--- ps -A (pid ppid pgid rss args) ---')
  console.log(psTable().split('\n').filter((l) => l.includes(dir)).join('\n'))

  handle.kill('SIGKILL')
  await handle.done
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sho154-probe-'))
  console.log(`execPath=${process.execPath}`)
  console.log(`platform=${process.platform} arch=${process.arch} bun=${(globalThis as any).Bun?.version}`)
  if (existsSync('/proc/meminfo')) {
    console.log(readFileSync('/proc/meminfo', 'utf-8').split('\n').slice(0, 3).join(' | '))
  }
  if (existsSync('/sys/fs/cgroup/memory.max')) {
    console.log(`cgroup memory.max = ${readFileSync('/sys/fs/cgroup/memory.max', 'utf-8').trim()}`)
  }
  for (const [name, body] of Object.entries(VARIANTS)) {
    await probe(name, body, dir)
  }
}

await main()
