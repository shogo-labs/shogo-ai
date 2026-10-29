// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace export: one archive holding everything that belongs to a
 * workspace — every in-scope model, every project's files, every chat and
 * channel transcript — plus a manifest that says what is inside, what is not
 * and why.
 *
 * The inventory comes from {@link WORKSPACE_EXPORT_MANIFEST} (see manifest.ts),
 * never from an ad-hoc `where` in this file: the guard test asserts the two
 * schemas and the table agree, so a new model cannot leave an archive silently
 * incomplete.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../../lib/prisma'
import {
  isEnvFile,
  redactEnvText,
  sanitizeChannelsForExport,
  type RequiredCredential,
} from '../../lib/export-secrets'
import { ArchiveWriter, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from './archive'
import {
  collectExportWorkspaceFiles,
  collectFolderLinkedFiles,
  collectWorkspacePodFiles,
  collectWorkspaceRootFiles,
  isKubernetes,
  resolveWorkspaceRoot,
  workspacesDir,
  type SkippedFile,
} from './files'
import {
  INCLUDED_MODELS,
  insertOrder,
  redactionsFor,
  scopeFor,
  WORKSPACE_EXPORT_MANIFEST,
} from './manifest'

export const WORKSPACE_EXPORT_FORMAT_VERSION = '1.0'
export const SUPPORTED_WORKSPACE_EXPORT_VERSIONS = new Set([WORKSPACE_EXPORT_FORMAT_VERSION])

export const WORKSPACE_ARCHIVE_ENTRY = 'workspace.json'
export const WORKSPACE_MANIFEST_ENTRY = 'manifest.json'
export const WORKSPACE_README_ENTRY = 'README.md'
export const CREDENTIALS_REQUIRED_ENTRY = 'credentials-required.json'

export interface WorkspaceExportOptions {
  /** Owner-only: include every DM, not just the requester's. */
  includeAllDms?: boolean
  /** Ship chat/channel attachment bytes. */
  includeAttachments?: boolean
  /** Opt-in ZipCrypto password: secrets travel in place instead of being redacted. */
  password?: string
}

export interface WorkspaceExportRequest {
  workspaceId: string
  /** The member requesting the export; decides which DMs are visible. */
  requesterId: string
  /** Whether the requester owns the workspace (only owners may include all DMs). */
  isOwner: boolean
  options?: WorkspaceExportOptions
  limits?: ArchiveLimits
  /** Test seam: overrides the resolved workspace root. */
  workspaceRootOverride?: string | null
  /** Test seam: an alternative Prisma client (also used by the round-trip test). */
  db?: any
}

export interface RedactionRecord {
  model: string
  id: string
  column: string
  label: string
}

export interface WorkspaceExportManifest {
  formatVersion: string
  exportedAt: string
  workspace: { id: string; name: string; kind: string }
  options: {
    includeAllDms: boolean
    includeAttachments: boolean
    passwordProtected: boolean
    redacted: boolean
  }
  counts: {
    models: number
    rows: number
    files: number
    attachments: number
    bytes: number
  }
  models: Record<
    string,
    { decision: 'include' | 'exclude'; reason: string; rows: number; bytes: number }
  >
  insertOrder: readonly string[]
  projects: Array<{
    id: string
    name: string
    files: number
    bytes: number
    sourceMode: string
  }>
  files: { count: number; totalBytes: number; skipped: SkippedFile[] }
  attachments: Array<{ path: string; key: string; mimeType: string; bytes: number }>
  workspaceRoot: { dir: string | null; candidates: string[] }
  warnings: string[]
  redactions: RedactionRecord[]
  encryption: 'none' | 'zipcrypto'
  entries: Array<{ path: string; bytes: number; sha256: string }>
}

export interface WorkspaceExportResult {
  tempPath: string
  bytes: number
  manifest: WorkspaceExportManifest
}

export class WorkspaceExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'WorkspaceExportError'
  }
}

const modelClient = (model: string, db: any = prisma): any => {
  const key = model.charAt(0).toLowerCase() + model.slice(1)
  return db[key]
}

/** Prisma returns Date objects; an archive carries ISO strings and nothing else. */
function toJsonSafe(value: any): any {
  if (value === null || value === undefined) return value ?? null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value as Uint8Array).toString('base64')
  }
  if (typeof value === 'bigint') return Number(value)
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v)
    return out
  }
  return value
}

function redactRow(
  model: string,
  row: Record<string, any>,
  redactions: RedactionRecord[],
  credentials: RequiredCredential[],
): Record<string, any> {
  const rules = redactionsFor(model)
  if (!rules) return row
  const out = { ...row }
  for (const column of rules.redact ?? []) {
    if (out[column] != null && out[column] !== '') {
      out[column] = null
      const id = String(row.id ?? '')
      redactions.push({ model, id, column, label: `${model}.${column}` })
      // The manifest entry is for auditors; `credentials-required.json` and the
      // import UI are what a person acts on, so every blanked column has to be
      // listed here too — not only the ones inside a JSON blob.
      credentials.push({ channel: `${model}:${id}`, field: column, label: `${model}.${column}` })
    }
  }
  for (const column of rules.jsonSecrets ?? []) {
    if (out[column] == null) continue
    const { sanitized, required } = sanitizeChannelsForExport(out[column])
    out[column] = sanitized
    for (const req of required) {
      credentials.push({ ...req, channel: `${model}:${row.id ?? ''}` })
      redactions.push({
        model,
        id: String(row.id ?? ''),
        column,
        label: `${model}.${column}.${req.field}`,
      })
    }
  }
  return out
}

export interface WorkspaceSnapshot {
  workspace: { id: string; name: string; kind: string }
  projectIds: string[]
  projects: Array<{ id: string; name: string; folderPath?: string | null }>
  rows: Map<string, Array<Record<string, any>>>
  warnings: string[]
  redactions: RedactionRecord[]
  credentials: RequiredCredential[]
  droppedDms: number
}

/**
 * Walk the manifest in insertion order, collecting the rows that belong to
 * one workspace. Parents come first, so a parent-scoped child can always be
 * narrowed by ids we already have.
 */
export async function collectWorkspaceSnapshot(
  req: Pick<WorkspaceExportRequest, 'workspaceId' | 'requesterId' | 'isOwner' | 'options'>,
): Promise<WorkspaceSnapshot> {
  const { workspaceId, requesterId, isOwner } = req
  const db = (req as { db?: any }).db ?? prisma
  const includeAllDms = !!req.options?.includeAllDms && isOwner
  const redact = !req.options?.password

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, kind: true },
  })
  if (!workspace) {
    throw new WorkspaceExportError('Workspace not found', 404, 'workspace_not_found')
  }

  const projects: Array<{ id: string; name: string }> = await db.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  })
  const folders: Array<{ projectId: string; path: string }> = await db.projectFolder
    .findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true, path: true },
    })
    .catch(() => [])
  const folderByProject = new Map(folders.map((f) => [f.projectId, f.path]))
  const projectIds = projects.map((p) => p.id)

  const rows = new Map<string, Array<Record<string, any>>>()
  const idSets = new Map<string, Set<string>>()
  const redactions: RedactionRecord[] = []
  const credentials: RequiredCredential[] = []
  const warnings: string[] = []
  let droppedDms = 0

  for (const model of insertOrder()) {
    const scope = scopeFor(model)
    if (!scope) continue
    const client = modelClient(model, db)
    if (!client?.findMany) {
      warnings.push(`Model ${model} is not available on this deployment; nothing was exported for it.`)
      rows.set(model, [])
      idSets.set(model, new Set())
      continue
    }

    let found: Array<Record<string, any>> = []
    try {
      if (scope.kind === 'workspace-row') {
        // `movedToWorkspaceId`/`movedAt` point at a workspace on the source
        // instance. A restored copy must not claim it was moved somewhere that
        // does not exist here, or it shows a "Moved to" banner for nothing.
        const { movedToWorkspaceId: _movedTo, movedAt: _movedAt, ...row } = workspace as any
        found = [row]
      } else if (scope.kind === 'workspace') {
        found = await client.findMany({ where: { workspaceId } })
      } else if (scope.kind === 'project') {
        found = projectIds.length
          ? await client.findMany({ where: { projectId: { in: projectIds } } })
          : []
      } else {
        const parentIds = [...(idSets.get(scope.parent) ?? [])]
        found = parentIds.length
          ? await client.findMany({ where: { [scope.field]: { in: parentIds } } })
          : []
      }
    } catch (err: any) {
      warnings.push(`Could not read ${model}: ${err?.message || 'unknown error'}`)
      found = []
    }

    if (model === 'Conversation' && !includeAllDms) {
      const dmIds = found
        .filter((row) => row.kind === 'dm' || row.kind === 'group_dm')
        .map((row) => String(row.id))
      let visible = new Set<string>()
      if (dmIds.length) {
        const memberships: Array<{ conversationId: string }> = await db.conversationMember
          .findMany({ where: { conversationId: { in: dmIds }, userId: requesterId }, select: { conversationId: true } })
          .catch(() => [])
        visible = new Set(memberships.map((m) => m.conversationId))
      }
      const before = found.length
      found = found.filter(
        (row) => (row.kind !== 'dm' && row.kind !== 'group_dm') || visible.has(String(row.id)),
      )
      droppedDms += before - found.length
      if (droppedDms > 0) {
        warnings.push(
          `${droppedDms} direct message conversation(s) were left out because the requester is not a member. A workspace owner can include them with \`includeAllDms\`.`,
        )
      }
    }

    const prepared = redact
      ? found.map((row) => redactRow(model, row, redactions, credentials))
      : found
    rows.set(model, prepared.map(toJsonSafe))
    idSets.set(model, new Set(prepared.map((row: Record<string, any>) => String(row.id))))
  }

  return {
    workspace,
    projectIds,
    projects: projects.map((p) => ({ ...p, folderPath: folderByProject.get(p.id) ?? null })),
    rows,
    warnings,
    redactions,
    credentials,
    droppedDms,
  }
}

function safeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return cleaned || fallback
}

/**
 * Object storage is loaded lazily: the archive service must stay importable in
 * a process that never touches S3 (the desktop build, and every test that mocks
 * `lib/s3` for its own purposes).
 */
async function readArtifactBytes(key: string): Promise<Uint8Array | null> {
  try {
    const [{ GetObjectCommand }, { getArtifactBucket, getArtifactS3Client }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('../../lib/s3'),
    ])
    const res = await getArtifactS3Client().send(
      new GetObjectCommand({ Bucket: getArtifactBucket(), Key: key }),
    )
    const bytes = await res.Body?.transformToByteArray()
    return bytes ? new Uint8Array(bytes) : null
  } catch {
    return null
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const marker = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || marker < 0) return null
  try {
    return new Uint8Array(Buffer.from(dataUrl.slice(marker + 1), 'base64'))
  } catch {
    return null
  }
}

/**
 * Build the archive on disk. The caller streams `tempPath` and deletes it in a
 * `finally`; nothing here keeps the archive in memory.
 */
export async function buildWorkspaceArchive(req: WorkspaceExportRequest): Promise<WorkspaceExportResult> {
  const options = req.options ?? {}
  const password = typeof options.password === 'string' ? options.password : ''
  const passwordProtected = password.length > 0
  const includeAttachments = options.includeAttachments !== false
  const limits = req.limits ?? DEFAULT_ARCHIVE_LIMITS
  const db = req.db ?? prisma

  const snapshot = await collectWorkspaceSnapshot(req)
  const warnings = [...snapshot.warnings]
  const skipped: SkippedFile[] = []
  const redactions = snapshot.redactions
  const credentials = snapshot.credentials

  const dir = mkdtempSync(join(tmpdir(), 'shogo-workspace-export-'))
  const plainPath = join(dir, 'workspace.zip')
  const writer = new ArchiveWriter(plainPath, limits)
  const attachmentEntries: WorkspaceExportManifest['attachments'] = []
  let attachmentCount = 0
  let fileCount = 0
  let attachmentsDropped = 0

  const exportedAt = new Date().toISOString()
  const modelStats: WorkspaceExportManifest['models'] = {}
  for (const [model, entry] of Object.entries(WORKSPACE_EXPORT_MANIFEST)) {
    modelStats[model] = { decision: entry.decision, reason: entry.reason, rows: 0, bytes: 0 }
  }

  try {
    // Member rows carry only the other instance's user id, so the archive
    // records the names and emails an import needs to match people up. `User`
    // rows themselves are never exported.
    const memberRows = snapshot.rows.get('Member') ?? []
    const memberUserIds = [...new Set(memberRows.map((row) => String(row.userId ?? '')).filter(Boolean))]
    const memberUsers: Array<{ id: string; email: string | null; name: string | null }> =
      memberUserIds.length
        ? await db.user
            .findMany({
              where: { id: { in: memberUserIds } },
              select: { id: true, email: true, name: true },
            })
            .catch(() => [])
        : []
    const userById = new Map(memberUsers.map((user) => [user.id, user]))
    const members = memberRows.map((row) => {
      const user = userById.get(String(row.userId ?? ''))
      return {
        id: String(row.id),
        email: user?.email ?? null,
        name: user?.name ?? null,
        role: row.role,
        isBillingAdmin: row.isBillingAdmin,
      }
    })

    await writer.addJson(WORKSPACE_ARCHIVE_ENTRY, {
      id: snapshot.workspace.id,
      name: snapshot.workspace.name,
      kind: snapshot.workspace.kind,
      exportedAt,
      formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      projects: snapshot.projects.map((p) => ({ id: p.id, name: p.name })),
      members,
      counts: { models: INCLUDED_MODELS.length, rows: 0 },
      options: {
        includeAllDms: !!options.includeAllDms && req.isOwner,
        includeAttachments,
        passwordProtected,
      },
    })

    // ─── Chat attachment bytes ─────────────────────────────────────
    // Runs before `data/ChatMessage.json` is written so the rows shipped in the
    // archive already carry `attachment://` references instead of inlined
    // bytes. One attachment is read, compressed and released at a time.
    if (includeAttachments) {
      const { exportChatPartsWithAttachments } = await import('../../lib/chat-attachments')
      for (const message of snapshot.rows.get('ChatMessage') ?? []) {
        if (!message.parts) continue
        const result = await exportChatPartsWithAttachments(message.parts)
        message.parts = result.parts ?? message.parts
        for (const attachment of result.attachments) {
          const name = safeName(
            String(attachment.key).split('/').pop() || 'attachment',
            'attachment',
          )
          const path = `attachments/${safeName(String(message.id), 'message')}__${name}`
          const bytes =
            (attachment.dataUrl ? dataUrlToBytes(attachment.dataUrl) : null) ??
            (await readArtifactBytes(attachment.key))
          if (!bytes) {
            attachmentsDropped++
            warnings.push(
              `Attachment ${attachment.key} could not be read from object storage and is referenced but not included.`,
            )
            continue
          }
          await writer.addBytes(path, bytes)
          attachmentCount++
          attachmentEntries.push({
            path,
            key: attachment.key,
            mimeType: attachment.mimeType,
            bytes: bytes.byteLength,
          })
        }
      }
    }

    // ─── Model rows ────────────────────────────────────────────────
    for (const model of INCLUDED_MODELS) {
      const rows = snapshot.rows.get(model) ?? []
      const text = JSON.stringify(rows)
      await writer.addBytes(`data/${model}.json`, new TextEncoder().encode(text))
      modelStats[model].rows = rows.length
      modelStats[model].bytes = Buffer.byteLength(text)
    }

    // ─── Workspace root files ──────────────────────────────────────
    const rootResolution = ((): { dir: string | null; candidates: string[] } => {
      if (req.workspaceRootOverride !== undefined) {
        return { dir: req.workspaceRootOverride, candidates: req.workspaceRootOverride ? [req.workspaceRootOverride] : [] }
      }
      if (isKubernetes()) {
        // Cloud keeps workspace files in the workspace pod; there is no local
        // merged root to probe, so the pod path is used below.
        return { dir: null, candidates: [] }
      }
      const resolved = resolveWorkspaceRoot(snapshot.workspace.id, snapshot.projectIds)
      warnings.push(...resolved.warnings)
      return { dir: resolved.dir, candidates: resolved.candidates }
    })()

    const workspaceRootFiles: Record<string, Uint8Array> = {}
    if (rootResolution.dir) {
      Object.assign(
        workspaceRootFiles,
        collectWorkspaceRootFiles(rootResolution.dir, snapshot.projectIds, skipped),
      )
    } else if (isKubernetes()) {
      const pod = await collectWorkspacePodFiles(snapshot.workspace.id, snapshot.projectIds, skipped)
      Object.assign(workspaceRootFiles, pod.files)
      warnings.push(...pod.warnings)
    } else {
      warnings.push(
        'No workspace root directory was found on disk, so workspace-level files (AGENTS.md, MEMORY.md, .shogo/, memory/) are not in this archive.',
      )
    }
    for (const [relPath, data] of Object.entries(workspaceRootFiles)) {
      await writer.addBytes(`workspace/${relPath}`, data)
      fileCount++
    }
    if (!Object.keys(workspaceRootFiles).length) {
      warnings.push('The workspace root contributed no files.')
    }

    // ─── Projects ──────────────────────────────────────────────────
    const projectStats: WorkspaceExportManifest['projects'] = []
    const chatSessionsByProject = new Map<string, Array<Record<string, any>>>()
    for (const session of snapshot.rows.get('ChatSession') ?? []) {
      const contextId = String(session.contextId ?? '')
      if (session.contextType !== 'project' || !contextId) continue
      const list = chatSessionsByProject.get(contextId) ?? []
      list.push(session)
      chatSessionsByProject.set(contextId, list)
    }
    const messagesBySession = new Map<string, Array<Record<string, any>>>()
    for (const message of snapshot.rows.get('ChatMessage') ?? []) {
      const key = String(message.sessionId ?? '')
      const list = messagesBySession.get(key) ?? []
      list.push(message)
      messagesBySession.set(key, list)
    }

    for (const project of snapshot.projects) {
      const projectJson = {
        project: (snapshot.rows.get('Project') ?? []).find((row) => row.id === project.id) ?? null,
        agentConfig:
          (snapshot.rows.get('AgentConfig') ?? []).find((row) => row.projectId === project.id) ?? null,
        projectFolders: (snapshot.rows.get('ProjectFolder') ?? []).filter(
          (row) => row.projectId === project.id,
        ),
        customDomains: (snapshot.rows.get('CustomDomain') ?? []).filter(
          (row) => row.projectId === project.id,
        ),
      }
      await writer.addJson(`projects/${project.id}/project.json`, projectJson)

      const sources = await collectExportWorkspaceFiles(project.id, {
        workspaceDir: project.folderPath ?? join(workspacesDir(), project.id),
      })
      let projectFiles = 0
      let projectBytes = 0
      if (sources.sourceMode === 'k8s-fallback-empty') {
        warnings.push(
          `Project ${project.id} could not be read from its runtime: ${sources.warnings.join(' ')}`,
        )
      }
      // A folder-linked project with no runtime keeps its tree on this machine.
      const files =
        Object.keys(sources.files).length === 0 && project.folderPath
          ? collectFolderLinkedFiles(project.folderPath, skipped)
          : sources.files

      for (const [relPath, data] of Object.entries(files)) {
        let payload = data
        if (!passwordProtected && isEnvFile(relPath)) {
          const { text, redacted } = redactEnvText(new TextDecoder().decode(data))
          if (redacted.length) {
            payload = new TextEncoder().encode(text)
            for (const key of redacted) {
              credentials.push({
                channel: `projects/${project.id}/files/${relPath}`,
                field: key,
                label: `env.${key}`,
              })
            }
          }
        }
        await writer.addBytes(`projects/${project.id}/files/${relPath}`, payload)
        projectFiles++
        projectBytes += payload.byteLength
        fileCount++
      }
      skipped.push(...sources.fileSkipped)

      // Human-browsable transcript next to the project's files.
      for (const session of chatSessionsByProject.get(project.id) ?? []) {
        const messages = messagesBySession.get(String(session.id)) ?? []
        await writer.addJson(`projects/${project.id}/chats/${session.id}.json`, {
          session,
          messages,
        })
      }

      projectStats.push({
        id: project.id,
        name: project.name,
        files: projectFiles,
        bytes: projectBytes,
        sourceMode: sources.sourceMode,
      })
    }

    // Workspace-scoped agent sessions (not attached to any project).
    for (const session of snapshot.rows.get('ChatSession') ?? []) {
      if (session.contextType === 'project') continue
      const messages = messagesBySession.get(String(session.id)) ?? []
      await writer.addJson(`workspace-chats/${session.id}.json`, { session, messages })
    }

    // ─── Channel attachments ───────────────────────────────────────
    if (includeAttachments) {
      for (const row of snapshot.rows.get('ConversationAttachment') ?? []) {
        const key = typeof row.storageKey === 'string' ? row.storageKey : ''
        if (!key) continue
        const bytes = await readArtifactBytes(key)
        if (!bytes) {
          attachmentsDropped++
          warnings.push(
            `Channel attachment ${row.id} could not be read from object storage and is referenced but not included.`,
          )
          continue
        }
        const path = `attachments/${safeName(String(row.id), 'attachment')}__${safeName(
          String(row.name || 'attachment'),
          'attachment',
        )}`
        await writer.addBytes(path, bytes)
        attachmentCount++
        attachmentEntries.push({
          path,
          key,
          mimeType: String(row.mimeType || 'application/octet-stream'),
          bytes: bytes.byteLength,
        })
      }
    }

    if (credentials.length) {
      await writer.addJson(CREDENTIALS_REQUIRED_ENTRY, {
        note: 'These values were redacted from the archive. Set them again after import.',
        credentials,
      })
    }

    const totalRows = [...snapshot.rows.values()].reduce((sum, rows) => sum + rows.length, 0)

    await writer.addBytes(
      WORKSPACE_README_ENTRY,
      new TextEncoder().encode(
        renderReadme({
          workspace: snapshot.workspace,
          exportedAt,
          projects: projectStats,
          models: modelStats,
          rows: totalRows,
          files: fileCount,
          attachments: attachmentCount,
          attachmentsDropped,
          passwordProtected,
          warnings,
          credentials,
        }),
      ),
    )

    const beforeManifest = { bytes: writer.uncompressedBytes, entries: [...writer.entriesForManifest()] }
    const manifest: WorkspaceExportManifest = {
      formatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      exportedAt,
      workspace: snapshot.workspace,
      options: {
        includeAllDms: !!options.includeAllDms && req.isOwner,
        includeAttachments,
        passwordProtected,
        redacted: !passwordProtected,
      },
      counts: {
        models: INCLUDED_MODELS.length,
        rows: totalRows,
        files: fileCount,
        attachments: attachmentCount,
        bytes: beforeManifest.bytes,
      },
      models: modelStats,
      insertOrder: insertOrder(),
      projects: projectStats,
      files: { count: fileCount, totalBytes: beforeManifest.bytes, skipped },
      attachments: attachmentEntries,
      workspaceRoot: rootResolution,
      warnings: [...new Set(warnings)],
      redactions,
      encryption: passwordProtected ? 'zipcrypto' : 'none',
      entries: beforeManifest.entries,
    }
    await writer.addJson(WORKSPACE_MANIFEST_ENTRY, manifest)
    const finished = await writer.finish()
    manifest.entries = finished.entries
    manifest.counts.bytes = finished.bytes

    if (!passwordProtected) {
      return { tempPath: plainPath, bytes: finished.bytes, manifest }
    }

    // ZipCrypto needs the whole entry map; it re-reads the plain archive we
    // just wrote. Bounded by the same byte cap that gated the write.
    const { encryptZipCrypto } = await import('../../lib/zip-encryption')
    const { unzipSync } = await import('fflate')
    const encrypted = await encryptZipCrypto(
      unzipSync(new Uint8Array(readFileSync(plainPath))),
      password,
    )
    const encryptedPath = join(dir, 'workspace-encrypted.zip')
    writeFileSync(encryptedPath, encrypted)
    rmSync(plainPath, { force: true })
    return { tempPath: encryptedPath, bytes: encrypted.byteLength, manifest }
  } catch (err) {
    writer.abort()
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

function renderReadme(input: {
  workspace: { id: string; name: string; kind: string }
  exportedAt: string
  projects: WorkspaceExportManifest['projects']
  models: WorkspaceExportManifest['models']
  rows: number
  files: number
  attachments: number
  attachmentsDropped: number
  passwordProtected: boolean
  warnings: string[]
  credentials: RequiredCredential[]
}): string {
  const included = Object.entries(input.models).filter(([, m]) => m.decision === 'include')
  const excluded = Object.entries(input.models).filter(([, m]) => m.decision === 'exclude')
  const lines: string[] = []
  lines.push(`# ${input.workspace.name} — workspace export`)
  lines.push('')
  lines.push(`Exported ${input.exportedAt} · format ${WORKSPACE_EXPORT_FORMAT_VERSION}`)
  lines.push('')
  lines.push('## What is inside')
  lines.push('')
  lines.push(
    `- ${input.projects.length} project(s), ${input.files} file(s), ${input.attachments} attachment(s)`,
  )
  lines.push(`- ${input.rows} database row(s) across ${included.length} models, one file per model in \`data/\``)
  if (input.attachmentsDropped) {
    lines.push(`- ${input.attachmentsDropped} attachment(s) could not be read from object storage`)
  }
  lines.push('')
  lines.push('## What is not inside')
  lines.push('')
  lines.push(
    'Credentials (tokens, passwords, key hashes, invite-link codes, webhook secrets) are ' +
      (input.passwordProtected
        ? 'included in place because this archive is password-protected.'
        : 'redacted. See `credentials-required.json` for every value to set again after import.'),
  )
  lines.push('')
  lines.push(
    'Other members\' direct messages are excluded unless a workspace owner asked for them. ' +
      'Billing, metering, runtime state, telemetry and global instance catalogs are not workspace content.',
  )
  lines.push('')
  lines.push('## Excluded models')
  lines.push('')
  for (const [model, entry] of excluded) {
    lines.push(`- \`${model}\` — ${entry.reason}`)
  }
  if (input.warnings.length) {
    lines.push('')
    lines.push('## Warnings')
    lines.push('')
    for (const warning of input.warnings) lines.push(`- ${warning}`)
  }
  if (input.credentials.length) {
    lines.push('')
    lines.push('## Values to set again after import')
    lines.push('')
    for (const credential of input.credentials) {
      lines.push(`- \`${credential.field}\` (${credential.channel})`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** Cheap size/count preview for the settings screen. Never builds the archive. */
export async function estimateWorkspaceExport(workspaceId: string, db: any = prisma): Promise<{
  workspace: { id: string; name: string; kind: string }
  models: Array<{ model: string; rows: number }>
  projects: Array<{ id: string; name: string; files: number; bytes: number }>
  totals: { rows: number; files: number; bytes: number }
  warnings: string[]
}> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, kind: true },
  })
  if (!workspace) throw new WorkspaceExportError('Workspace not found', 404, 'workspace_not_found')

  const projects: Array<{ id: string; name: string }> = await db.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
  })
  const projectIds = projects.map((p) => p.id)
  const warnings: string[] = []
  const models: Array<{ model: string; rows: number }> = []
  let rows = 0

  for (const model of INCLUDED_MODELS) {
    const scope = scopeFor(model)
    const client = modelClient(model, db)
    if (!scope || !client?.count) continue
    try {
      const where =
        scope.kind === 'workspace-row'
          ? { id: workspaceId }
          : scope.kind === 'workspace'
            ? { workspaceId }
            : scope.kind === 'project'
              ? { projectId: { in: projectIds } }
              : null
      if (!where) continue
      const count = await client.count({ where })
      models.push({ model, rows: count })
      rows += count
    } catch {
      warnings.push(`Could not count ${model}.`)
    }
  }

  const projectStats: Array<{ id: string; name: string; files: number; bytes: number }> = []
  let files = 0
  let bytes = 0
  const folders: Array<{ projectId: string; path: string }> = await db.projectFolder
    .findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, path: true } })
    .catch(() => [])
  const folderByProject = new Map(folders.map((f) => [f.projectId, f.path]))
  for (const project of projects) {
    const dir = folderByProject.get(project.id) ?? join(workspacesDir(), project.id)
    let projectBytes = 0
    let projectFiles = 0
    if (existsSync(dir)) {
      const walk = (path: string) => {
        let entries
        try {
          entries = readdirSync(path, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(path, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.isFile()) {
            try {
              projectBytes += statSync(full).size
              projectFiles++
            } catch {
              /* ignore */
            }
          }
        }
      }
      walk(dir)
    }
    projectStats.push({ ...project, files: projectFiles, bytes: projectBytes })
    files += projectFiles
    bytes += projectBytes
  }

  return {
    workspace,
    models,
    projects: projectStats,
    totals: { rows, files, bytes },
    warnings,
  }
}

/** SHA-256 of a file on disk, used by tests and by the import verifier. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
