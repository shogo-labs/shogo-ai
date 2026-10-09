// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Durable, encrypted copy of the agent's HOME directory credentials and tool
 * config (`~/.ssh`, `~/.oci`, `~/.kube`, `~/.config/...`).
 *
 * On a metal guest `HOME=/app`, but only the workspace, the database and `.git`
 * are backed up by the host. A Firecracker snapshot keeps `/app` across a
 * suspend, so the gap only shows on a COLD boot — a rootfs rebuild, a snapshot
 * miss, a resume on another host — where every key and CLI login the agent set
 * up silently disappears. Agents worked around that by copying secrets into
 * the workspace, which put plaintext keys into project archives. This gives
 * them a real place to keep them instead.
 *
 * Shape of the contract:
 *   - Only {@link HOME_STATE_PATHS} are persisted. Anything else outside the
 *     workspace stays ephemeral, on purpose: an allowlist is what keeps this
 *     small and keeps caches and package stores out of it.
 *   - The archive is encrypted HERE, before it leaves the VM, with a key the
 *     API derives per project. The metal host and object storage only ever see
 *     ciphertext. The project id is bound in as associated data, so a blob
 *     cannot be replayed into a different project even by someone holding it.
 *   - Restore REPLACES each persisted unit rather than merging into it, so a
 *     deleted key stays deleted and nothing half-old survives.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Paths under HOME that are persisted. Each must be a single path segment. */
export const HOME_STATE_PATHS = [
  '.ssh',
  '.oci',
  '.kube',
  '.aws',
  '.gnupg',
  '.docker',
  '.netrc',
  '.git-credentials',
  '.gitconfig',
  '.config',
  '.bashrc',
  '.profile',
] as const

/**
 * Persisted paths restored child-by-child instead of as one unit. The image
 * may ship its own entries here, and replacing the whole directory would erase
 * the ones this project never touched.
 */
const PER_CHILD_UNITS = new Set<string>(['.config'])

/** Directory names never persisted, at any depth: caches and browser profiles. */
export const HOME_STATE_EXCLUDED_NAMES = new Set<string>([
  'cache',
  'Cache',
  'Caches',
  'CachedData',
  'Code Cache',
  'GPUCache',
  'Crashpad',
  'logs',
  'chromium',
  'google-chrome',
])

/** Ceilings. Past any of them the export is refused loudly rather than truncated. */
export const HOME_STATE_MAX_ENTRIES = 5000
export const HOME_STATE_MAX_RAW_BYTES = 64 * 1024 * 1024
export const HOME_STATE_MAX_PACKED_BYTES = 16 * 1024 * 1024

const MAGIC = Buffer.from('SHGH', 'ascii')
const FORMAT_VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 2
const KEY_BYTES = 32

/** Prefix of the scratch directory a restore stages into, inside HOME. */
const RESTORE_STAGE_PREFIX = '.shogo-home-restore-'

export class HomeStateTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeStateTooLargeError'
  }
}

export class HomeStateDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeStateDecryptError'
  }
}

export class HomeStateInvalidArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeStateInvalidArchiveError'
  }
}

export interface HomeStateKey {
  key: Buffer
  version: number
}

/** The guest's home directory. `SHOGO_HOME_STATE_DIR` exists for tests. */
export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SHOGO_HOME_STATE_DIR || env.HOME || homedir())
}

/** Parse `HOME_STATE_KEY` (base64, 32 bytes) and its version. Null when absent or malformed. */
export function parseHomeStateKey(env: NodeJS.ProcessEnv = process.env): HomeStateKey | null {
  const raw = env.HOME_STATE_KEY?.trim()
  if (!raw) return null
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) return null
  const version = Number(env.HOME_STATE_KEY_VERSION ?? '1')
  if (!Number.isInteger(version) || version < 1 || version > 255) return null
  return { key, version }
}

// ─── scan ──────────────────────────────────────────────────────────────────

export interface HomeEntry {
  rel: string
  kind: 'dir' | 'file' | 'symlink'
  size: number
  mtimeNs: bigint
  mode: number
  link?: string
}

export interface HomeScan {
  entries: HomeEntry[]
  /** Total size of the regular files. */
  bytes: number
  /** Paths left out (sockets, links leaving HOME, unencodable names). */
  skipped: string[]
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep)
}

/**
 * Walk the persisted paths. Throws {@link HomeStateTooLargeError} past the
 * entry or byte ceiling: a silently truncated archive would restore as a
 * plausible-looking but incomplete home.
 */
export function scanHomeState(homeDir: string): HomeScan {
  const root = resolve(homeDir)
  const entries: HomeEntry[] = []
  const skipped: string[] = []
  let bytes = 0

  const walk = (rel: string, depth: number): void => {
    const abs = join(root, rel)
    let st: ReturnType<typeof lstatSync> & { mtimeNs: bigint; size: bigint; mode: bigint }
    try {
      st = lstatSync(abs, { bigint: true }) as any
    } catch {
      return
    }
    if (rel.includes('\n')) {
      skipped.push(rel.replace(/\n/g, '\\n'))
      return
    }
    if (entries.length >= HOME_STATE_MAX_ENTRIES) {
      throw new HomeStateTooLargeError(`more than ${HOME_STATE_MAX_ENTRIES} entries under the persisted home paths`)
    }
    const base = { rel, mtimeNs: st.mtimeNs, mode: Number(st.mode & 0o7777n) }

    if (st.isSymbolicLink()) {
      const link = readlinkSync(abs)
      if (!isInside(root, resolve(dirname(abs), link))) {
        skipped.push(rel)
        return
      }
      entries.push({ ...base, kind: 'symlink', size: 0, link })
      return
    }
    if (st.isDirectory()) {
      if (depth > 0 && HOME_STATE_EXCLUDED_NAMES.has(basename(rel))) return
      entries.push({ ...base, kind: 'dir', size: 0 })
      let children: string[]
      try {
        children = readdirSync(abs).sort()
      } catch {
        return
      }
      for (const child of children) walk(join(rel, child), depth + 1)
      return
    }
    if (st.isFile()) {
      bytes += Number(st.size)
      if (bytes > HOME_STATE_MAX_RAW_BYTES) {
        throw new HomeStateTooLargeError(`persisted home paths exceed ${HOME_STATE_MAX_RAW_BYTES} bytes`)
      }
      entries.push({ ...base, kind: 'file', size: Number(st.size) })
      return
    }
    skipped.push(rel)
  }

  for (const top of HOME_STATE_PATHS) walk(top, 0)
  return { entries, bytes, skipped }
}

/**
 * Change fingerprint of what {@link packHomeState} would archive, without
 * packing. Null when nothing is persisted. Includes mode so a `chmod 600`
 * alone counts as a change.
 */
export function homeStateTag(scan: HomeScan): string | null {
  if (scan.entries.length === 0) return null
  const h = createHash('sha256')
  for (const e of scan.entries) {
    h.update(`${e.rel}\0${e.kind}\0${e.size}\0${e.mtimeNs}\0${e.mode}\0${e.link ?? ''}\n`)
  }
  return h.digest('hex').slice(0, 32)
}

// ─── pack / restore ────────────────────────────────────────────────────────

/** bsdtar on macOS otherwise adds AppleDouble files and xattr headers GNU tar warns about. */
function platformTarArgs(): string[] {
  return process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
}

async function runTar(args: string[], opts: { capture?: boolean } = {}): Promise<Uint8Array> {
  const proc = Bun.spawn(['tar', ...args], {
    stdout: opts.capture ? 'pipe' : 'ignore',
    stderr: 'pipe',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const [code, out, stderr] = await Promise.all([
    proc.exited,
    opts.capture ? new Response(proc.stdout as ReadableStream).arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  if (code !== 0) throw new Error(`tar exited ${code}: ${stderr.trim().slice(0, 400)}`)
  return new Uint8Array(out)
}

export interface HomeStatePack {
  /** gzipped tar, rooted at HOME. */
  gz: Uint8Array
  tag: string | null
  entries: number
  bytes: number
  skipped: string[]
}

/**
 * Pack the persisted paths into a gzipped tar rooted at HOME. Returns null
 * when there is nothing to persist — distinct from an empty archive, which
 * would be an invitation to overwrite a real one with nothing.
 *
 * Pass the scan the caller already tagged: the tag must describe state at or
 * before what the archive captures, never after.
 */
export async function packHomeState(
  homeDir: string,
  opts: { stageDir: string; scan?: HomeScan },
): Promise<HomeStatePack | null> {
  const scan = opts.scan ?? scanHomeState(homeDir)
  if (scan.entries.length === 0) return null
  const tag = homeStateTag(scan)

  mkdirSync(opts.stageDir, { recursive: true })
  const listPath = join(opts.stageDir, 'home-files.txt')
  writeFileSync(listPath, scan.entries.map((e) => e.rel).join('\n') + '\n')

  // Entries are listed explicitly (directories included, for their modes), so
  // tar must not also recurse into them. Every name starts with a persisted
  // path, which begins with '.', so none can be read as an option. Written to
  // a file, not stdout: bsdtar pads piped output to a 10 KiB record, which
  // would multiply a few-hundred-byte archive by twenty.
  const outPath = join(opts.stageDir, 'home.tar.gz')
  await runTar(['-czf', outPath, ...platformTarArgs(), '--no-recursion', '-C', resolve(homeDir), '-T', listPath])
  const gz = new Uint8Array(readFileSync(outPath))
  if (gz.byteLength > HOME_STATE_MAX_PACKED_BYTES) {
    throw new HomeStateTooLargeError(
      `packed home state is ${gz.byteLength} bytes, over the ${HOME_STATE_MAX_PACKED_BYTES}-byte limit`,
    )
  }
  return { gz, tag, entries: scan.entries.length, bytes: scan.bytes, skipped: scan.skipped }
}

/** Reject any archive member that is not a relative path under a persisted root. */
export function validateArchiveNames(names: string[]): void {
  const allowed = new Set<string>(HOME_STATE_PATHS)
  for (const raw of names) {
    const name = raw.replace(/^\.\//, '').replace(/\/+$/, '')
    if (!name || name === '.') continue
    if (name.startsWith('/')) throw new HomeStateInvalidArchiveError(`absolute path in home archive: ${name}`)
    const parts = name.split('/')
    if (parts.includes('..')) throw new HomeStateInvalidArchiveError(`path traversal in home archive: ${name}`)
    if (!allowed.has(parts[0])) throw new HomeStateInvalidArchiveError(`non-persisted path in home archive: ${name}`)
  }
}

/**
 * Walk an extracted tree: only directories, regular files and symlinks that
 * stay inside HOME (judged from where they will LAND) are acceptable.
 */
function validateExtractedTree(treeRoot: string, homeDir: string): void {
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop() as string
    const abs = join(treeRoot, rel)
    for (const name of readdirSync(abs)) {
      const childRel = rel ? join(rel, name) : name
      const childAbs = join(treeRoot, childRel)
      const st = lstatSync(childAbs)
      if (st.isDirectory()) {
        stack.push(childRel)
      } else if (st.isSymbolicLink()) {
        const landed = join(homeDir, childRel)
        if (!isInside(homeDir, resolve(dirname(landed), readlinkSync(childAbs)))) {
          throw new HomeStateInvalidArchiveError(`symlink leaving HOME in home archive: ${childRel}`)
        }
      } else if (!st.isFile()) {
        throw new HomeStateInvalidArchiveError(`unsupported file type in home archive: ${childRel}`)
      }
    }
  }
}

/** Units present in an extracted tree: top-level paths, or children of the per-child ones. */
function restoreUnits(treeRoot: string): string[] {
  const units: string[] = []
  for (const top of HOME_STATE_PATHS) {
    const abs = join(treeRoot, top)
    let st
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (PER_CHILD_UNITS.has(top) && st.isDirectory()) {
      for (const child of readdirSync(abs).sort()) units.push(join(top, child))
    } else {
      units.push(top)
    }
  }
  return units
}

function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  }
}

/** Private key material must not be group/world readable, or ssh refuses it outright. */
export function tightenHomePermissions(homeDir: string): void {
  for (const dir of ['.ssh', '.gnupg']) {
    const abs = join(homeDir, dir)
    try {
      if (!lstatSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    chmodSync(abs, 0o700)
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      const st = lstatSync(p)
      if (!st.isFile()) continue
      const isPublic = name.endsWith('.pub') || name === 'known_hosts' || name === 'authorized_keys'
      if (!isPublic && (st.mode & 0o077) !== 0) chmodSync(p, st.mode & 0o700)
    }
  }
  for (const file of ['.netrc', '.git-credentials']) {
    const p = join(homeDir, file)
    try {
      const st = lstatSync(p)
      if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(p, 0o600)
    } catch {}
  }
}

export interface HomeStateRestore {
  units: string[]
}

/**
 * Restore a gzipped home archive into HOME.
 *
 * Validated twice before anything in HOME is touched: member names from the
 * listing, then the extracted tree itself (link targets and file types only
 * mean something once they are on disk). Each unit then REPLACES its live
 * counterpart. Units absent from the archive are left alone, so an image
 * that ships its own `~/.config/foo` keeps it.
 *
 * The stage lives inside HOME so the final moves are renames on one
 * filesystem; its name is outside the persisted paths, so a crash mid-restore
 * can never be exported.
 */
export async function restoreHomeState(
  homeDir: string,
  gz: Uint8Array,
  opts: { sameOwner?: boolean } = {},
): Promise<HomeStateRestore> {
  const root = resolve(homeDir)
  mkdirSync(root, { recursive: true })
  const stage = mkdtempSync(join(root, RESTORE_STAGE_PREFIX))
  try {
    const archive = join(stage, 'home.tar.gz')
    writeFileSync(archive, gz)
    const listing = new TextDecoder().decode(await runTar(['-tzf', archive], { capture: true }))
    validateArchiveNames(listing.split('\n').filter(Boolean))

    const tree = join(stage, 'tree')
    mkdirSync(tree)
    const sameOwner = opts.sameOwner ?? process.getuid?.() === 0
    await runTar(['-xzpf', archive, sameOwner ? '--same-owner' : '--no-same-owner', '-C', tree])
    validateExtractedTree(tree, root)

    const units = restoreUnits(tree)
    for (const unit of units) {
      const dest = join(root, unit)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      moveInto(join(tree, unit), dest)
    }
    tightenHomePermissions(root)
    return { units }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Remove restore stages a crash left behind. */
export function sweepHomeRestoreStages(homeDir: string): void {
  try {
    for (const name of readdirSync(homeDir)) {
      if (name.startsWith(RESTORE_STAGE_PREFIX)) rmSync(join(homeDir, name), { recursive: true, force: true })
    }
  } catch {}
}

// ─── encryption ────────────────────────────────────────────────────────────

function aad(header: Buffer, projectId: string): Buffer {
  return Buffer.concat([header, Buffer.from(projectId, 'utf8')])
}

/**
 * AES-256-GCM. Layout: `SHGH` | format | key version | iv(12) | tag(16) | ciphertext.
 * The header and the project id are authenticated, so neither the key version
 * nor the owning project can be swapped without failing the tag check.
 */
export function encryptHomeState(gz: Uint8Array, opts: { key: HomeStateKey; projectId: string }): Uint8Array {
  if (!opts.projectId) throw new Error('encryptHomeState requires a projectId')
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, opts.key.version])])
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', opts.key.key, iv)
  cipher.setAAD(aad(header, opts.projectId))
  const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()])
  return new Uint8Array(Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]))
}

/** Inverse of {@link encryptHomeState}. Throws {@link HomeStateDecryptError} on any mismatch. */
export function decryptHomeState(blob: Uint8Array, opts: { key: HomeStateKey; projectId: string }): Uint8Array {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (buf.length < HEADER_BYTES + IV_BYTES + TAG_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new HomeStateDecryptError('not a home-state archive')
  }
  const format = buf[MAGIC.length]
  const keyVersion = buf[MAGIC.length + 1]
  if (format !== FORMAT_VERSION) throw new HomeStateDecryptError(`unsupported home-state format ${format}`)
  if (keyVersion !== opts.key.version) {
    throw new HomeStateDecryptError(`home-state archive uses key version ${keyVersion}, guest has ${opts.key.version}`)
  }
  const header = buf.subarray(0, HEADER_BYTES)
  const iv = buf.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES)
  const tag = buf.subarray(HEADER_BYTES + IV_BYTES, HEADER_BYTES + IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(HEADER_BYTES + IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', opts.key.key, iv)
    decipher.setAAD(aad(header, opts.projectId))
    decipher.setAuthTag(tag)
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } catch {
    throw new HomeStateDecryptError('home-state archive failed authentication (wrong key, wrong project, or tampered)')
  }
}

/** Upper bound on an encrypted archive, for request-body limits. */
export const HOME_STATE_MAX_BLOB_BYTES = HOME_STATE_MAX_PACKED_BYTES + HEADER_BYTES + IV_BYTES + TAG_BYTES
