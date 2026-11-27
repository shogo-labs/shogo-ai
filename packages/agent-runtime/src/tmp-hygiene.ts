// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `.tmp` hygiene (SHO-607).
 *
 * Dev and QA agents check out a full `shogo-ai` worktree per card under
 * `<project>/.tmp/<name>` (often with its own `node_modules`) and nothing ever
 * removes them — QA's project folder had grown to 3.7 M files across 107
 * worktrees. This module is the one place that decides what in a `.tmp` is
 * disposable:
 *
 *   - **worktrees** are matched to cards by *branch* or *PR head SHA*, never by
 *     folder name (names don't follow `.tmp/<card>`; many are detached HEADs
 *     or standalone clones);
 *   - a squash-merged branch is never in `origin/main` and `origin/<branch>`
 *     is pruned, so "pushed" also accepts `HEAD === the closed PR's headSha`;
 *   - anything **open** is untouchable, anything **recent**, **dirty** or
 *     **unpushed** is kept and reported so the card can say why;
 *   - everything outside the in-scope `.tmp` dirs is left alone: no
 *     folder-linked project, no symlink out of `.tmp`.
 *
 * `.tmp` is scratch by contract — it is not backed up and a cloud recycle
 * drops it (SHO-399) — so old loose files and old non-git dirs there are
 * removed on the same pass.
 *
 * Every git call is an async `spawn` and every fs call is `fs/promises`: the
 * sweep runs while someone is waiting on this runtime, and a synchronous walk
 * of a million files is exactly what made the desktop slow in the first place.
 */

import { spawn } from '@shogo/shared-runtime/child-process'
import { existsSync } from 'fs'
import { readdir, realpath, rm, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'

/** Default age before loose scratch files and dirs are removed. */
export const TMP_SCRATCH_MAX_AGE_DAYS = 3

/** A worktree touched this recently may still belong to an in-flight agent. */
export const TMP_RECENT_WINDOW_MS = 15 * 60_000

const GIT_TIMEOUT_MS = 30_000
const DU_TIMEOUT_MS = 5_000
/** Entries one loose-dir age check may read before giving up (keeps the dir). */
const LOOSE_WALK_CAP = 20_000

type Logger = Pick<Console, 'log' | 'warn'>

export interface CardPrRef {
  number: number
  headRef: string | null
  headSha: string | null
  state?: 'open' | 'closed'
  merged?: boolean
}

export interface CardBranchRef {
  key: string
  number: number
  branch: string | null
  prs: CardPrRef[]
}

/** What the API reports about every card's branches (SHO-607 §2). */
export interface CardBranchIndex {
  open: CardBranchRef[]
  closed: CardBranchRef[]
}

export interface RemovedTmpWorktree {
  path: string
  branch: string | null
  bytes: number | null
  card: string | null
}

export interface KeptTmpWorktree {
  path: string
  branch: string | null
  reason: string
  card: string | null
}

export interface DeferredTmpWorktree {
  path: string
  branch: string | null
  reason: string
}

export interface LooseScratchTally {
  files: number
  dirs: number
  bytes: number
}

export interface TmpHygieneReport {
  removed: RemovedTmpWorktree[]
  kept: KeptTmpWorktree[]
  deferred: DeferredTmpWorktree[]
  loose: LooseScratchTally
  errors: string[]
}

export interface TmpHygieneOptions {
  /** Project dirs whose `.tmp` is in scope. */
  roots: string[]
  /**
   * Open/closed cards. Absent or `null` (the call failed) means the worktree
   * half is skipped — fail closed — while loose scratch is still removed.
   */
  loadCardBranches?: () => Promise<CardBranchIndex | null>
  /** A card being pruned right now, merged into `closed` without an API call. */
  closingCard?: CardBranchRef
  /** Only prune worktrees that match this card (the close hook). */
  onlyCardKey?: string
  now?: () => number
  scratchMaxAgeDays?: number
  recentWindowMs?: number
  dryRun?: boolean
  logger?: Logger
  /**
   * Explicit worktrees registered outside any in-scope `.tmp`. Only the
   * one-time cleanup passes this; the runtime never does.
   */
  extraWorktrees?: Array<{ repoDir: string; path: string }>
}

interface Candidate {
  path: string
  repoDir: string
  kind: 'worktree' | 'clone'
  branch: string | null
  headSha: string | null
  detached: boolean
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command and resolve with its output, never throwing. */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    }
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(-1)
    }, timeoutMs)
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}

const runGit = (args: string[], cwd: string) => runCommand('git', args, cwd, GIT_TIMEOUT_MS)

async function realpathSafe(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function statSafe(path: string): Promise<{ mtimeMs: number; size: number; isDirectory: boolean } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() }
  } catch {
    return null
  }
}

/** True when `child` is strictly inside `parent` (both resolved). */
export function isInsideDir(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The project dirs whose `.tmp` this runtime may clean.
 *
 * Never a folder-linked project: those are the user's own checkouts. Never an
 * unanchored merged root with no members.
 */
export function tmpHygieneRoots(input: {
  workspaceDir: string
  workingMode: 'managed' | 'external'
  isWorkspaceRuntime: boolean
  projectIds: string[]
  mounts: Array<{ mount: string; projectId: string; kind: 'managed' | 'external' | 'folder' }>
}): string[] {
  const { workspaceDir, workingMode, isWorkspaceRuntime, projectIds, mounts } = input
  if (workingMode === 'external') return []
  if (!isWorkspaceRuntime) return [resolve(workspaceDir)]
  const byProject = new Map(mounts.map((m) => [m.projectId, m]))
  const roots: string[] = [resolve(workspaceDir)]
  for (const projectId of projectIds) {
    const mount = byProject.get(projectId)
    if (mount && (mount.kind === 'external' || mount.kind === 'folder')) continue
    roots.push(resolve(join(workspaceDir, mount?.mount ?? projectId)))
  }
  return [...new Set(roots)]
}

interface PorcelainEntry {
  path: string
  headSha: string | null
  branch: string | null
  detached: boolean
}

/** Parse `git worktree list --porcelain`. */
export function parseWorktreePorcelain(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  let current: Partial<PorcelainEntry> | null = null
  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        headSha: current.headSha ?? null,
        branch: current.branch ?? null,
        detached: current.detached === true,
      })
    }
    current = null
  }
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) {
      flush()
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: value }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) {
      current.headSha = value || null
    } else if (line.startsWith('branch ')) {
      current.branch = value.replace(/^refs\/heads\//, '') || null
    } else if (line === 'detached') {
      current.detached = true
    }
  }
  flush()
  return entries
}

/**
 * Worktree candidates inside the in-scope `.tmp` dirs, plus standalone clones
 * (a `.tmp/<dir>` with its own `.git`). Symlinks are never followed.
 */
async function discoverCandidates(roots: string[], logger: Logger): Promise<Candidate[]> {
  const seenReal = new Set<string>()
  const seenTmp = new Set<string>()
  const out: Candidate[] = []

  for (const root of roots) {
    const tmpReal = await realpathSafe(join(root, '.tmp'))
    if (!tmpReal || seenTmp.has(tmpReal)) continue
    seenTmp.add(tmpReal)
    const tmpStat = await statSafe(tmpReal)
    if (!tmpStat?.isDirectory) continue

    if (existsSync(join(root, '.git'))) {
      // Drop registrations whose directory is already gone before listing.
      await runGit(['worktree', 'prune'], root)
      const listed = await runGit(['worktree', 'list', '--porcelain'], root)
      if (listed.code !== 0) {
        logger.warn(`[tmp-hygiene] git worktree list failed in ${root}: ${listed.stderr.trim()}`)
      } else {
        for (const entry of parseWorktreePorcelain(listed.stdout)) {
          const abs = resolve(entry.path)
          const real = await realpathSafe(abs)
          // A registered worktree whose realpath is outside `.tmp` (a symlink
          // out, or a sibling checkout) is out of scope.
          if (!isInsideDir(real ?? abs, tmpReal)) continue
          if (seenReal.has(abs)) continue
          seenReal.add(abs)
          out.push({
            path: abs,
            repoDir: resolve(root),
            kind: 'worktree',
            branch: entry.branch,
            headSha: entry.headSha,
            detached: entry.detached,
          })
        }
      }
    }

    let entries
    try {
      entries = await readdir(tmpReal, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidatePath = join(tmpReal, entry.name)
      if (seenReal.has(candidatePath)) continue
      if (!existsSync(join(candidatePath, '.git'))) continue
      const head = await runGit(['rev-parse', 'HEAD'], candidatePath)
      if (head.code !== 0) continue
      const ref = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], candidatePath)
      const refName = ref.stdout.trim()
      const detached = ref.code !== 0 || refName === 'HEAD'
      seenReal.add(candidatePath)
      out.push({
        path: candidatePath,
        repoDir: candidatePath,
        kind: 'clone',
        branch: detached ? null : refName || null,
        headSha: head.stdout.trim() || null,
        detached,
      })
    }
  }

  return out
}

/** The git dir that holds a worktree's index and reflog. */
async function worktreeGitDir(candidate: Candidate): Promise<string | null> {
  const res = await runGit(['rev-parse', '--absolute-git-dir'], candidate.path)
  const dir = res.stdout.trim()
  return res.code === 0 && dir ? dir : null
}

/** When this worktree was last touched (index / HEAD reflog mtime). */
async function lastWorktreeActivity(candidate: Candidate): Promise<number> {
  const gitDir = candidate.kind === 'worktree'
    ? await worktreeGitDir(candidate)
    : join(candidate.path, '.git')
  if (!gitDir) return 0
  let latest = 0
  for (const path of [join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD'), join(gitDir, 'HEAD')]) {
    const s = await statSafe(path)
    if (s && s.mtimeMs > latest) latest = s.mtimeMs
  }
  return latest
}

/** Size in bytes, or null when it cannot be measured in time. */
async function measureBytes(path: string): Promise<number | null> {
  if (process.platform === 'win32') return null
  const res = await runCommand('du', ['-sk', path], process.cwd(), DU_TIMEOUT_MS)
  if (res.code !== 0) return null
  const match = /^(\d+)/.exec(res.stdout.trim())
  return match ? Number(match[1]) * 1024 : null
}

interface InstalledIndex {
  openBranches: Set<string>
  openHeads: Set<string>
  openPrBranches: Set<string>
  closedHeads: Set<string>
  labelByRef: Map<string, string>
}

function buildIndex(index: CardBranchIndex): InstalledIndex {
  const openBranches = new Set<string>()
  const openHeads = new Set<string>()
  const openPrBranches = new Set<string>()
  const closedHeads = new Set<string>()
  const labelByRef = new Map<string, string>()
  for (const card of index.open) {
    if (card.branch) {
      openBranches.add(card.branch)
      labelByRef.set(`branch:${card.branch}`, card.key)
    }
    for (const pr of card.prs) {
      if (pr.headSha) {
        openHeads.add(pr.headSha)
        labelByRef.set(`head:${pr.headSha}`, card.key)
      }
      if (pr.headRef) {
        openPrBranches.add(pr.headRef)
        labelByRef.set(`branch:${pr.headRef}`, card.key)
      }
    }
  }
  for (const card of index.closed) {
    if (card.branch) labelByRef.set(`branch:${card.branch}`, card.key)
    for (const pr of card.prs) {
      if (pr.headSha) {
        closedHeads.add(pr.headSha)
        labelByRef.set(`head:${pr.headSha}`, card.key)
      }
      if (pr.headRef) labelByRef.set(`branch:${pr.headRef}`, card.key)
    }
  }
  return { openBranches, openHeads, openPrBranches, closedHeads, labelByRef }
}

function cardLabelFor(installed: InstalledIndex, candidate: Candidate): string | null {
  if (candidate.branch) {
    const byBranch = installed.labelByRef.get(`branch:${candidate.branch}`)
    if (byBranch) return byBranch
  }
  if (candidate.headSha) {
    return installed.labelByRef.get(`head:${candidate.headSha}`) ?? null
  }
  return null
}

/** True when this worktree belongs to an open card (branch, or a detached PR head). */
function matchesOpenCard(installed: InstalledIndex, candidate: Candidate): boolean {
  if (candidate.branch && (installed.openBranches.has(candidate.branch) || installed.openPrBranches.has(candidate.branch))) {
    return true
  }
  // A head SHA only names a worktree when nothing else does: several cards'
  // checkouts can sit on the same commit, and matching by sha for a branch
  // worktree would pin an unrelated card's checkout forever.
  return candidate.detached && !!candidate.headSha && installed.openHeads.has(candidate.headSha)
}

function matchesCard(card: CardBranchRef, candidate: Candidate): boolean {
  const refs = new Set<string>()
  if (card.branch) refs.add(card.branch)
  for (const pr of card.prs) {
    if (pr.headRef) refs.add(pr.headRef)
  }
  if (candidate.branch && refs.has(candidate.branch)) return true
  if (candidate.detached && candidate.headSha) {
    return card.prs.some((pr) => pr.headSha === candidate.headSha)
  }
  return false
}

type Verdict =
  | { kind: 'open' }
  | { kind: 'remove' }
  | { kind: 'keep'; reason: string }
  | { kind: 'defer'; reason: string }

async function classify(candidate: Candidate, installed: InstalledIndex, opts: {
  nowMs: number
  recentWindowMs: number
}): Promise<Verdict> {
  if (matchesOpenCard(installed, candidate)) return { kind: 'open' }

  const touchedAt = await lastWorktreeActivity(candidate)
  if (touchedAt && opts.nowMs - touchedAt < opts.recentWindowMs) {
    return { kind: 'defer', reason: 'touched in the last 15 min' }
  }

  const status = await runGit(['status', '--porcelain'], candidate.path)
  if (status.code !== 0) {
    return { kind: 'keep', reason: 'git status failed' }
  }
  if (status.stdout.trim()) {
    const files = status.stdout.trim().split('\n').length
    return { kind: 'keep', reason: `uncommitted changes (${files} file${files === 1 ? '' : 's'})` }
  }

  // A squash-merged branch is never in `origin/main`, and `fetch --prune`
  // drops `origin/<branch>` — so the merged/closed PR's last head is proof the
  // work landed.
  if (candidate.headSha && installed.closedHeads.has(candidate.headSha)) {
    return { kind: 'remove' }
  }

  const ahead = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], candidate.path)
  const count = Number(ahead.stdout.trim())
  if (ahead.code !== 0 || !Number.isFinite(count)) {
    return { kind: 'keep', reason: 'could not read unpushed commits' }
  }
  if (count > 0) {
    const where = candidate.branch ?? 'a detached HEAD'
    return { kind: 'keep', reason: `${count} unpushed commit${count === 1 ? '' : 's'} on ${where}` }
  }
  return { kind: 'remove' }
}

async function deleteBranchIfSafe(candidate: Candidate, logger: Logger): Promise<void> {
  const branch = candidate.branch
  if (!branch || branch === 'main' || branch === 'master') return
  const current = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], candidate.repoDir)
  if (current.code === 0 && current.stdout.trim() === branch) return
  const res = await runGit(['branch', '-D', branch], candidate.repoDir)
  if (res.code !== 0) {
    logger.warn(`[tmp-hygiene] could not delete branch ${branch}: ${res.stderr.trim()}`)
  }
}

async function removeCandidate(candidate: Candidate, logger: Logger): Promise<number | null> {
  const bytes = await measureBytes(candidate.path)
  if (candidate.kind === 'worktree') {
    const removed = await runGit(['worktree', 'remove', '--force', candidate.path], candidate.repoDir)
    // A worktree with a stale lock or an ignored `node_modules` can refuse;
    // the path is verified inside `.tmp` at discovery, so finish the job.
    if (removed.code !== 0 && existsSync(candidate.path)) {
      await rm(candidate.path, { recursive: true, force: true })
    }
    await runGit(['worktree', 'prune'], candidate.repoDir)
    await deleteBranchIfSafe(candidate, logger)
  } else if (existsSync(candidate.path)) {
    await rm(candidate.path, { recursive: true, force: true })
  }
  return bytes
}

interface LooseScan {
  old: boolean
  bytes: number
}

/** True when every entry under `dir` is older than the cutoff and none is a repo. */
async function scanLooseDir(dir: string, cutoffMs: number): Promise<LooseScan> {
  let bytes = 0
  let seen = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop() as string
    const dirStat = await statSafe(current)
    if (!dirStat || dirStat.mtimeMs >= cutoffMs) return { old: false, bytes: 0 }
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return { old: false, bytes: 0 }
    }
    for (const entry of entries) {
      if (entry.name === '.git') return { old: false, bytes: 0 }
      if (++seen > LOOSE_WALK_CAP) return { old: false, bytes: 0 }
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      const s = await statSafe(path)
      if (!s) continue
      if (s.mtimeMs >= cutoffMs) return { old: false, bytes: 0 }
      bytes += s.size
    }
  }
  return { old: true, bytes }
}

async function sweepLooseScratch(
  tmpDir: string,
  protectedPaths: Set<string>,
  opts: { cutoffMs: number; dryRun: boolean },
): Promise<LooseScratchTally> {
  const tally: LooseScratchTally = { files: 0, dirs: 0, bytes: 0 }
  let entries
  try {
    entries = await readdir(tmpDir, { withFileTypes: true })
  } catch {
    return tally
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(tmpDir, entry.name)
    if (protectedPaths.has(path)) continue
    if (entry.isFile()) {
      const s = await statSafe(path)
      if (!s || s.mtimeMs >= opts.cutoffMs) continue
      tally.files += 1
      tally.bytes += s.size
      if (!opts.dryRun) await rm(path, { force: true })
      continue
    }
    if (!entry.isDirectory()) continue
    // Never descends into a dir that contains `.git`: that is a repo we do not
    // know how to classify (it would have been a candidate already).
    if (existsSync(join(path, '.git'))) continue
    const scan = await scanLooseDir(path, opts.cutoffMs)
    if (!scan.old) continue
    tally.dirs += 1
    tally.bytes += scan.bytes
    if (!opts.dryRun) await rm(path, { recursive: true, force: true })
  }
  return tally
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function summarize(report: TmpHygieneReport): string {
  const bytes = report.removed.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const loose = report.loose
  const keptDirty = report.kept.filter((k) => k.reason.startsWith('uncommitted')).length
  const keptUnpushed = report.kept.filter((k) => k.reason.includes('unpushed commit')).length
  const keptOther = report.kept.length - keptDirty - keptUnpushed
  const keptParts = [
    keptDirty ? `${keptDirty} dirty` : '',
    keptUnpushed ? `${keptUnpushed} unpushed` : '',
    keptOther ? `${keptOther} other` : '',
  ].filter(Boolean)
  const looseCount = loose.files + loose.dirs
  const removedBytes = bytes + loose.bytes
  return (
    `[tmp-hygiene] removed ${report.removed.length} worktree${report.removed.length === 1 ? '' : 's'} ` +
    `+ ${looseCount} loose file${looseCount === 1 ? '' : 's'} (${formatBytes(removedBytes)}); ` +
    `kept ${report.kept.length}${keptParts.length ? ` (${keptParts.join(', ')})` : ''}; ` +
    `deferred ${report.deferred.length}`
  )
}

function emptyReport(): TmpHygieneReport {
  return { removed: [], kept: [], deferred: [], loose: { files: 0, dirs: 0, bytes: 0 }, errors: [] }
}

/**
 * Remove worktrees and loose scratch inside `opts.roots`' `.tmp` dirs.
 *
 * `opts.onlyCardKey` narrows the worktree half to one card's worktrees (the
 * close hook); without it every closed-card worktree in scope is a candidate.
 */
export async function sweepTmpHygiene(opts: TmpHygieneOptions): Promise<TmpHygieneReport> {
  const logger = opts.logger ?? console
  const nowMs = (opts.now ?? Date.now)()
  const cutoffMs = nowMs - (opts.scratchMaxAgeDays ?? TMP_SCRATCH_MAX_AGE_DAYS) * 24 * 60 * 60_000
  const dryRun = opts.dryRun === true
  const report = emptyReport()

  const reportUsage = () => {
    if (opts.onlyCardKey === undefined) logger.log(summarize(report))
  }

  const index = opts.loadCardBranches ? await opts.loadCardBranches().catch(() => null) : null
  const mergedIndex: CardBranchIndex | null = index
    ? {
        open: index.open,
        closed: opts.closingCard
          ? [...index.closed.filter((c) => c.key !== opts.closingCard?.key), opts.closingCard]
          : index.closed,
      }
    : null

  const candidates = await discoverCandidates(opts.roots, logger)
  for (const extra of opts.extraWorktrees ?? []) {
    const path = resolve(extra.path)
    if (candidates.some((c) => c.path === path)) continue
    const head = await runGit(['rev-parse', 'HEAD'], path)
    if (head.code !== 0) continue
    const ref = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], path)
    const refName = ref.stdout.trim()
    const detached = ref.code !== 0 || refName === 'HEAD'
    candidates.push({
      path,
      repoDir: resolve(extra.repoDir),
      kind: 'worktree',
      branch: detached ? null : refName || null,
      headSha: head.stdout.trim() || null,
      detached,
    })
  }

  if (mergedIndex) {
    const installed = buildIndex(mergedIndex)
    const target = opts.onlyCardKey
      ? mergedIndex.closed.find((c) => c.key === opts.onlyCardKey) ?? null
      : null
    for (const candidate of candidates) {
      if (opts.onlyCardKey !== undefined && !(target && matchesCard(target, candidate))) continue
      const card = cardLabelFor(installed, candidate)
      const verdict = await classify(candidate, installed, {
        nowMs,
        recentWindowMs: opts.recentWindowMs ?? TMP_RECENT_WINDOW_MS,
      })
      if (verdict.kind === 'open') continue
      if (verdict.kind === 'defer') {
        report.deferred.push({ path: candidate.path, branch: candidate.branch, reason: verdict.reason })
        continue
      }
      if (verdict.kind === 'keep') {
        report.kept.push({ path: candidate.path, branch: candidate.branch, reason: verdict.reason, card })
        continue
      }
      const bytes = dryRun ? await measureBytes(candidate.path) : await removeCandidate(candidate, logger)
      report.removed.push({ path: candidate.path, branch: candidate.branch, bytes, card })
    }
  } else {
    report.errors.push('card branches unavailable — skipped worktrees (fail closed)')
    if (opts.onlyCardKey === undefined) {
      logger.warn('[tmp-hygiene] card branch index unavailable; worktrees left alone, loose scratch only')
    }
  }

  // Loose scratch is the sweep's job: the close hook fires in the middle of a
  // card move and must stay a single worktree removal.
  if (opts.onlyCardKey === undefined) {
    const protectedPaths = new Set(candidates.map((c) => c.path))
    for (const root of opts.roots) {
      const tmpReal = await realpathSafe(join(root, '.tmp'))
      if (!tmpReal) continue
      const tally = await sweepLooseScratch(tmpReal, protectedPaths, { cutoffMs, dryRun })
      report.loose.files += tally.files
      report.loose.dirs += tally.dirs
      report.loose.bytes += tally.bytes
    }
  }

  reportUsage()
  return report
}

/**
 * Prune the worktrees of one card that just closed (SHO-607 §3). Kept
 * worktrees come back with a reason so the card can say why it could not
 * clean them up.
 */
export async function pruneClosedCardTmpWorktrees(
  opts: TmpHygieneOptions & { card: CardBranchRef },
): Promise<TmpHygieneReport> {
  return sweepTmpHygiene({ ...opts, closingCard: opts.card, onlyCardKey: opts.card.key })
}
