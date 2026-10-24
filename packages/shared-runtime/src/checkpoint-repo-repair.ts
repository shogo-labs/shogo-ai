// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-shot repair for checkpoint repos that already carry Shogo runtime state in
 * their history (SHO-105, #1597): stop tracking `.shogo/*`/`.tmp/*` scratch, get
 * it out of LFS, and reclaim the bytes already on disk — 3.6 GB on the Mac where
 * this was reproduced, 165 GB on the Windows install in the issue.
 *
 * `packages/shared-runtime/src/shogo-state-paths.ts` owns the predicate and the
 * index-level pass; this module owns the history rewrite.
 *
 * A rewrite, not `filter-repo`/`filter-branch`: both refuse (or wreck) a
 * working tree that is permanently dirty, and `.shogo/sessions.db` is open by
 * the running runtime. `git fast-export | filter | git fast-import` rewrites
 * refs only and leaves every file on disk exactly where it is.
 *
 * Runs once per repo: the marker `.git/shogo/checkpoint-repair.json` makes a
 * second run a no-op, and the whole thing is gated on an idle repo plus enough
 * free disk to hold a second copy of `.git` while git repacks.
 */

import { spawn } from './child-process'
import { Transform } from 'node:stream'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  acquireRepairLock,
  directorySizeBytes,
  ensureShogoExcludes,
  evictStaleGitLock,
  isRepoIdle,
  isShogoRuntimeState,
  resolveGitDir,
  untrackShogoStatePaths,
} from './shogo-state-paths'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

const MARKER_VERSION = 1
const MARKER_REL = join('shogo', 'checkpoint-repair.json')

export interface RepairOptions {
  logger?: Logger
  /** Measure and report, change nothing. `SHOGO_CHECKPOINT_REPAIR=dry`. */
  dryRun?: boolean
  /** Where the pre-rewrite `git bundle` goes. Default `<gitDir>/shogo/backups`. */
  backupDir?: string
  /** Multiple of the repo's current `.git` size that must be free. */
  freeDiskFactor?: number
  /** Called with every `oldSha -> newSha` the rewrite produced, before gc. */
  onRemap?: (map: Map<string, string>) => Promise<void> | void
}

export interface RepairResult {
  repoDir: string
  skipped: boolean
  reason?: string
  bytesBefore: number
  bytesAfter: number
  /** Runtime-state paths dropped from the index. */
  untracked: number
  /** Commits whose sha changed. */
  rewritten: number
  /** LFS-tracked file versions no longer referenced by any ref. */
  lfsVersionsBefore: number
  lfsVersionsAfter: number
  dryRun: boolean
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

function run(
  dir: string,
  args: string[],
  opts: { input?: string; maxBuffer?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => { stdout += c })
    child.stderr?.on('data', (c: string) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => { /* fast-import exits early on a drop */ })
      child.stdin?.end(opts.input)
    } else {
      child.stdin?.end()
    }
  })
}

function markerPath(gitDir: string): string {
  return join(gitDir, MARKER_REL)
}

/** The marker written by a completed repair, or null. */
export function readRepairMarker(repoDir: string): Record<string, unknown> | null {
  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) return null
  try {
    const parsed = JSON.parse(readFileSync(markerPath(gitDir), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Last successful repair of `repoDir`, for the desktop/server health surface. */
export function repairedBytes(repoDir: string): { bytesBefore: number; bytesAfter: number } | null {
  const marker = readRepairMarker(repoDir) as
    | { bytesBefore?: unknown; bytesAfter?: unknown }
    | null
  if (!marker) return null
  const before = Number(marker.bytesBefore)
  const after = Number(marker.bytesAfter)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  return { bytesBefore: before, bytesAfter: after }
}

/**
 * Free bytes on the filesystem holding `dir`. `statfs` is not portable through
 * node's fs API, so this shells out once per repo instead of guessing: `df -Pk`
 * works on macOS and Linux, `wmic`-free `dir` parsing is unnecessary on Windows
 * where the repair gate falls back to "no gate".
 */
async function freeBytesAt(dir: string): Promise<number | null> {
  if (process.platform === 'win32') return null
  const res = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn('df', ['-Pk', dir], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => { out += c })
    child.on('error', () => resolve({ code: -1, out: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  if (res.code !== 0) return null
  const line = res.out.trim().split('\n').pop() ?? ''
  const cols = line.split(/\s+/)
  const avail = Number(cols[3])
  return Number.isFinite(avail) ? avail * 1024 : null
}

/** Count LFS-tracked file versions reachable from any ref (`git lfs ls-files -a`). */
async function countLfsVersions(repoDir: string): Promise<number> {
  const res = await run(repoDir, ['lfs', 'ls-files', '-a'])
  if (res.exitCode !== 0) return 0
  return res.stdout.split('\n').filter((l) => l.trim().length > 0).length
}

/** Unquote a C-style quoted fast-export path (`"a\\tb"`); leave bare paths alone. */
function unquotePath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"')) return trimmed
  const body = trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const next = body[++i]
    switch (next) {
      case 'n': bytes.push(10); break
      case 't': bytes.push(9); break
      case 'r': bytes.push(13); break
      case '"': bytes.push(34); break
      case '\\': bytes.push(92); break
      default: {
        const oct = body.slice(i, i + 3)
        if (/^[0-7]{3}$/.test(oct)) {
          bytes.push(parseInt(oct, 8))
          i += 2
        } else {
          bytes.push(next.charCodeAt(0))
        }
      }
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Paths carried by one fast-export file-change line, or null when unparsable. */
function linePaths(line: string): string[] | null {
  if (line.startsWith('M ')) {
    // `M 100644 :12 path` / `M 100644 inline path`
    const match = /^M \d+ (?::\d+|inline) (.+)$/.exec(line)
    return match ? [unquotePath(match[1])] : null
  }
  if (line.startsWith('D ')) return [unquotePath(line.slice(2))]
  if (line.startsWith('C ')) {
    const match = /^C (?::\d+|inline) (.+)$/.exec(line)
    return match ? [unquotePath(match[1])] : null
  }
  if (line.startsWith('R ')) {
    const match = /^R (.+) (\S+)$/.exec(line)
    if (!match) return null
    return [unquotePath(match[1]), unquotePath(match[2])]
  }
  return null
}

/** `data <n>` — the length-prefixed payload that follows on the next lines. */
function dataLength(line: string): number | null {
  const match = /^data (\d+)$/.exec(line)
  return match ? Number(match[1]) : null
}

/**
 * A `git fast-export` stream with every file change for Shogo runtime state
 * removed. Byte-accurate, because a `data <n>` payload may be a binary blob or a
 * multi-byte-UTF-8 message and is copied verbatim by declared length: treating
 * the stream as lines would let a payload line that happens to look like a file
 * change (`M 100644 :3 x`) shift the whole stream.
 *
 * Everything else — commits, blobs, refs, `reset`, `mark`, `deleteall`, other
 * paths — passes through untouched.
 */
class ExportFilter extends Transform {
  private pending: Buffer = Buffer.alloc(0)
  private dataRemaining: number | null = null
  private needDataTerminator = false
  dropped = 0

  _transform(chunk: Buffer, _enc: BufferEncoding, done: () => void): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const out: Buffer[] = []
    let i = 0

    while (i < buf.length) {
      if (this.dataRemaining !== null) {
        if (this.dataRemaining > 0) {
          const take = Math.min(this.dataRemaining, buf.length - i)
          out.push(buf.subarray(i, i + take))
          i += take
          this.dataRemaining -= take
          continue
        }
        this.dataRemaining = null
        this.needDataTerminator = true
      }
      if (this.needDataTerminator) {
        // A `data` payload is terminated by an LF *unless* the payload's own
        // last byte is already one (git omits it then) — so only consume a byte
        // that really is a newline. Consuming blindly ate the `M` of the next
        // file change and shifted the whole stream.
        if (buf[i] === 0x0a) {
          out.push(buf.subarray(i, i + 1))
          i += 1
        }
        this.needDataTerminator = false
        continue
      }

      const nl = buf.indexOf(0x0a, i)
      if (nl === -1) break
      const line = buf.subarray(i, nl).toString('utf8')
      const end = nl + 1

      const length = dataLength(line)
      if (length !== null) {
        out.push(buf.subarray(i, end))
        i = end
        this.dataRemaining = length
        continue
      }

      const paths = linePaths(line)
      if (paths && paths.some((p) => isShogoRuntimeState(p))) {
        this.dropped += 1
        i = end
        continue
      }
      out.push(buf.subarray(i, end))
      i = end
    }

    this.pending = Buffer.from(buf.subarray(i))
    if (out.length) this.push(Buffer.concat(out))
    done()
  }

  _flush(done: () => void): void {
    if (this.pending.length) this.push(this.pending)
    this.pending = Buffer.alloc(0)
    done()
  }
}

/** Byte-accurate export filter over a whole stream. Used by tests and small repos. */
export function filterExportStream(input: string | Buffer): { out: Buffer; dropped: number } {
  const filter = new ExportFilter()
  const body = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  const chunks: Buffer[] = []
  // Synchronous drive: `_transform`/`_flush` push into the readable side.
  const grep = filter as unknown as {
    _transform: (chunk: Buffer, enc: BufferEncoding, done: () => void) => void
    _flush: (done: () => void) => void
  }
  grep._transform(body, 'utf8', () => {})
  grep._flush(() => {})
  let chunk: Buffer | null
  while ((chunk = filter.read() as Buffer | null) !== null) chunks.push(chunk)
  return { out: Buffer.concat(chunks), dropped: filter.dropped }
}

/** Parse `git fast-export --export-marks` / `fast-import --export-marks` output. */
export function parseMarks(file: string): Map<string, string> {
  const out = new Map<string, string>()
  let body = ''
  try {
    body = readFileSync(file, 'utf-8')
  } catch {
    return out
  }
  for (const line of body.split('\n')) {
    const match = /^:(\d+) ([0-9a-f]{40,64})$/.exec(line.trim())
    if (match) out.set(match[1], match[2])
  }
  return out
}

/**
 * `git fast-export --all | filter | git fast-import --force`, streamed with
 * backpressure so a 2 GB repo never has to fit in memory.
 *
 * A rewrite, not `filter-repo`/`filter-branch`: both refuse or wreck a working
 * tree that is permanently dirty, and `.shogo/sessions.db` is open by the
 * running runtime. This touches refs only — every file stays where it is.
 */
function streamRewrite(
  repoDir: string,
  marksOld: string,
  marksNew: string,
): Promise<{ dropped: number; error?: string }> {
  const filter = new ExportFilter()
  const exporter = spawn('git', [
    'fast-export', '--all',
    '--signed-tags=strip',
    '--tag-of-filtered-object=rewrite',
    '--reencode=no',
    `--export-marks=${marksOld}`,
  ], { cwd: repoDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const importer = spawn('git', [
    'fast-import', '--force', '--quiet', `--export-marks=${marksNew}`,
  ], { cwd: repoDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })

  let exportErr = ''
  let importErr = ''
  exporter.stderr?.setEncoding('utf-8')
  importer.stderr?.setEncoding('utf-8')
  exporter.stderr?.on('data', (c: string) => { exportErr += c })
  importer.stderr?.on('data', (c: string) => { importErr += c })
  // fast-import exits as soon as it sees a bad command; keep the pipeline from
  // surfacing that as an unhandled EPIPE on the writer side.
  importer.stdin?.on('error', () => { /* reported via importErr / exit code */ })
  exporter.stdout?.on('error', () => { /* reported via exportErr */ })

  exporter.stdout?.pipe(filter).pipe(importer.stdin!)

  return new Promise((resolve) => {
    const codes: Record<'export' | 'import', number | null> = { export: null, import: null }
    const settle = () => {
      if (codes.export === null || codes.import === null) return
      if (codes.export !== 0) {
        resolve({ dropped: filter.dropped, error: `fast-export: ${exportErr.trim()}` })
        return
      }
      if (codes.import !== 0) {
        resolve({ dropped: filter.dropped, error: `fast-import: ${importErr.trim()}` })
        return
      }
      resolve({ dropped: filter.dropped })
    }
    exporter.on('error', (err) => {
      exportErr = exportErr || String(err?.message ?? err)
      codes.export = -1
      settle()
    })
    exporter.on('close', (code) => {
      codes.export = code ?? -1
      settle()
    })
    importer.on('error', (err) => {
      importErr = importErr || String(err?.message ?? err)
      codes.import = -1
      settle()
    })
    importer.on('close', (code) => {
      codes.import = code ?? -1
      settle()
    })
  })
}

/** Dry run: run the export through the filter without importing anything. */
function countDroppedChanges(repoDir: string, marksOld: string): Promise<number> {
  const filter = new ExportFilter()
  const exporter = spawn('git', [
    'fast-export', '--all',
    '--signed-tags=strip',
    '--tag-of-filtered-object=rewrite',
    '--reencode=no',
    `--export-marks=${marksOld}`,
  ], { cwd: repoDir, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] })
  filter.resume()
  exporter.stdout?.pipe(filter)
  return new Promise((resolve) => {
    const done = () => resolve(filter.dropped)
    exporter.on('error', done)
    exporter.on('close', done)
    filter.on('end', done)
  })
}

/**
 * Repair one checkpoint repo. Safe to run on every boot: gated on an idle repo,
 * free disk, and a marker that makes the second run a no-op.
 *
 * Never throws — a repo that cannot be repaired is logged and retried next boot.
 */
export async function repairCheckpointRepo(
  repoDir: string,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const log = opts.logger ?? console
  const dryRun = opts.dryRun ?? process.env.SHOGO_CHECKPOINT_REPAIR === 'dry'
  const result: RepairResult = {
    repoDir,
    skipped: true,
    bytesBefore: 0,
    bytesAfter: 0,
    untracked: 0,
    rewritten: 0,
    lfsVersionsBefore: 0,
    lfsVersionsAfter: 0,
    dryRun,
  }

  const gitDir = resolveGitDir(repoDir)
  if (!gitDir) {
    return { ...result, reason: 'not-a-repo' }
  }

  try {
    const lfsDir = join(gitDir, 'lfs')
    result.bytesBefore = directorySizeBytes(lfsDir)
    result.lfsVersionsBefore = await countLfsVersions(repoDir)

    const marker = readRepairMarker(repoDir)
    if (marker && Number(marker.version) === MARKER_VERSION) {
      return { ...result, skipped: false, reason: 'already-repaired' }
    }

    if (!isRepoIdle(repoDir, log)) {
      return { ...result, reason: 'busy' }
    }

    // Does any commit still carry runtime state? `.shogo/memory-history` is the
    // one subtree that must stay, so it is excluded rather than probed for.
    const probe = await run(repoDir, [
      'rev-list', '--all', '--max-count=1', '--',
      '.shogo', ':(exclude).shogo/memory-history',
      '.tmp', '.shogo-cwd-*',
    ])
    const historyIsClean = probe.exitCode === 0 && probe.stdout.trim().length === 0;

    if (historyIsClean) {
      // Nothing in any commit to drop: the index pass plus a prune is all that is
      // owed, and that needs neither a rewrite nor the disk headroom for one.
      if (!dryRun) {
        const release = acquireRepairLock(repoDir)
        if (!release) return { ...result, reason: 'busy' }
        try {
          evictStaleGitLock(repoDir, 5_000, log)
          ensureShogoExcludes(repoDir, log)
          result.untracked = (await untrackShogoStatePaths(repoDir, { logger: log })).removed
          await reclaim(repoDir, gitDir, log)
          result.bytesAfter = directorySizeBytes(lfsDir)
          result.lfsVersionsAfter = await countLfsVersions(repoDir)
          writeMarker(gitDir, result)
        } finally {
          release()
        }
      }
      return { ...result, skipped: false, reason: 'clean-history' }
    }

    // A rewrite + repack needs room for a second copy of `.git` on the same
    // filesystem. Without that headroom git dies mid-repack and leaves the repo
    // worse than it found it — retry on a later boot instead.
    const factor = opts.freeDiskFactor ?? 1.5
    const repoBytes = directorySizeBytes(gitDir)
    const freeBytes = await freeBytesAt(repoDir)
    if (freeBytes !== null && freeBytes < repoBytes * factor) {
      return {
        ...result,
        reason: `low-disk (free=${Math.round(freeBytes / 1e6)}MB need=${Math.round((repoBytes * factor) / 1e6)}MB)`,
      }
    }

    const release = dryRun ? null : acquireRepairLock(repoDir)
    if (!dryRun && !release) return { ...result, reason: 'busy' }

    try {
      const marksOld = join(gitDir, 'shogo', 'repair-old.marks')
      const marksNew = join(gitDir, 'shogo', 'repair-new.marks')
      mkdirSync(join(gitDir, 'shogo'), { recursive: true })
      const oldSha = await run(repoDir, ['rev-parse', '--verify', 'HEAD'])
      const oldHead = oldSha.exitCode === 0 ? oldSha.stdout.trim() : ''

      // Only a measured, dropped-nothing export is needed for a dry run: stream
      // it through the filter and throw the output away.
      const drops = dryRun
        ? await countDroppedChanges(repoDir, marksOld)
        : 0

      if (dryRun) {
        log.log(
          `[checkpoint-repair] ${repoDir}: would drop ${drops} file change(s), ` +
            `lfs=${(result.bytesBefore / 1e6).toFixed(1)}MB/${result.lfsVersionsBefore} versions (dry run)`,
        )
        return { ...result, skipped: false, reason: `dry-run (would drop ${drops})` }
      }

      // Everything after this point writes to the repo, so the index pass runs
      // first: the rewrite's own `git reset` then lands on an index that already
      // has the runtime paths gone, which keeps the working tree's status
      // byte-identical across the repair.
      evictStaleGitLock(repoDir, 5_000, log)
      ensureShogoExcludes(repoDir, log)
      const { removed } = await untrackShogoStatePaths(repoDir, { logger: log })
      result.untracked = removed

      await backupRepo(repoDir, gitDir, opts.backupDir, log)

      const rewrite = await streamRewrite(repoDir, marksOld, marksNew)
      if (rewrite.error) {
        return { ...result, reason: `rewrite failed: ${rewrite.error.slice(0, 200)}` }
      }
      const dropped = rewrite.dropped

      if (dropped === 0) {
        await reclaim(repoDir, gitDir, log)
        result.bytesAfter = directorySizeBytes(lfsDir)
        result.lfsVersionsAfter = await countLfsVersions(repoDir)
        writeMarker(gitDir, result)
        return { ...result, skipped: false, reason: 'nothing-to-rewrite' }
      }

      // Resync the index to the rewritten HEAD without touching a single file.
      await run(repoDir, ['reset', '-q'])

      const oldMarks = parseMarks(marksOld)
      const newMarks = parseMarks(marksNew)
      const remap = new Map<string, string>()
      for (const [mark, old] of oldMarks) {
        const next = newMarks.get(mark)
        if (next && next !== old) remap.set(old, next)
      }
      result.rewritten = remap.size
      if (opts.onRemap && remap.size > 0) await opts.onRemap(remap)

      const newHead = await run(repoDir, ['rev-parse', '--verify', 'HEAD'])
      const newHeadSha = newHead.exitCode === 0 ? newHead.stdout.trim() : ''
      if (oldHead && newHeadSha && !remap.has(oldHead) && oldHead !== newHeadSha) {
        log.warn(
          `[checkpoint-repair] ${repoDir}: HEAD moved ${oldHead.slice(0, 7)} -> ${newHeadSha.slice(0, 7)} but the remap has no entry for it`,
        )
      }

      await reclaim(repoDir, gitDir, log)
      result.bytesAfter = directorySizeBytes(lfsDir)
      result.lfsVersionsAfter = await countLfsVersions(repoDir)
      writeMarker(gitDir, result)

      log.log(
        `[checkpoint-repair] ${repoDir}: reclaimed ${((result.bytesBefore - result.bytesAfter) / 1e6).toFixed(0)}MB ` +
          `of .git/lfs (${(result.bytesBefore / 1e6).toFixed(1)} -> ${(result.bytesAfter / 1e6).toFixed(1)}MB), ` +
          `${result.lfsVersionsBefore - result.lfsVersionsAfter} of ${result.lfsVersionsBefore} LFS versions dropped, ` +
          `${result.rewritten} commit(s) rewritten, ${result.untracked} path(s) untracked`,
      )
      return { ...result, skipped: false }
    } finally {
      release?.()
    }
  } catch (err: any) {
    log.warn(`[checkpoint-repair] ${repoDir} failed: ${err?.message ?? err}`)
    return { ...result, reason: `error: ${err?.message ?? err}` }
  }
}

/**
 * Keep a bundle of every ref before the rewrite (commits + LFS *pointers*, so it
 * is small), newest one only per repo.
 */
async function backupRepo(
  repoDir: string,
  gitDir: string,
  backupDir: string | undefined,
  log: Logger,
): Promise<void> {
  const dir = backupDir ?? join(gitDir, 'shogo', 'backups')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bundle = join(dir, `pre-repair-${stamp}.bundle`)
  const res = await run(repoDir, ['bundle', 'create', bundle, '--all'])
  if (res.exitCode !== 0) {
    log.warn(`[checkpoint-repair] bundle backup failed in ${repoDir}: ${res.stderr.trim().slice(0, 200)}`)
    return
  }
  // Keep exactly one backup: this runs once per repo ever, and a stale 100 MB
  // bundle is the same problem in a different directory.
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('pre-repair-') && join(dir, entry) !== bundle) {
        rmSync(join(dir, entry), { force: true })
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Drop the reflog (it pins every pre-rewrite commit), repack, then prune LFS
 * objects nothing references. Order matters: `lfs prune` only frees objects whose
 * commits are unreachable, so the reflog has to go first and `gc` has to finish.
 */
async function reclaim(repoDir: string, gitDir: string, log: Logger): Promise<void> {
  const steps: Array<[string, string[]]> = [
    ['reflog expire', ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']],
    ['gc', ['gc', '--prune=now', '--quiet']],
  ]
  for (const [label, args] of steps) {
    const res = await run(repoDir, args)
    if (res.exitCode !== 0) {
      log.warn(`[checkpoint-repair] git ${label} failed in ${repoDir}: ${res.stderr.trim().slice(0, 200)}`)
    }
  }
  if (existsSync(join(gitDir, 'lfs'))) {
    const prune = await run(repoDir, ['lfs', 'prune', '--force'])
    if (prune.exitCode !== 0) {
      log.warn(`[checkpoint-repair] git lfs prune failed in ${repoDir}: ${prune.stderr.trim().slice(0, 200)}`)
    }
  }
  // Leftover temp files from a killed rewrite.
  for (const name of ['repair-old.marks', 'repair-new.marks']) {
    try {
      unlinkSync(join(gitDir, 'shogo', name))
    } catch {
      /* not there */
    }
  }
}

function writeMarker(gitDir: string, result: RepairResult): void {
  const path = markerPath(gitDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: MARKER_VERSION,
          at: new Date().toISOString(),
          bytesBefore: result.bytesBefore,
          bytesAfter: result.bytesAfter,
          lfsVersionsBefore: result.lfsVersionsBefore,
          lfsVersionsAfter: result.lfsVersionsAfter,
          rewritten: result.rewritten,
          untracked: result.untracked,
        },
        null,
        2,
      ) + '\n',
    )
    renameSync(tmp, path)
  } catch {
    /* a marker we cannot write only costs one extra pass next boot */
  }
}
