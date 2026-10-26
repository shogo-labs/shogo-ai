// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bulk file transfer between projects of a workspace (`copy_to_project`).
 *
 * The remote tool channel (remote-tools.ts) moves one file per call, and a
 * binary file has to travel as base64 the model writes out token by token.
 * This moves a whole set of files as one tar.gz instead:
 *
 *   caller: packPaths → callRemoteImport
 *     → POST {SHOGO_API_URL}/api/internal/projects/:id/files/import   (RBAC, wake)
 *     → POST <target runtime>/agent/remote/import                     (x-runtime-token)
 *     → importArchive, rooted at the target project's folder
 *
 * The archive rides base64 inside JSON because the API's runtime forwarder
 * and the tunnel relay only carry string bodies.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deriveApiUrl, getInternalHeaders } from './internal-api'
import { isWithinRoot } from './path-boundary'
import { RemoteToolError } from './remote-tools'
import { assertAllowedPath } from './runtime-trust'

/** Compressed archive cap. Base64 adds a third on the wire. */
export const TRANSFER_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
export const TRANSFER_MAX_RAW_BYTES = 200 * 1024 * 1024
export const TRANSFER_MAX_FILES = 5_000

/** Never worth shipping between projects; the target rebuilds them. */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git'])

const IMPORT_REQUEST_TIMEOUT_MS = 180_000

export class TransferError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 413 | 500,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'TransferError'
  }
}

export interface TransferManifestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface TransferManifest {
  ok: true
  dest: string
  fileCount: number
  totalBytes: number
  files: TransferManifestEntry[]
}

export interface PackedArchive {
  archive: Buffer
  fileCount: number
  rawBytes: number
  /** Paths left out: symlinks, special files, node_modules/.git. */
  skipped: string[]
}

/**
 * Trust check for a path already confined to `root`. Containment is ours;
 * the trust layer contributes restricted mode, read-only roots and other
 * projects' folders (same rule as gateway-tools' assertAllowedPath wrapper).
 */
function assertTrusted(abs: string, mode: 'read' | 'write', shown: string): void {
  const trust = assertAllowedPath(abs, mode)
  if (trust.ok || trust.reason === 'outside_allowed_roots') return
  throw new TransferError(trust.message ?? `Path not allowed: ${shown}`, 403, trust.reason ?? 'forbidden')
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

async function runTar(args: string[], stdin?: Uint8Array): Promise<{ stdout: Buffer; stderr: string }> {
  const proc = Bun.spawn(['tar', ...args], {
    // macOS bsdtar otherwise adds AppleDouble `._*` entries.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new TransferError(`tar ${args[0]} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`, 500, 'tar_failed')
  }
  return { stdout: Buffer.from(stdout), stderr }
}

// ---------------------------------------------------------------------------
// Caller side
// ---------------------------------------------------------------------------

/**
 * Pack `paths` (files or folders, relative to `root`) into a tar.gz of
 * regular files only, `cp -r` style: each path is stored under its own
 * name, so `site/assets/cab2` unpacks as `cab2/...`. `.` packs the
 * contents of `root`. Every path must resolve inside `root` and pass the
 * read trust check.
 */
export async function packPaths(root: string, paths: readonly string[]): Promise<PackedArchive> {
  if (paths.length === 0) throw new TransferError('paths must name at least one file or folder', 400, 'bad_request')
  const groups: Array<{ base: string; files: string[] }> = []
  const entryNames = new Set<string>()
  const skipped: string[] = []
  let fileCount = 0
  let rawBytes = 0

  const visit = (abs: string, base: string, files: string[]) => {
    const rel = toPosix(relative(base, abs))
    const shown = toPosix(relative(root, abs)) || '.'
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      skipped.push(shown)
    } else if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (SKIPPED_DIR_NAMES.has(name)) {
          skipped.push(shown === '.' ? name : `${shown}/${name}`)
          continue
        }
        visit(join(abs, name), base, files)
      }
    } else if (st.isFile()) {
      if (entryNames.has(rel)) {
        throw new TransferError(`Two paths would both copy to ${rel}; copy them separately.`, 400, 'duplicate_entry')
      }
      entryNames.add(rel)
      files.push(rel)
      fileCount++
      rawBytes += st.size
      if (fileCount > TRANSFER_MAX_FILES) {
        throw new TransferError(`More than ${TRANSFER_MAX_FILES} files; copy a smaller set.`, 413, 'too_many_files')
      }
      if (rawBytes > TRANSFER_MAX_RAW_BYTES) {
        throw new TransferError(
          `More than ${Math.round(TRANSFER_MAX_RAW_BYTES / 1024 / 1024)} MB of files; copy a smaller set.`,
          413,
          'too_large',
        )
      }
    } else {
      skipped.push(rel)
    }
  }

  for (const requested of paths) {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new TransferError('Every path must be a non-empty string', 400, 'bad_request')
    }
    const abs = resolve(root, requested)
    if (!isWithinRoot(root, abs)) {
      throw new TransferError(`Path is outside the current project: ${requested}`, 400, 'outside_root')
    }
    assertTrusted(abs, 'read', requested)
    if (!existsSync(abs)) throw new TransferError(`Not found: ${requested}`, 400, 'not_found')
    const base = abs === resolve(root) ? abs : dirname(abs)
    const group = { base, files: [] as string[] }
    visit(abs, base, group.files)
    if (group.files.length > 0) groups.push(group)
  }

  if (fileCount === 0) {
    throw new TransferError('Nothing to copy: no regular files under the given paths.', 400, 'empty', { skipped })
  }

  // `./` keeps a name that starts with `-` from reading as an option.
  const args = ['-czf', '-']
  for (const group of groups) args.push('-C', group.base, ...group.files.map((f) => `./${f}`))
  const { stdout } = await runTar(args)
  if (stdout.length > TRANSFER_MAX_ARCHIVE_BYTES) {
    throw new TransferError(
      `Archive is ${(stdout.length / 1024 / 1024).toFixed(1)} MB compressed; the limit is ` +
        `${Math.round(TRANSFER_MAX_ARCHIVE_BYTES / 1024 / 1024)} MB. Copy a smaller set.`,
      413,
      'too_large',
    )
  }
  return { archive: stdout, fileCount, rawBytes, skipped }
}

/**
 * Send a packed archive to `targetProjectId`'s own runtime through the API.
 * Same headers as callRemoteTool, so the API authorizes it as the person
 * whose turn this is.
 */
export async function callRemoteImport(
  targetProjectId: string,
  body: { archive: string; dest?: string; overwrite?: boolean },
  signal?: AbortSignal,
): Promise<TransferManifest> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) throw new RemoteToolError('No API URL configured', 0)
  const timeout = AbortSignal.timeout(IMPORT_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/internal/projects/${encodeURIComponent(targetProjectId)}/files/import`, {
      method: 'POST',
      headers: getInternalHeaders(),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err: any) {
    if (signal?.aborted && !timeout.aborted) {
      throw new RemoteToolError(`Copy to project ${targetProjectId} was cancelled`, 0, 'aborted')
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new RemoteToolError(
      timedOut
        ? `Copy to project ${targetProjectId} timed out`
        : `Copy to project ${targetProjectId} failed: ${err?.message ?? err}`,
      0,
      timedOut ? 'timeout' : undefined,
    )
  }
  const json = (await res.json().catch(() => null)) as any
  if (res.ok && json?.ok === true && Array.isArray(json.files)) return json as TransferManifest
  const err = json?.error
  const code = typeof err === 'string' ? err : typeof err?.code === 'string' ? err.code : undefined
  const message = typeof err?.message === 'string' ? err.message : typeof err === 'string' ? err : `HTTP ${res.status}`
  const error = new RemoteToolError(
    `Copy to project ${targetProjectId} failed (HTTP ${res.status}): ${message}`,
    res.status,
    code,
  )
  if (Array.isArray(json?.conflicts)) (error as RemoteToolError & { conflicts?: string[] }).conflicts = json.conflicts
  throw error
}

// ---------------------------------------------------------------------------
// Target side: `/agent/remote/import`
// ---------------------------------------------------------------------------

function isUnsafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return true
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true
  return name.split('/').some((segment) => segment === '..')
}

/**
 * Reject the whole archive unless every entry is a regular file or a
 * directory with a relative name that stays below the extraction root.
 */
async function assertSafeArchive(archive: Buffer): Promise<void> {
  const [names, verbose] = await Promise.all([
    runTar(['-tzf', '-'], archive),
    runTar(['-tzvf', '-'], archive),
  ]).catch((err) => {
    throw new TransferError(`archive is not a readable tar.gz: ${err?.message ?? err}`, 400, 'bad_archive')
  })
  const nameLines = names.stdout.toString('utf-8').split('\n').filter((l) => l.length > 0)
  const verboseLines = verbose.stdout.toString('utf-8').split('\n').filter((l) => l.length > 0)
  if (nameLines.length !== verboseLines.length) {
    throw new TransferError('Archive listing is ambiguous (entry names with newlines?)', 400, 'unsafe_archive')
  }
  for (let i = 0; i < nameLines.length; i++) {
    const name = nameLines[i]!
    const type = verboseLines[i]![0]
    if (type !== '-' && type !== 'd') {
      throw new TransferError(`Archive entry is not a regular file or folder: ${name}`, 400, 'unsafe_archive')
    }
    if (isUnsafeEntryName(name)) {
      throw new TransferError(`Archive entry has an unsafe path: ${name}`, 400, 'unsafe_archive')
    }
  }
}

function collectStagedFiles(staging: string): string[] {
  const out: string[] = []
  const visit = (abs: string) => {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) {
      throw new TransferError(`Archive produced a symlink: ${toPosix(relative(staging, abs))}`, 400, 'unsafe_archive')
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) visit(join(abs, name))
    } else if (st.isFile()) {
      out.push(abs)
    }
  }
  visit(staging)
  return out
}

function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/**
 * Unpack a base64 tar.gz into `<root>/<dest>`. Nothing is written into the
 * project unless every entry is safe, every target passes the write trust
 * check, and (without `overwrite`) none of them already exists.
 */
export async function importArchive(
  root: string,
  rawBody: unknown,
  onWrite?: (relativePath: string, absolutePath: string) => void,
): Promise<TransferManifest> {
  const body = rawBody as { archive?: unknown; dest?: unknown; overwrite?: unknown } | null
  if (!body || typeof body.archive !== 'string' || !body.archive) {
    throw new TransferError('Missing required field: archive (base64 tar.gz)', 400, 'bad_request')
  }
  if (body.dest !== undefined && typeof body.dest !== 'string') {
    throw new TransferError('dest must be a string', 400, 'bad_request')
  }
  const overwrite = body.overwrite === true
  const destRel = (typeof body.dest === 'string' && body.dest.trim()) || '.'
  if (isAbsolute(destRel)) throw new TransferError('dest must be relative to the project root', 400, 'bad_request')
  const destAbs = resolve(root, destRel)
  if (!isWithinRoot(root, destAbs)) throw new TransferError('dest is outside the project root', 400, 'outside_root')

  if (body.archive.length > Math.ceil((TRANSFER_MAX_ARCHIVE_BYTES * 4) / 3) + 4) {
    throw new TransferError('Archive exceeds the transfer size limit', 413, 'too_large')
  }
  const archive = Buffer.from(body.archive, 'base64')
  if (archive.length === 0) throw new TransferError('archive is not valid base64', 400, 'bad_request')

  await assertSafeArchive(archive)

  const staging = join(root, '.tmp', `import-${randomUUID()}`)
  mkdirSync(staging, { recursive: true })
  try {
    await runTar(['-xzf', '-', '-C', staging, '--no-same-owner', '--no-same-permissions'], archive)
    const staged = collectStagedFiles(staging)
    if (staged.length > TRANSFER_MAX_FILES) {
      throw new TransferError(`More than ${TRANSFER_MAX_FILES} files in the archive`, 413, 'too_many_files')
    }

    const plan: Array<{ from: string; to: string; rel: string }> = []
    const conflicts: string[] = []
    for (const from of staged) {
      const to = resolve(destAbs, relative(staging, from))
      const rel = toPosix(relative(root, to))
      if (!isWithinRoot(root, to)) throw new TransferError(`Target is outside the project root: ${rel}`, 400, 'outside_root')
      assertTrusted(to, 'write', rel)
      if (existsSync(to) && (!overwrite || statSync(to).isDirectory())) conflicts.push(rel)
      plan.push({ from, to, rel })
    }
    if (conflicts.length > 0) {
      throw new TransferError(
        `${conflicts.length} file(s) already exist in the target. Pass overwrite: true to replace them, or pick another dest.`,
        409,
        'conflict',
        { conflicts: conflicts.slice(0, 50) },
      )
    }

    const files: TransferManifestEntry[] = []
    let totalBytes = 0
    for (const { from, to, rel } of plan) {
      const bytes = readFileSync(from)
      files.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      totalBytes += bytes.length
      moveFile(from, to)
      onWrite?.(rel, to)
    }
    return { ok: true, dest: toPosix(relative(root, destAbs)) || '.', fileCount: files.length, totalBytes, files }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export interface RemoteImportOutcome {
  status: 200 | 400 | 403 | 409 | 413 | 500
  body: TransferManifest | { ok: false; error: { code: string; message: string }; [key: string]: unknown }
}

/** Route adapter: never throws. */
export async function executeRemoteImport(
  root: string,
  rawBody: unknown,
  onWrite?: (relativePath: string, absolutePath: string) => void,
): Promise<RemoteImportOutcome> {
  const caller = (rawBody as { callerProjectId?: unknown } | null)?.callerProjectId
  try {
    const manifest = await importArchive(root, rawBody, onWrite)
    console.log(`[remote-import] caller=${typeof caller === 'string' ? caller : 'unknown'} files=${manifest.fileCount} bytes=${manifest.totalBytes}`)
    return { status: 200, body: manifest }
  } catch (err: any) {
    if (err instanceof TransferError) {
      return { status: err.status, body: { ok: false, error: { code: err.code, message: err.message }, ...err.extra } }
    }
    return { status: 500, body: { ok: false, error: { code: 'import_failed', message: err?.message ?? String(err) } } }
  }
}
