// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The workspace root's `.env*` files, kept across a cold boot (SHO-384).
 *
 * A runtime's root tree is never source: it is not in the durable repo (git
 * ignores `.env`, `.env.local` and `.env.*.local` — see
 * {@link DEFAULT_WORKSPACE_GITIGNORE}) and it is not in a source archive built
 * from `git archive HEAD`. On metal the encrypted home archive carries them
 * (SHO-382); a cloud pod has no host to hold that archive, so the API holds
 * them instead, encrypted at rest, and this module is the client half both
 * sides run.
 *
 * The contract is one encrypted blob per runtime key:
 *
 *   - A **slot** is one project root's whole `.env*` set. `root` is the
 *     runtime's own workspace root. A slot is recorded even when it has no
 *     `.env*` left, so "this root had no secrets when we exported" survives —
 *     otherwise a `.env` deleted before the export would reappear on the next
 *     cold boot (the SHO-382 QA round-1 failure, replayed here).
 *   - Restore REPLACES each file and prunes names the slot does not carry, at
 *     mode 0600. A file the agent deleted stays deleted.
 *   - Files travel base64 in JSON so the transport is one small HTTPS body; the
 *     API seals it before it touches storage, so neither git, a source
 *     tarball, nor the database row holds the bytes in the clear.
 */

import { createHash } from 'node:crypto'
// Namespace rather than named imports: this module is imported by pure builder
// code (`build-workspace-env`) and by suites that stub `fs` with the two calls
// they need. A named import makes those link failures; this binds the module
// itself, so `fs` is only touched when a slot is actually read or written.
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'

/** Slot name for the runtime's own workspace root. */
export const WORKSPACE_SECRET_SLOT_ROOT = 'root'

/** Payload version. An unknown version is refused rather than half-applied. */
export const WORKSPACE_ROOT_SECRETS_VERSION = 1

/** Ceilings. A `.env` past these is not a `.env`; refuse loudly, never truncate. */
export const WORKSPACE_ROOT_SECRET_MAX_FILE_BYTES = 256 * 1024
export const WORKSPACE_ROOT_SECRETS_MAX_SLOTS = 16
export const WORKSPACE_ROOT_SECRETS_MAX_FILES = 64
export const WORKSPACE_ROOT_SECRETS_MAX_BYTES = 1024 * 1024

/**
 * Ceiling on the JSON body that carries a payload. Base64 inflates bytes by
 * 4/3, so the body a full payload produces is larger than its contents; this is
 * the number both sides check before parsing or storing anything.
 */
export const WORKSPACE_ROOT_SECRETS_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

/** Names that hold a project's local tokens. Committed templates are not secrets. */
const WORKSPACE_SECRET_NAMES_LIST: readonly string[] = ['.env', '.env.local']
const WORKSPACE_SECRET_NAMES = new Set<string>(WORKSPACE_SECRET_NAMES_LIST)
const WORKSPACE_SECRET_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template']

/**
 * True for a live `.env`-style secret: `.env`, `.env.local`, `.env.production`,
 * but not `.env.example` and the other committed templates.
 */
export function isWorkspaceSecretFile(name: string): boolean {
  if (WORKSPACE_SECRET_NAMES.has(name)) return true
  if (!name.startsWith('.env.')) return false
  return !WORKSPACE_SECRET_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * gitignore rules for the names {@link isWorkspaceSecretFile} calls secrets.
 *
 * Derived from the same template list rather than written out by hand: the
 * durable repo and the secrets store disagreeing about what a `.env` is is how
 * `.env.production` ended up staged by `git add -A` while the archive treated
 * it as a secret (SHO-384 QA round 1). Everything `.env*` is ignored and only
 * the committed templates are re-included.
 */
export const WORKSPACE_SECRET_GITIGNORE_LINES: readonly string[] = [
  '# a .env holds tokens; only the committed templates are source',
  ...WORKSPACE_SECRET_NAMES_LIST.flatMap((name) => [name, `${name}.*`]),
  ...WORKSPACE_SECRET_TEMPLATE_SUFFIXES.map((suffix) => `!.env${suffix}`),
  ...WORKSPACE_SECRET_TEMPLATE_SUFFIXES.map((suffix) => `!.env.*${suffix}`),
]

/** A slot that can name a project folder without escaping the workspace. */
const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isWorkspaceSecretSlot(slot: string): boolean {
  return SLOT_NAME.test(slot)
}

/**
 * The runtime key a workspace runtime's durable state is stored under. One
 * key per runtime: the merged workspace runtime (`ws:<id>`) and a
 * project-anchored one (`ws:proj:<anchor>`) are different runtimes with
 * different roots, exactly as `HOME_STATE_ID` already distinguishes them.
 */
export function workspaceRuntimeKey(input: {
  workspaceId: string
  anchorProjectId?: string | null
}): string {
  return input.anchorProjectId ? `ws:proj:${input.anchorProjectId}` : `ws:${input.workspaceId}`
}

export interface WorkspaceSecretFile {
  name: string
  /** The file's bytes, base64. Not a path: the API never learns a path. */
  content: string
  /** Mode the file is written with (always 0600 on a restore). */
  mode: number
  mtimeMs: number
}

/** One project root's whole `.env*` set at the time it was captured. */
export interface WorkspaceSecretSlot {
  slot: string
  files: WorkspaceSecretFile[]
}

export interface WorkspaceRootSecrets {
  version: typeof WORKSPACE_ROOT_SECRETS_VERSION
  slots: WorkspaceSecretSlot[]
}

/**
 * Live `.env*` names in `dir` that the incoming set does not carry: files that
 * were deleted before the export, which a restore must remove instead of
 * leaving a stale copy behind.
 */
export function staleWorkspaceSecretNames(live: string[], incoming: Iterable<string>): string[] {
  const keep = new Set(incoming)
  return live.filter((name) => isWorkspaceSecretFile(name) && !keep.has(name))
}

function decodeError(name: string): Error {
  return new Error(`workspace secret ${name} is not valid base64`)
}

/**
 * Decode a payload's base64 content, or null when it is not base64 at all.
 *
 * `Buffer.from(x, 'base64')` never throws: it skips invalid characters and
 * returns whatever prefix it managed, so a malformed `.env` would validate and
 * then restore as an empty file. Round-tripping the decode is the only way to
 * tell the two apart.
 */
export function decodeWorkspaceSecretContent(content: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null
  if (content.length % 4 !== 0) return null
  const buf = Buffer.from(content, 'base64')
  return buf.toString('base64') === content ? buf : null
}

/**
 * Read one root's `.env*` files into a slot. Files over the per-file ceiling
 * are reported in `skipped` rather than stored: a 300 KiB "`.env`" is a
 * mis-aimed dump, and truncating it would restore a broken file.
 */
export function collectWorkspaceSecretSlot(
  dir: string,
  opts: { slot?: string } = {},
): { slot: WorkspaceSecretSlot; skipped: string[] } {
  const slot = opts.slot ?? WORKSPACE_SECRET_SLOT_ROOT
  const files: WorkspaceSecretFile[] = []
  const skipped: string[] = []
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return { slot: { slot, files }, skipped }
  }
  for (const name of names) {
    if (!isWorkspaceSecretFile(name)) continue
    const abs = join(dir, name)
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue
    }
    // A symlink's bytes live wherever it points; archiving the link would
    // restore a link into a tree that no longer has its target.
    if (!st.isFile()) {
      skipped.push(name)
      continue
    }
    if (st.size > WORKSPACE_ROOT_SECRET_MAX_FILE_BYTES) {
      skipped.push(name)
      continue
    }
    files.push({
      name,
      content: fs.readFileSync(abs).toString('base64'),
      mode: 0o600,
      mtimeMs: Math.round(st.mtimeMs),
    })
  }
  return { slot: { slot, files }, skipped }
}

/**
 * Write one slot's files into `dir`, replacing each and removing live `.env*`
 * names the slot does not carry. The slot is authoritative for that root:
 * its absence of a name is a deletion, not an omission.
 *
 * Returns the names written. Over-ceiling or malformed entries are skipped, and
 * a write that fails never leaves a half-written file in place.
 */
export function applyWorkspaceSecretSlot(
  dir: string,
  slot: WorkspaceSecretSlot,
  opts: { prune?: boolean } = {},
): { written: string[]; removed: string[] } {
  const written: string[] = []
  const removed: string[] = []
  const incoming = new Set<string>()
  const bytes = new Map<string, Buffer>()
  for (const file of slot.files) {
    if (!isWorkspaceSecretFile(file.name)) continue
    const buf = decodeWorkspaceSecretContent(file.content)
    if (!buf) throw decodeError(file.name)
    if (buf.byteLength > WORKSPACE_ROOT_SECRET_MAX_FILE_BYTES) continue
    incoming.add(file.name)
    bytes.set(file.name, buf)
  }

  fs.mkdirSync(dir, { recursive: true })

  if (opts.prune !== false) {
    let live: string[] = []
    try {
      live = fs.readdirSync(dir)
    } catch {
      live = []
    }
    for (const name of staleWorkspaceSecretNames(live, incoming)) {
      try {
        const st = fs.lstatSync(join(dir, name))
        if (!st.isFile() && !st.isSymbolicLink()) continue
        fs.rmSync(join(dir, name), { force: true })
        removed.push(name)
      } catch {
        /* already gone */
      }
    }
  }

  for (const [name, buf] of bytes) {
    const target = join(dir, name)
    // Replace rather than merge: a `.env` restored on top of a live one would
    // keep every line the archive does not carry, including a deleted key.
    fs.rmSync(target, { force: true })
    fs.writeFileSync(target, buf, { mode: 0o600 })
    fs.chmodSync(target, 0o600)
    const file = slot.files.find((f) => f.name === name)
    if (file && Number.isFinite(file.mtimeMs) && file.mtimeMs > 0) {
      const seconds = file.mtimeMs / 1000
      try {
        fs.utimesSync(target, seconds, seconds)
      } catch {
        /* timestamps are cosmetic */
      }
    }
    written.push(name)
  }
  return { written, removed }
}

/**
 * Change fingerprint of a payload: content, names, and the slot set. The API
 * stores it beside the blob so an unchanged runtime skips the upload, and a
 * runtime that finds the same tag skips the restore.
 */
export function workspaceSecretsTag(secrets: WorkspaceRootSecrets): string {
  const h = createHash('sha256')
  for (const slot of [...secrets.slots].sort((a, b) => a.slot.localeCompare(b.slot))) {
    h.update(`slot\0${slot.slot}\0`)
    for (const file of [...slot.files].sort((a, b) => a.name.localeCompare(b.name))) {
      h.update(`${file.name}\0${file.mode}\0${file.content}\0`)
    }
  }
  return h.digest('hex').slice(0, 32)
}

/** An empty-but-valid payload: every configured root with no secrets. */
export function emptyWorkspaceRootSecrets(slots: Array<{ slot: string }>): WorkspaceRootSecrets {
  return {
    version: WORKSPACE_ROOT_SECRETS_VERSION,
    slots: slots.map((s) => ({ slot: s.slot, files: [] })),
  }
}

/**
 * Validate a payload received from the other side of the wire (the API on a
 * write, or a runtime on a read) before any of it is trusted. Returns an error
 * string, or null when the payload is acceptable.
 *
 * A slot only names a root and a name only ever matches `.env*`, so a payload
 * — even one from a compromised runtime — cannot write outside the roots the
 * caller was configured with or drop a non-secret file into a workspace.
 */
export function validateWorkspaceRootSecrets(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'payload must be an object'
  const payload = value as Partial<WorkspaceRootSecrets>
  if (payload.version !== WORKSPACE_ROOT_SECRETS_VERSION) {
    return `unsupported payload version ${String((payload as any).version)}`
  }
  if (!Array.isArray(payload.slots)) return 'slots must be an array'
  if (payload.slots.length > WORKSPACE_ROOT_SECRETS_MAX_SLOTS) return 'too many slots'
  const seenSlots = new Set<string>()
  let files = 0
  let totalBytes = 0
  for (const slot of payload.slots) {
    if (!slot || typeof slot !== 'object') return 'slot must be an object'
    if (typeof slot.slot !== 'string' || !isWorkspaceSecretSlot(slot.slot)) {
      return `invalid slot name ${String(slot.slot).slice(0, 64)}`
    }
    if (seenSlots.has(slot.slot)) return `duplicate slot ${slot.slot}`
    seenSlots.add(slot.slot)
    if (!Array.isArray(slot.files)) return `slot ${slot.slot} has no files array`
    const seenNames = new Set<string>()
    for (const file of slot.files) {
      if (!file || typeof file !== 'object') return 'file must be an object'
      if (typeof file.name !== 'string' || !isWorkspaceSecretFile(file.name)) {
        return `slot ${slot.slot} carries a non-secret file name`
      }
      if (seenNames.has(file.name)) return `slot ${slot.slot} repeats ${file.name}`
      seenNames.add(file.name)
      if (typeof file.content !== 'string') return `${file.name} has no content`
      const buf = decodeWorkspaceSecretContent(file.content)
      if (!buf) return decodeError(file.name).message
      if (buf.byteLength > WORKSPACE_ROOT_SECRET_MAX_FILE_BYTES) return `${file.name} is too large`
      totalBytes += buf.byteLength
      files += 1
      if (files > WORKSPACE_ROOT_SECRETS_MAX_FILES) return 'too many files'
      if (totalBytes > WORKSPACE_ROOT_SECRETS_MAX_BYTES) return 'payload is too large'
      if (file.mode !== undefined && typeof file.mode !== 'number') return `${file.name} has an invalid mode`
      if (file.mtimeMs !== undefined && typeof file.mtimeMs !== 'number') return `${file.name} has an invalid mtime`
    }
  }
  return null
}

/** How the runtime reaches the store. The pod implements this over `/api/internal`. */
export interface WorkspaceRootSecretsTransport {
  /** The stored payload, or null when nothing has been stored yet (204). */
  pull(): Promise<{ tag: string; secrets: WorkspaceRootSecrets } | null>
  /**
   * Store `secrets` under `tag`. The API compares the tag with the one it
   * already holds, so a payload that has not changed costs nothing to write;
   * `stored: false` says so.
   */
  push(secrets: WorkspaceRootSecrets, opts: { tag: string }): Promise<{ stored: boolean; tag: string }>
}

/** Absorb the stored payload into the live roots. Slots with no live root are skipped. */
export async function restoreWorkspaceRootSecrets(opts: {
  transport: WorkspaceRootSecretsTransport
  /** Slot name -> live directory. */
  roots: Record<string, string>
  log?: (msg: string) => void
}): Promise<{ restored: string[]; removed: string[]; skippedSlots: string[] }> {
  const log = opts.log ?? (() => {})
  const restored: string[] = []
  const removed: string[] = []
  const skippedSlots: string[] = []
  const stored = await opts.transport.pull()
  if (!stored) return { restored, removed, skippedSlots }
  for (const slot of stored.secrets.slots) {
    const dir = opts.roots[slot.slot]
    if (!dir) {
      skippedSlots.push(slot.slot)
      log(`[workspace-secrets] not restoring .env for ${slot.slot}: not a root on this runtime`)
      continue
    }
    const applied = applyWorkspaceSecretSlot(resolve(dir), slot)
    restored.push(...applied.written.map((name) => `${slot.slot}/${name}`))
    removed.push(...applied.removed.map((name) => `${slot.slot}/${name}`))
  }
  return { restored, removed, skippedSlots }
}

/**
 * Capture every configured root and store it. Returns the tag that was stored
 * (or the one already there), so the caller can skip the next identical push.
 */
export async function flushWorkspaceRootSecrets(opts: {
  transport: WorkspaceRootSecretsTransport
  /** Slot name -> live directory. */
  roots: Record<string, string>
  /** Tag this runtime last wrote, when it knows it. */
  lastTag?: string | null
  log?: (msg: string) => void
}): Promise<{ tag: string; stored: boolean; files: number; skipped: string[] }> {
  const log = opts.log ?? (() => {})
  const slots: WorkspaceSecretSlot[] = []
  const skipped: string[] = []
  for (const [slot, dir] of Object.entries(opts.roots)) {
    const collected = collectWorkspaceSecretSlot(resolve(dir), { slot })
    slots.push(collected.slot)
    skipped.push(...collected.skipped.map((name) => `${slot}/${name}`))
  }
  const secrets: WorkspaceRootSecrets = { version: WORKSPACE_ROOT_SECRETS_VERSION, slots }
  const tag = workspaceSecretsTag(secrets)
  const files = slots.reduce((n, slot) => n + slot.files.length, 0)
  // Nothing changed since this runtime's last export: skip the request
  // entirely. A restarted runtime has no tag to compare, so it pushes once and
  // the API's own tag comparison makes that a no-op.
  if (opts.lastTag && opts.lastTag === tag) {
    return { tag, stored: false, files, skipped }
  }
  const result = await opts.transport.push(secrets, { tag })
  if (result.stored) {
    log(`[workspace-secrets] stored ${files} .env file(s) under ${tag}` + (skipped.length ? `, skipped ${skipped.join(', ')}` : ''))
  }
  return { tag: result.tag || tag, stored: result.stored, files, skipped }
}
