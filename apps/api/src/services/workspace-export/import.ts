// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace import: restore a `workspace-export` archive into a brand-new
 * workspace.
 *
 * v1 is create-new only. Merging into an existing workspace needs per-model
 * conflict rules (same card key, same channel slug, same member email) and
 * would double the feature; the route answers `workspace_import_mode_unsupported`
 * so the omission is a documented decision, not a bug.
 *
 * Two rules shape everything here:
 *   - **Every id is remapped.** Two imports of the same archive produce two
 *     independent workspaces, even when the source workspace lives on this
 *     same instance.
 *   - **The archive is hostile input.** Paths, sizes, entry counts, the
 *     compression ratio and every `sha256` are checked before a single write,
 *     and a `data/<Model>.json` for an excluded model is ignored with a
 *     warning no matter what the manifest says.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { prisma } from '../../lib/prisma'
import { decryptZip, isEncryptedZip, ZipPasswordError } from '../../lib/zip-encryption'
import { isExcludedRelPath, workspacesDir } from './files'
import {
  CREDENTIALS_REQUIRED_ENTRY,
  SUPPORTED_WORKSPACE_EXPORT_VERSIONS,
  WORKSPACE_ARCHIVE_ENTRY,
  WORKSPACE_MANIFEST_ENTRY,
  type WorkspaceExportManifest,
} from './export'
import {
  INCLUDED_MODELS,
  WORKSPACE_EXPORT_MANIFEST,
  insertOrder,
} from './manifest'
import type { RequiredCredential } from '../../lib/export-secrets'

export const MAX_ENTRY_COUNT = 60_000
export const MAX_COMPRESSION_RATIO = 200

export interface WorkspaceImportOptions {
  archive: Uint8Array
  /** Id of the member running the import; becomes the new workspace's owner. */
  requesterId: string
  name?: string
  password?: string
  dryRun?: boolean
  /** Test seam: where imported workspace file trees are written. */
  workspacesDirOverride?: string
  /** Test seam: an alternative Prisma client. */
  db?: any
}

export interface WorkspaceImportReport {
  workspace: { id: string; name: string; kind: string }
  dryRun: boolean
  stats: {
    models: number
    rowsInserted: number
    rowsSkipped: number
    filesWritten: number
    filesSkipped: number
    attachments: number
  }
  warnings: string[]
  credentials: RequiredCredential[]
  skippedRows: Array<{ model: string; id: string; reason: string }>
}

export class WorkspaceImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'WorkspaceImportError'
  }
}

interface ParsedArchive {
  files: Record<string, Uint8Array>
  workspace: {
    id: string
    name: string
    kind?: string
    formatVersion: string
    members?: Array<{
      id?: string
      email?: string | null
      name?: string | null
      role?: string
      isBillingAdmin?: boolean
    }>
  }
  manifest: WorkspaceExportManifest
  rows: Map<string, Array<Record<string, any>>>
  credentials: RequiredCredential[]
  warnings: string[]
}

const UNSAFE_PATH = (relPath: string): boolean =>
  !relPath ||
  relPath.includes('..') ||
  relPath.startsWith('/') ||
  /^[a-zA-Z]:\//.test(relPath) ||
  relPath.includes('\0')

function decodeJson<T>(bytes: Uint8Array | undefined, what: string): T {
  if (!bytes) {
    throw new WorkspaceImportError(`The archive is missing ${what}.`, 422, 'workspace_import_corrupt')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    throw new WorkspaceImportError(
      `The archive's ${what} is not valid JSON.`,
      422,
      'workspace_import_corrupt',
    )
  }
}

/**
 * Unpack and validate. Nothing is written to the database or to disk here.
 */
export async function readWorkspaceArchive(
  archive: Uint8Array,
  password = '',
): Promise<ParsedArchive> {
  let files: Record<string, Uint8Array>
  const encrypted = isEncryptedZip(archive)
  if (encrypted) {
    if (!password) {
      throw new WorkspaceImportError(
        'This archive is password-protected. Enter its password to import it.',
        400,
        'workspace_import_password_required',
      )
    }
    try {
      files = await decryptZip(archive, password)
    } catch (err) {
      if (err instanceof ZipPasswordError) {
        throw new WorkspaceImportError('Wrong password for this archive.', 400, 'workspace_import_bad_password')
      }
      throw new WorkspaceImportError('Invalid or corrupt ZIP archive.', 400, 'workspace_import_corrupt')
    }
  } else {
    try {
      files = unzipSync(archive)
    } catch {
      throw new WorkspaceImportError('Invalid or corrupt ZIP archive.', 400, 'workspace_import_corrupt')
    }
  }

  const names = Object.keys(files)
  if (!names.length) {
    throw new WorkspaceImportError('The archive is empty.', 422, 'workspace_import_corrupt')
  }
  if (names.length > MAX_ENTRY_COUNT) {
    throw new WorkspaceImportError(
      `The archive has ${names.length} entries, more than the ${MAX_ENTRY_COUNT} an import accepts.`,
      413,
      'workspace_import_too_large',
    )
  }

  let uncompressed = 0
  for (const name of names) {
    uncompressed += files[name].byteLength
    if (UNSAFE_PATH(name)) {
      throw new WorkspaceImportError(
        `The archive contains an unsafe path (${name.slice(0, 120)}).`,
        422,
        'workspace_import_unsafe_path',
      )
    }
  }
  if (archive.byteLength > 0 && uncompressed / archive.byteLength > MAX_COMPRESSION_RATIO) {
    throw new WorkspaceImportError(
      'The archive expands far more than its size allows and was rejected.',
      422,
      'workspace_import_corrupt',
    )
  }

  const workspaceRaw = decodeJson<any>(files[WORKSPACE_ARCHIVE_ENTRY], WORKSPACE_ARCHIVE_ENTRY)
  const formatVersion = String(workspaceRaw?.formatVersion ?? '')
  if (!SUPPORTED_WORKSPACE_EXPORT_VERSIONS.has(formatVersion)) {
    throw new WorkspaceImportError(
      `This archive was exported by a newer Shogo (format ${formatVersion || 'unknown'}). Update Shogo and try again.`,
      400,
      'workspace_import_unsupported_version',
    )
  }

  const manifest = decodeJson<WorkspaceExportManifest>(
    files[WORKSPACE_MANIFEST_ENTRY],
    WORKSPACE_MANIFEST_ENTRY,
  )
  if (!manifest || typeof manifest !== 'object') {
    throw new WorkspaceImportError(
      'The archive has no usable manifest.',
      422,
      'workspace_import_corrupt',
    )
  }

  // Integrity: every entry the manifest describes must match its hash.
  for (const entry of manifest.entries ?? []) {
    const bytes = files[entry.path]
    if (!bytes) {
      throw new WorkspaceImportError(
        `The archive is missing ${entry.path}, which its manifest lists.`,
        422,
        'workspace_import_corrupt',
      )
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== entry.sha256) {
      throw new WorkspaceImportError(
        `The archive is corrupt: ${entry.path} does not match its checksum.`,
        422,
        'workspace_import_corrupt',
      )
    }
  }

  const warnings: string[] = []
  const rows = new Map<string, Array<Record<string, any>>>()
  for (const name of names) {
    if (!name.startsWith('data/') || !name.endsWith('.json')) continue
    const model = name.slice('data/'.length, -'.json'.length)
    const entry = WORKSPACE_EXPORT_MANIFEST[model]
    if (!entry) {
      warnings.push(`Ignored data/${model}.json: ${model} is not part of the workspace export format.`)
      continue
    }
    if (entry.decision !== 'include') {
      warnings.push(`Ignored data/${model}.json: ${model} is excluded from workspace imports.`)
      continue
    }
    const parsed = decodeJson<unknown>(files[name], name)
    if (!Array.isArray(parsed)) {
      throw new WorkspaceImportError(`${name} is not an array of rows.`, 422, 'workspace_import_corrupt')
    }
    rows.set(model, parsed as Array<Record<string, any>>)
  }

  for (const model of INCLUDED_MODELS) {
    if (!rows.has(model)) {
      warnings.push(`The archive has no data for ${model}; imported none.`)
    }
  }

  const credentials = (() => {
    const bytes = files[CREDENTIALS_REQUIRED_ENTRY]
    if (!bytes) return []
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      return Array.isArray(parsed?.credentials) ? (parsed.credentials as RequiredCredential[]) : []
    } catch {
      warnings.push('credentials-required.json was unreadable; the list of values to set again is in the manifest.')
      return []
    }
  })()

  return {
    files,
    workspace: {
      id: String(workspaceRaw.id ?? ''),
      name: String(workspaceRaw.name ?? 'Imported workspace'),
      kind: workspaceRaw.kind,
      formatVersion,
      members: Array.isArray(workspaceRaw.members) ? workspaceRaw.members : [],
    },
    manifest,
    rows,
    credentials,
    warnings,
  }
}

function newWorkspaceName(parsed: ParsedArchive, requested?: string): string {
  const base = (requested ?? '').trim() || `${parsed.workspace.name} (imported)`
  return base.slice(0, 120)
}

/**
 * Import the archive. `dryRun` runs every validation and returns the plan
 * without touching the database or the disk.
 */
export async function importWorkspace(
  opts: WorkspaceImportOptions,
): Promise<WorkspaceImportReport> {
  const db: any = opts.db ?? prisma
  const parsed = await readWorkspaceArchive(opts.archive, opts.password ?? '')
  const warnings = [...parsed.warnings]
  const skippedRows: WorkspaceImportReport['skippedRows'] = []

  // ─── Plan: fresh ids for everything ──────────────────────────────
  const idMap = new Map<string, string>()
  const perModel = new Map<string, Map<string, string>>()
  for (const [model, rows] of parsed.rows) {
    const map = new Map<string, string>()
    for (const row of rows) {
      const oldId = String(row?.id ?? '')
      if (!oldId) continue
      const fresh = randomUUID()
      map.set(oldId, fresh)
      idMap.set(oldId, fresh)
    }
    perModel.set(model, map)
  }

  // Member matching happens by email, not by the other instance's user ids.
  const emailToUser = new Map<string, string>()
  const emails = (parsed.workspace.members ?? [])
    .map((member) => String(member?.email ?? '').trim().toLowerCase())
    .filter(Boolean)
  if (emails.length) {
    const users = await db.user
      .findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
      .catch(() => [] as Array<{ id: string; email: string | null }>)
    for (const user of users) {
      if (user.email) emailToUser.set(user.email.toLowerCase(), user.id)
    }
  }

  // The archived member list is what carries emails; `Member` rows only carry
  // the other instance's user id.
  const memberEmailById = new Map<string, string>()
  for (const member of parsed.workspace.members ?? []) {
    const id = String(member?.id ?? '')
    const email = String(member?.email ?? '').trim().toLowerCase()
    if (id && email) memberEmailById.set(id, email)
  }

  const workspaceOldId = parsed.workspace.id
  const newWorkspaceId = idMap.get(workspaceOldId) ?? randomUUID()
  if (workspaceOldId) idMap.set(workspaceOldId, newWorkspaceId)

  const droppedIds = new Set<string>()
  const mergedMemberships: Array<{ id: string; email: string; role: string }> = []
  const rewritten = new Map<string, Array<Record<string, any>>>()
  let rowsSkipped = 0

  const attachmentPaths = new Map<string, string>()
  for (const entry of parsed.manifest.attachments ?? []) {
    attachmentPaths.set(entry.key, entry.path)
  }

  for (const model of insertOrder()) {
    const rows = parsed.rows.get(model) ?? []
    const out: Array<Record<string, any>> = []
    for (const row of rows) {
      const oldId = String(row?.id ?? '')
      const freshId = perModel.get(model)?.get(oldId)
      if (!oldId || !freshId) {
        rowsSkipped++
        skippedRows.push({ model, id: oldId, reason: 'row has no id' })
        continue
      }

      if (model === 'Workspace') {
        // The workspace row is created explicitly (owner member + profile), so
        // this row only carries the old id into the map.
        continue
      }
      if (model === 'Member') {
        const email = memberEmailById.get(oldId) ?? ''
        const userId = emailToUser.get(email)
        // The requester is inserted as the new owner before this loop runs, and
        // `Member` is unique on (userId, workspaceId): replaying their row would
        // fail with a constraint error on a real database.
        if (userId && userId === opts.requesterId) {
          mergedMemberships.push({ id: oldId, email, role: String(row.role ?? 'member') })
          continue
        }
        if (!userId) {
          rowsSkipped++
          skippedRows.push({ model, id: oldId, reason: `no account for ${email || 'this member'}` })
          droppedIds.add(oldId)
          continue
        }
        out.push({ ...row, id: freshId, userId, workspaceId: newWorkspaceId })
        continue
      }

      const next: Record<string, any> = { ...row, id: freshId }
      if ('workspaceId' in next) next.workspaceId = newWorkspaceId
      for (const [key, value] of Object.entries(row)) {
        if (key === 'id' || !key.endsWith('Id')) continue
        if (typeof value !== 'string') continue
        const mapped = idMap.get(value)
        if (mapped) {
          next[key] = mapped
        } else if (droppedIds.has(value)) {
          // The parent did not come across: an FK pointing at nothing is worse
          // than a null, and a non-nullable one fails at insert and is counted.
          next[key] = null
        }
      }
      if (model === 'ChatMessage' && typeof next.parts === 'string') {
        next.parts = rewriteAttachmentRefs(next.parts, attachmentPaths)
      }
      out.push(next)
    }
    rewritten.set(model, out)
  }

  if (mergedMemberships.length) {
    warnings.push(
      `The requester already owns this import, so ${mergedMemberships.length} member row(s) for their own account were merged into that owner membership instead of duplicated.`,
    )
  }
  const workspaceName = newWorkspaceName(parsed, opts.name)
  const projectOldIds = (parsed.rows.get('Project') ?? []).map((row) => String(row.id))
  const plannedFiles = Object.keys(parsed.files)
  const fileEntries = plannedFiles.filter(
    (name) => name.startsWith('workspace/') || name.startsWith('projects/'),
  )
  const attachmentEntries = plannedFiles.filter((name) => name.startsWith('attachments/'))

  if (opts.dryRun) {
    return {
      workspace: { id: '', name: workspaceName, kind: String(parsed.workspace.kind ?? 'team') },
      dryRun: true,
      stats: {
        models: rewritten.size,
        rowsInserted: [...rewritten.values()].reduce((sum, rows) => sum + rows.length, 0),
        rowsSkipped,
        filesWritten: 0,
        filesSkipped: 0,
        attachments: attachmentEntries.length,
      },
      warnings,
      credentials: parsed.credentials,
      skippedRows,
    }
  }

  // ─── Insert ──────────────────────────────────────────────────────
  let rowsInserted = 0
  const txResult = await db.$transaction(
    async (tx: any) => {
      const workspace = await tx.workspace.create({
        data: {
          id: newWorkspaceId,
          name: workspaceName,
          slug: `${newWorkspaceId.slice(0, 8)}-imported`,
          kind: parsed.workspace.kind === 'personal' ? 'personal' : 'team',
        },
      })
      await tx.member.create({
        data: { userId: opts.requesterId, role: 'owner', workspaceId: workspace.id, isBillingAdmin: true },
      })
      await tx.workspaceAgentProfile
        .create({
          data: {
            workspaceId: workspace.id,
            name: 'Shogo',
            tagline: 'Your personal AI companion',
          },
        })
        .catch(() => undefined)

      for (const model of insertOrder()) {
        const rows = rewritten.get(model) ?? []
        if (!rows.length) continue
        if (model === 'Workspace') continue
        if (model === 'Member') {
          // Inserted one by one so a member whose account is missing is
          // reported instead of aborting the whole workspace.
          for (const row of rows) {
            try {
              await tx.member.create({ data: row as any })
              rowsInserted++
            } catch (err: any) {
              rowsSkipped++
              skippedRows.push({ model, id: String(row.id), reason: err?.message ?? 'insert failed' })
            }
          }
          continue
        }
        const client = (tx as any)[model.charAt(0).toLowerCase() + model.slice(1)]
        if (!client?.createMany) {
          for (const row of rows) {
            await client
              .create({ data: row })
              .then(() => rowsInserted++)
              .catch((err: any) => {
                rowsSkipped++
                skippedRows.push({ model, id: String(row.id), reason: err?.message ?? 'insert failed' })
              })
          }
          continue
        }
        const CHUNK = 200
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK)
          try {
            const res = await client.createMany({ data: chunk })
            rowsInserted += res?.count ?? chunk.length
          } catch {
            // Column-set mismatches (a row written by the other schema) fail
            // the whole chunk; fall back to per-row so the rest still lands.
            for (const row of chunk) {
              try {
                await client.create({ data: row })
                rowsInserted++
              } catch (err: any) {
                rowsSkipped++
                skippedRows.push({ model, id: String(row.id), reason: err?.message ?? 'insert failed' })
              }
            }
          }
        }
      }

      return workspace
    },
    { timeout: 180_000, maxWait: 20_000 },
  )

  // ─── Files ───────────────────────────────────────────────────────
  const baseDir = opts.workspacesDirOverride ?? workspacesDir()
  const workspaceRoot = join(baseDir, '.workspace-roots', newWorkspaceId)
  let filesWritten = 0
  let filesSkipped = 0
  const writeFile = (target: string, bytes: Uint8Array) => {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }

  for (const name of fileEntries) {
    const bytes = parsed.files[name]
    if (!bytes) continue
    if (name.startsWith('workspace/')) {
      const relPath = name.slice('workspace/'.length)
      if (UNSAFE_PATH(relPath) || isExcludedRelPath(relPath)) {
        filesSkipped++
        continue
      }
      writeFile(join(workspaceRoot, relPath), bytes)
      filesWritten++
      continue
    }
    const match = /^projects\/([^/]+)\/(.*)$/.exec(name)
    if (!match) {
      filesSkipped++
      continue
    }
    const [, oldProjectId, rest] = match
    if (rest === 'project.json') continue
    const newProjectId = idMap.get(oldProjectId)
    if (!newProjectId) {
      // The project row itself did not come across; its files have no home.
      filesSkipped++
      continue
    }
    const relPath = rest.startsWith('files/') ? rest.slice('files/'.length) : null
    if (relPath === null) continue
    if (UNSAFE_PATH(relPath) || isExcludedRelPath(relPath)) {
      filesSkipped++
      continue
    }
    writeFile(join(baseDir, newProjectId, relPath), bytes)
    filesWritten++
  }

  let attachments = 0
  for (const name of attachmentEntries) {
    const bytes = parsed.files[name]
    if (!bytes) continue
    const relPath = name.slice('attachments/'.length)
    if (UNSAFE_PATH(relPath)) {
      filesSkipped++
      continue
    }
    writeFile(join(workspaceRoot, 'attachments', relPath), bytes)
    attachments++
  }
  if (attachments > 0) {
    warnings.push(
      `${attachments} attachment(s) were restored as files under attachments/ in the workspace root; they are not re-uploaded to chat storage.`,
    )
  }

  const report: WorkspaceImportReport = {
    workspace: {
      id: txResult.id,
      name: txResult.name,
      kind: String(txResult.kind ?? 'team'),
    },
    dryRun: false,
    stats: {
      models: rewritten.size,
      rowsInserted,
      rowsSkipped,
      filesWritten,
      filesSkipped,
      attachments,
    },
    warnings,
    credentials: parsed.credentials,
    skippedRows: skippedRows.slice(0, 200),
  }

  writeFile(
    join(workspaceRoot, 'import-report.json'),
    new TextEncoder().encode(JSON.stringify({ ...report, importedAt: new Date().toISOString() }, null, 2)),
  )

  if (!projectOldIds.length) {
    warnings.push('The archive contained no projects.')
  }

  return report
}

/** `attachment://<old object key>` → `attachment://attachments/<archived path>`. */
export function rewriteAttachmentRefs(
  parts: string,
  paths: Map<string, string>,
): string {
  if (!parts.includes('attachment://')) return parts
  return parts.replace(/attachment:\/\/([^"\\\s]+)/g, (whole, key: string) => {
    const archived = paths.get(key)
    if (!archived) return whole
    return `attachment://${archived}`
  })
}
