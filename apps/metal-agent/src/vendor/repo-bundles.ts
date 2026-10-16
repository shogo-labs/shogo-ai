// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Incremental durable `.git`: a manifest plus immutable git bundles.
 *
 * The durable repo used to be one `repo.git.tar.gz` re-uploaded in full on
 * every commit. A multi-hundred-MB repo that commits every couple of minutes
 * therefore moved gigabytes a day for a few kilobytes of new history. Here the
 * repo is stored as a chain of content-addressed `git bundle` files, each
 * holding only the objects the previous chain did not already cover, plus a
 * small manifest that is the single lineage object (refs, HEAD, `.git/config`,
 * and the ordered bundle list).
 *
 * Invariant: after applying bundles `0..k` in order, the repo contains exactly
 * the closure of the objects reachable from the tips the manifest recorded at
 * step `k`. Refs, HEAD and config are always taken from the manifest, never
 * from bundle headers, so a bundle is only an object transport.
 *
 * Nothing here talks to object storage. Callers own transport and the
 * conditional manifest write; this module owns the format and git.
 */

import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from './child-process'

/** Bumped only for incompatible changes. Readers reject unknown versions. */
export const REPO_MANIFEST_VERSION = 1

/** Object name of the manifest, relative to a project's prefix. */
export const REPO_MANIFEST_NAME = 'repo/manifest.json'

/** One immutable bundle in the chain. `kind: 'base'` is always first and only first. */
export interface RepoManifestBundle {
  sha256: string
  bytes: number
  kind: 'base' | 'incr'
}

export interface RepoManifestRetired {
  sha256: string
  at: number
}

export interface RepoManifest {
  v: typeof REPO_MANIFEST_VERSION
  /** HEAD: a symbolic ref (`{ ref }`) or a detached commit (`{ sha }`). */
  head: { ref: string } | { sha: string }
  /** Every ref to restore, name to object id (tag objects are not peeled). */
  refs: Record<string, string>
  /** `.git/config` verbatim. Carries the LFS settings, so it must survive. */
  config: string
  /** Epoch ms of the repo's earliest root commit, or null if not reported. */
  rootCommitAt: number | null
  bundles: RepoManifestBundle[]
  /** Bundles no longer referenced by this manifest, awaiting delayed deletion. */
  retired?: RepoManifestRetired[]
}

/** Thrown when a manifest or bundle is malformed, mismatched or unreadable. */
export class RepoBundleError extends Error {}

const HEX_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const HEX_SHA256 = /^[0-9a-f]{64}$/

export function bundleObjectName(sha256: string): string {
  return `repo/bundles/${sha256}.bundle`
}

/**
 * Parse and validate an untrusted manifest. Anything unexpected throws, so a
 * reader never guesses at a lineage it does not understand.
 */
export function parseRepoManifest(raw: unknown): RepoManifest {
  if (!raw || typeof raw !== 'object') throw new RepoBundleError('manifest is not an object')
  const m = raw as Record<string, unknown>
  if (m.v !== REPO_MANIFEST_VERSION) throw new RepoBundleError(`unsupported manifest version ${String(m.v)}`)

  const head = m.head as Record<string, unknown> | undefined
  if (!head || typeof head !== 'object') throw new RepoBundleError('manifest.head missing')
  if (typeof head.ref === 'string' && head.ref.startsWith('refs/')) {
    // ok: symbolic HEAD
  } else if (typeof head.sha === 'string' && HEX_SHA.test(head.sha)) {
    // ok: detached HEAD
  } else {
    throw new RepoBundleError('manifest.head must be { ref: "refs/..." } or { sha }')
  }

  if (!m.refs || typeof m.refs !== 'object' || Array.isArray(m.refs)) {
    throw new RepoBundleError('manifest.refs must be an object')
  }
  const refs: Record<string, string> = {}
  for (const [name, sha] of Object.entries(m.refs as Record<string, unknown>)) {
    if (!name.startsWith('refs/')) throw new RepoBundleError(`ref ${name} is outside refs/`)
    if (typeof sha !== 'string' || !HEX_SHA.test(sha)) throw new RepoBundleError(`ref ${name} has no object id`)
    refs[name] = sha
  }

  if (typeof m.config !== 'string') throw new RepoBundleError('manifest.config must be a string')
  if (m.rootCommitAt !== null && (typeof m.rootCommitAt !== 'number' || !Number.isFinite(m.rootCommitAt))) {
    throw new RepoBundleError('manifest.rootCommitAt must be a number or null')
  }

  if (!Array.isArray(m.bundles)) throw new RepoBundleError('manifest.bundles must be an array')
  const bundles: RepoManifestBundle[] = m.bundles.map((b, i) => {
    const e = b as Record<string, unknown>
    if (typeof e?.sha256 !== 'string' || !HEX_SHA256.test(e.sha256)) {
      throw new RepoBundleError(`bundle ${i} has no sha256`)
    }
    if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes < 0) {
      throw new RepoBundleError(`bundle ${i} has no size`)
    }
    if (e.kind !== (i === 0 ? 'base' : 'incr')) {
      throw new RepoBundleError(`bundle ${i} must be ${i === 0 ? 'base' : 'incr'}`)
    }
    return { sha256: e.sha256, bytes: e.bytes, kind: i === 0 ? 'base' : 'incr' }
  })
  if (Object.keys(refs).length > 0 && bundles.length === 0) {
    throw new RepoBundleError('manifest has refs but no bundles')
  }

  let retired: RepoManifestRetired[] | undefined
  if (m.retired !== undefined) {
    if (!Array.isArray(m.retired)) throw new RepoBundleError('manifest.retired must be an array')
    retired = m.retired.map((r) => {
      const e = r as Record<string, unknown>
      if (typeof e?.sha256 !== 'string' || !HEX_SHA256.test(e.sha256) || typeof e.at !== 'number') {
        throw new RepoBundleError('manifest.retired entry is malformed')
      }
      return { sha256: e.sha256, at: e.at }
    })
  }

  return {
    v: REPO_MANIFEST_VERSION,
    head: 'ref' in head ? { ref: head.ref as string } : { sha: head.sha as string },
    refs,
    config: m.config,
    rootCommitAt: (m.rootCommitAt as number | null) ?? null,
    bundles,
    ...(retired ? { retired } : {}),
  }
}

/** Start a fresh full base once the chain grows past this many bundles. */
export const REPO_COMPACT_MAX_BUNDLES = 50

/** ...or once the incrementals together exceed this share of the base. */
export const REPO_COMPACT_INCR_RATIO = 0.25

/**
 * Whether the next export should be a full base. Restores replay the whole
 * chain, so a long chain makes every cold boot slower and more fragile. A
 * compaction costs one base upload and retires the old chain for GC.
 */
export function needsCompaction(chain: RepoManifestBundle[]): boolean {
  if (chain.length <= 1) return false
  if (chain.length > REPO_COMPACT_MAX_BUNDLES) return true
  const base = chain[0].bytes
  const incr = chain.slice(1).reduce((n, b) => n + b.bytes, 0)
  return base > 0 ? incr > base * REPO_COMPACT_INCR_RATIO : incr > 0
}

/**
 * The chain a new manifest records after one export. A base restarts it (full
 * export, or history rewritten under the old tips). An incremental extends the
 * previous chain. No bundle means the chain is unchanged, because only refs moved.
 */
export function nextBundleChain(
  previous: RepoManifestBundle[] | null,
  exported: RepoManifestBundle | null,
): RepoManifestBundle[] {
  if (exported?.kind === 'base') return [exported]
  if (exported) return [...(previous ?? []), exported]
  return previous ?? []
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => { stdout += String(c) })
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin?.end(input ?? '')
  })
}

async function gitOk(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await git(cwd, args, input)
  if (r.code !== 0) {
    throw new RepoBundleError(`git ${args[0]} exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`)
  }
  return r.stdout
}

/** Which of these object ids exist in the repo. */
async function presentObjects(dir: string, shas: string[]): Promise<Set<string>> {
  const present = new Set<string>()
  if (shas.length === 0) return present
  const out = await gitOk(dir, ['cat-file', '--batch-check'], shas.join('\n') + '\n')
  for (const line of out.split('\n')) {
    const [sha, type] = line.trim().split(' ')
    if (sha && type && type !== 'missing') present.add(sha)
  }
  return present
}

/** Commit ids that the given object ids peel to. Non-commit tags are skipped. */
async function peelToCommits(dir: string, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return []
  const out = await gitOk(dir, ['cat-file', '--batch-check'], shas.map((s) => `${s}^{commit}`).join('\n') + '\n')
  const commits = new Set<string>()
  for (const line of out.split('\n')) {
    const [sha, type] = line.trim().split(' ')
    if (sha && type === 'commit') commits.add(sha)
  }
  return [...commits]
}

export interface RepoSnapshotFields {
  head: RepoManifest['head']
  refs: Record<string, string>
  config: string
}

/**
 * Read the parts of `<dir>/.git` the manifest records. Refs come from
 * `for-each-ref`, so every ref the repo holds is included, not only branches.
 */
export async function readRepoSnapshotFields(dir: string): Promise<RepoSnapshotFields> {
  const gitDir = join(dir, '.git')
  const symbolic = await git(dir, ['symbolic-ref', '-q', 'HEAD'])
  let head: RepoManifest['head']
  if (symbolic.code === 0 && symbolic.stdout.trim()) {
    head = { ref: symbolic.stdout.trim() }
  } else {
    head = { sha: (await gitOk(dir, ['rev-parse', '--verify', 'HEAD'])).trim() }
  }

  const refs: Record<string, string> = {}
  const listing = await gitOk(dir, ['for-each-ref', '--format=%(objectname) %(refname)'])
  for (const line of listing.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp <= 0) continue
    refs[line.slice(sp + 1)] = line.slice(0, sp)
  }

  const configPath = join(gitDir, 'config')
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  return { head, refs, config }
}

// ---------------------------------------------------------------------------
// export: build the next bundle
// ---------------------------------------------------------------------------

export interface BuiltBundle {
  /** Path to the bundle file the caller must upload, then delete. */
  path: string
  entry: RepoManifestBundle
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/**
 * Build the next bundle for a repo whose manifest recorded `previous` tips.
 *
 * - No previous manifest (or `previous` is null): a full base of `--all`.
 * - Any previous tip the repo no longer holds (history rewritten, or the guest
 *   was reset): a full base, so the chain restarts. Restoring from a base
 *   needs no prerequisites, so this is always safe.
 * - Otherwise an incremental `--all --not <previous tips>`.
 * - Nothing new to send: returns `null`. The caller still writes the manifest,
 *   because refs can move without any new objects (a branch pointing back at
 *   an old commit, or a deleted branch).
 *
 * `workDir` holds the temporary bundle file and is the caller's to clean up.
 */
export async function buildRepoBundle(
  dir: string,
  opts: { previous: string[] | null; workDir: string },
): Promise<BuiltBundle | null> {
  const refs = await gitOk(dir, ['for-each-ref', '--format=%(objectname)'])
  if (!refs.trim()) return null

  mkdirSync(opts.workDir, { recursive: true })
  const previous = [...new Set(opts.previous ?? [])]
  const havePrevious = previous.length > 0 && (await presentObjects(dir, previous)).size === previous.length
  const prereqs = havePrevious ? await peelToCommits(dir, previous) : []
  const incremental = prereqs.length > 0
  if (incremental) {
    // Nothing new reachable from the current refs: no bundle needed.
    const counted = await gitOk(dir, ['rev-list', '--objects', '--all', '--not', ...prereqs])
    if (!counted.trim()) return null
  }

  const tmp = join(opts.workDir, `bundle-${process.pid}-${Date.now()}.bundle`)
  const args = ['bundle', 'create', tmp, '--all']
  if (incremental) args.push('--not', ...prereqs)
  const made = await git(dir, args)
  if (made.code !== 0) {
    if (/empty bundle/i.test(made.stderr)) return null
    throw new RepoBundleError(`git bundle create exited ${made.code}: ${made.stderr.trim().slice(0, 500)}`)
  }

  const sha256 = await sha256File(tmp)
  const bytes = statSync(tmp).size
  // Content-addressed: the final name is the digest, so re-uploading identical
  // bytes lands on the same object and is harmless.
  const path = join(opts.workDir, `${sha256}.bundle`)
  rmSync(path, { force: true })
  // Same directory, so this is an atomic rename.
  renameSync(tmp, path)
  return { path, entry: { sha256, bytes, kind: incremental ? 'incr' : 'base' } }
}

// ---------------------------------------------------------------------------
// restore: materialize a repo from a manifest
// ---------------------------------------------------------------------------

/**
 * Rebuild `<stagingDir>/.git` from a manifest. `fetchBundle` resolves each
 * bundle to a local file (download, or a local copy). Every bundle's sha256
 * and size are checked before git reads it, so a corrupt or substituted file
 * fails here rather than producing a silently wrong repo.
 *
 * On any failure this throws and leaves `<stagingDir>` for the caller to
 * remove. Nothing is trusted until the final connectivity check passes.
 */
export async function materializeRepoFromBundles(
  stagingDir: string,
  manifest: RepoManifest,
  fetchBundle: (entry: RepoManifestBundle) => Promise<string>,
): Promise<void> {
  mkdirSync(stagingDir, { recursive: true })
  await gitOk(stagingDir, ['init', '-q', '.'])

  for (const entry of manifest.bundles) {
    const path = await fetchBundle(entry)
    const actual = await sha256File(path)
    if (actual !== entry.sha256) {
      throw new RepoBundleError(`bundle ${entry.sha256} failed its checksum (got ${actual})`)
    }
    const size = statSync(path).size
    if (size !== entry.bytes) {
      throw new RepoBundleError(`bundle ${entry.sha256} has ${size} bytes, manifest says ${entry.bytes}`)
    }
    await gitOk(stagingDir, ['bundle', 'verify', path])
    // Fetch into a private namespace; the real refs are written from the manifest below.
    await gitOk(stagingDir, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', path, '+refs/*:refs/shogo-import/*'])
  }

  const updates = Object.entries(manifest.refs).map(([name, sha]) => `update ${name} ${sha}`)
  if (updates.length) {
    await gitOk(stagingDir, ['update-ref', '--stdin'], updates.join('\n') + '\n')
  }
  if ('ref' in manifest.head) {
    await gitOk(stagingDir, ['symbolic-ref', 'HEAD', manifest.head.ref])
  } else {
    await gitOk(stagingDir, ['update-ref', '--no-deref', 'HEAD', manifest.head.sha])
  }

  const imported = (await gitOk(stagingDir, ['for-each-ref', '--format=%(refname)', 'refs/shogo-import/'])).split('\n').filter(Boolean)
  if (imported.length) {
    await gitOk(stagingDir, ['update-ref', '--stdin'], imported.map((r) => `delete ${r}`).join('\n') + '\n')
  }

  writeFileSync(join(stagingDir, '.git', 'config'), manifest.config)

  // Every manifest ref must now point where the manifest says, and everything
  // they reach must exist. Anything else is a broken chain.
  const check = await readRepoSnapshotFields(stagingDir)
  for (const [name, sha] of Object.entries(manifest.refs)) {
    if (check.refs[name] !== sha) {
      throw new RepoBundleError(`ref ${name} restored as ${check.refs[name] ?? 'nothing'}, expected ${sha}`)
    }
  }
  const fsck = await git(stagingDir, ['fsck', '--connectivity-only', '--no-dangling', '--no-progress'])
  if (fsck.code !== 0) {
    throw new RepoBundleError(`restored repo failed fsck: ${fsck.stderr.trim().slice(0, 500)}`)
  }
}
