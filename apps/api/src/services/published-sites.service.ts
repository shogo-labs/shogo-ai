// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sites the DESKTOP builds and the cloud hosts (SHO-245).
 *
 * A desktop project's files live on the user's machine, so the cloud cannot
 * build it: `publishProject`'s pod build + dist download has nothing to talk to
 * (`getProjectPodUrl` points at a cloud pod that has never seen the project),
 * and the project is not cloud-linked. Forwarding the publish request therefore
 * could never work, which is why a cloud-connected desktop agent used to get a
 * bare `HTTP 404`.
 *
 * So the desktop builds and uploads, and this module hosts what arrives:
 *
 *   - Every desktop project that publishes gets a HIDDEN host Project row in
 *     the API key's workspace, tagged `settings.desktopSourceProjectId`. That
 *     row owns `publishedSubdomain`, so subdomain uniqueness, the Pro gate
 *     (`canPublishSubdomain`), the password gate, unpublish, the SHO-138 sweep
 *     and custom domains all keep working unchanged. No schema change.
 *   - The id is DERIVED from (workspace, source project) rather than reused
 *     from the desktop, because a machine-synced desktop project already has a
 *     row here with that id — the host must never be that row.
 *   - `publishProject` runs the normal pipeline against the uploaded files
 *     (`fileSource: 'uploaded'`), so S3 layout, provisioning and status
 *     reporting are the same code the cloud's own publishes use.
 *
 * Static only: a server-backed desktop project is refused rather than published
 * as a half-working site (it needs a cloud project to run its server).
 */

import { createHash } from 'node:crypto'
import { prisma } from '../lib/prisma'
import { encodeProjectSettingsForWrite, normalizeProjectSettings } from '../lib/project-settings'
import {
  ACCESS_LEVELS,
  publishProject,
  resolveSitePasswordHash,
  syncSitePasswordKv,
  unpublishProject,
  type AccessLevel,
  type PublishProjectResult,
} from '../routes/publish'

/** A build bundle the desktop produced, base64 per file (the shape `/agent/dist-files` returns). */
export interface UploadedSiteFile {
  path: string
  content: string
}

export interface UploadedSiteUpload {
  files: UploadedSiteFile[]
  subdomain?: string
  accessLevel?: AccessLevel
  password?: string
  siteTitle?: string
  siteDescription?: string
}

export interface PublishUploadedSiteInput {
  /** Workspace the API key belongs to. The host project is created/read here. */
  workspaceId: string
  /** The desktop's own project id. Only ever used as a tag, never as a row id. */
  sourceProjectId: string
  upload: UploadedSiteUpload
}

/** A whole bundle this big is almost certainly not a static site export. */
export const UPLOADED_SITE_MAX_TOTAL_BYTES = 100 * 1024 * 1024
/** Matches the runtime's per-file cap in `collectPublishDistFiles`. */
export const UPLOADED_SITE_MAX_FILE_BYTES = 50 * 1024 * 1024

/**
 * Deterministic host-project id for (workspace, desktop project).
 *
 * Derived instead of random so a republish finds its host without a JSON query
 * (Prisma cannot filter inside `settings` on SQLite), and so two API pods
 * racing the first publish converge on the same row.
 */
export function hostProjectIdFor(workspaceId: string, sourceProjectId: string): string {
  const digest = createHash('sha256')
    .update(`published-site:${workspaceId}:${sourceProjectId}`)
    .digest('hex')
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-')
}

interface HostProjectRow {
  id: string
  workspaceId: string
  hidden: boolean
  settings: unknown
  publishedSubdomain?: string | null
  publishedAt?: Date | null
  accessLevel?: string | null
  sitePasswordHash?: string | null
  publishStatus?: string | null
}

/** The desktop project id a hidden host row was created for, if it is one. */
function desktopSourceProjectIdOf(row: HostProjectRow | null): string | null {
  if (!row) return null
  const settings = normalizeProjectSettings(row.settings) as Record<string, unknown> | null
  const tagged = settings?.desktopSourceProjectId
  return typeof tagged === 'string' && tagged ? tagged : null
}

function isHostFor(row: HostProjectRow | null, workspaceId: string, sourceProjectId: string): boolean {
  if (!row) return false
  return (
    row.workspaceId === workspaceId &&
    row.hidden === true &&
    desktopSourceProjectIdOf(row) === sourceProjectId
  )
}

/**
 * Resolve (creating on first publish) the hidden host project that owns a
 * desktop project's published site.
 *
 * A row already sitting at the derived id that is NOT a host for this source
 * project is refused rather than adopted — adopting it would publish over a
 * real project.
 */
export async function resolveHostProject(
  workspaceId: string,
  sourceProjectId: string,
  opts: { create?: boolean } = {},
): Promise<{ ok: true; project: HostProjectRow } | { ok: false; status: number; code: string; message: string }> {
  const hostId = hostProjectIdFor(workspaceId, sourceProjectId)
  const existing = (await prisma.project.findUnique({
    where: { id: hostId },
  })) as HostProjectRow | null

  if (existing) {
    if (!isHostFor(existing, workspaceId, sourceProjectId)) {
      return {
        ok: false,
        status: 409,
        code: 'host_project_conflict',
        message: 'This project id is already used by another project in this workspace.',
      }
    }
    return { ok: true, project: existing }
  }

  if (!opts.create) {
    return { ok: false, status: 404, code: 'not_published', message: 'This project has not been published yet.' }
  }

  try {
    const created = (await prisma.project.create({
      data: {
        id: hostId,
        workspaceId,
        // Never surfaced in a project list; it exists to own publish state.
        name: `Published site (desktop ${sourceProjectId})`.slice(0, 120),
        hidden: true,
        settings: encodeProjectSettingsForWrite({
          desktopSourceProjectId: sourceProjectId,
          desktopPublishedSite: true,
        }),
      } as any,
    })) as HostProjectRow
    return { ok: true, project: created }
  } catch (err: any) {
    // Two API pods creating the same derived id: the loser re-reads the winner.
    const raced = (await prisma.project.findUnique({ where: { id: hostId } })) as HostProjectRow | null
    if (raced && isHostFor(raced, workspaceId, sourceProjectId)) return { ok: true, project: raced }
    return {
      ok: false,
      status: 500,
      code: 'host_project_create_failed',
      message: err?.message ?? 'Could not create the published site',
    }
  }
}

/** Reject anything that is not a plain relative POSIX path inside the bundle. */
function validateUploadPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.replace(/^\.\//, '')
  if (!path || path.length > 1024) return null
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  const segments = path.split('/')
  if (segments.some((s) => !s || s === '.' || s === '..')) return null
  return path
}

/**
 * Turn the uploaded file list into the `Map<string, Buffer>` the publish
 * pipeline uploads, refusing a bundle that is empty, malformed or too large.
 */
export function buildUploadFileMap(
  files: unknown,
): { ok: true; files: Map<string, Buffer> } | { ok: false; status: number; code: string; message: string } {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, status: 400, code: 'no_files', message: 'No files were uploaded to publish.' }
  }

  const out = new Map<string, Buffer>()
  let total = 0
  for (const entry of files as UploadedSiteFile[]) {
    const path = validateUploadPath(entry?.path)
    if (!path) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_file_path',
        message: 'Every published file needs a relative path inside the bundle.',
      }
    }
    if (typeof entry?.content !== 'string') {
      return { ok: false, status: 400, code: 'invalid_file_content', message: `File ${path} has no content.` }
    }
    const buffer = Buffer.from(entry.content, 'base64')
    if (buffer.length > UPLOADED_SITE_MAX_FILE_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'file_too_large',
        message: `${path} is larger than ${Math.round(UPLOADED_SITE_MAX_FILE_BYTES / 1024 / 1024)} MB.`,
      }
    }
    total += buffer.length
    if (total > UPLOADED_SITE_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'bundle_too_large',
        message: `The published bundle is larger than ${Math.round(UPLOADED_SITE_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`,
      }
    }
    out.set(path, buffer)
  }

  if (!out.has('index.html')) {
    return {
      ok: false,
      status: 400,
      code: 'no_index_html',
      message: 'The bundle has no index.html, so the published site would render nothing.',
    }
  }

  return { ok: true, files: out }
}

/**
 * Publish (or republish) a site the desktop built.
 *
 * `upload.subdomain` is optional: omit it on a republish and the host project's
 * live subdomain is reused, which is what the agent's `publish` tool expects
 * when the user says "publish it again".
 */
export async function publishUploadedSite(input: PublishUploadedSiteInput): Promise<
  PublishProjectResult & { hostProjectId?: string }
> {
  const { workspaceId, sourceProjectId, upload } = input
  if (!sourceProjectId || typeof sourceProjectId !== 'string') {
    return { ok: false, status: 400, code: 'invalid_source_project', message: 'A source project id is required.' }
  }

  const built = buildUploadFileMap(upload?.files)
  if (!built.ok) return built

  const resolved = await resolveHostProject(workspaceId, sourceProjectId, { create: true })
  if (!resolved.ok) return resolved
  const host = resolved.project

  const requestedSubdomain = typeof upload.subdomain === 'string' ? upload.subdomain.trim() : ''
  const subdomain = requestedSubdomain || host.publishedSubdomain || ''
  if (!subdomain) {
    return {
      ok: false,
      status: 400,
      code: 'subdomain_required',
      message: 'A subdomain is required for the first publish.',
    }
  }

  const result = await publishProject(
    host.id,
    {
      subdomain,
      accessLevel: upload.accessLevel,
      password: upload.password,
      siteTitle: upload.siteTitle,
      siteDescription: upload.siteDescription,
    },
    { kind: 'uploaded', files: built.files, serverBacked: false },
  )

  return { ...result, hostProjectId: host.id }
}

/** Take a desktop-published site down and clear its host row. */
export async function unpublishUploadedSite(input: {
  workspaceId: string
  sourceProjectId: string
}): Promise<PublishProjectResult & { hostProjectId?: string }> {
  const resolved = await resolveHostProject(input.workspaceId, input.sourceProjectId, { create: false })
  if (!resolved.ok) return resolved
  const result = await unpublishProject(resolved.project.id)
  return { ...result, hostProjectId: resolved.project.id }
}

/**
 * Change a hosted site's visitor settings (access level, password, title,
 * description) without rebuilding it. Same rules as the cloud's own
 * `PATCH /projects/:id/publish`: the password hash is salted by subdomain, so a
 * password can only be carried over when the subdomain is unchanged.
 */
export async function updateUploadedSiteSettings(input: {
  workspaceId: string
  sourceProjectId: string
  settings: {
    accessLevel?: AccessLevel
    password?: string
    siteTitle?: string
    siteDescription?: string
  }
}): Promise<
  | { ok: true; subdomain: string; accessLevel: AccessLevel; hasPassword: boolean; siteTitle: string | null; siteDescription: string | null }
  | { ok: false; status: number; code: string; message: string }
> {
  const { accessLevel, password, siteTitle, siteDescription } = input.settings
  if (accessLevel !== undefined && !ACCESS_LEVELS.has(accessLevel)) {
    return { ok: false, status: 400, code: 'invalid_access_level', message: `Unknown access level: ${accessLevel}` }
  }

  const resolved = await resolveHostProject(input.workspaceId, input.sourceProjectId, { create: false })
  if (!resolved.ok) return resolved
  const host = resolved.project as HostProjectRow
  if (!host.publishedSubdomain) {
    return { ok: false, status: 400, code: 'not_published', message: 'This project is not published.' }
  }

  const updates: Record<string, unknown> = {}
  if (accessLevel !== undefined) updates.accessLevel = accessLevel
  if (siteTitle !== undefined) updates.siteTitle = siteTitle
  if (siteDescription !== undefined) updates.siteDescription = siteDescription

  let sync: { subdomain: string; accessLevel: AccessLevel; hash: string | null } | null = null
  if (accessLevel !== undefined || password !== undefined) {
    const effective = (accessLevel ?? (host.accessLevel as AccessLevel) ?? 'anyone') as AccessLevel
    const hash = resolveSitePasswordHash({
      accessLevel: effective,
      password,
      subdomain: host.publishedSubdomain,
      existingHash: host.sitePasswordHash ?? null,
      existingSubdomain: host.publishedSubdomain,
    })
    if (!hash.ok) return { ok: false, status: 400, code: hash.code, message: hash.message }
    updates.sitePasswordHash = hash.hash
    sync = { subdomain: host.publishedSubdomain, accessLevel: effective, hash: hash.hash }
  }

  const updated = (await prisma.project.update({
    where: { id: host.id },
    data: updates as any,
  })) as HostProjectRow

  if (sync) await syncSitePasswordKv(sync.subdomain, sync.accessLevel, sync.hash)

  return {
    ok: true,
    subdomain: host.publishedSubdomain,
    accessLevel: (updated.accessLevel ?? 'anyone') as AccessLevel,
    hasPassword: !!updated.sitePasswordHash,
    siteTitle: (updated as any).siteTitle ?? null,
    siteDescription: (updated as any).siteDescription ?? null,
  }
}

/**
 * Publish state of a desktop project's hosted site, in the same shape the
 * desktop's own `GET /api/projects/:id/publish` answers.
 */
export async function getUploadedSiteState(input: {
  workspaceId: string
  sourceProjectId: string
}) {
  const resolved = await resolveHostProject(input.workspaceId, input.sourceProjectId, { create: false })
  if (!resolved.ok) {
    return {
      ok: true as const,
      published: false,
      subdomain: null,
      publishedAt: null,
      accessLevel: null,
      hasPassword: false,
      publishStatus: null,
      hostProjectId: null,
    }
  }
  const host = resolved.project
  return {
    ok: true as const,
    published: !!host.publishedSubdomain,
    subdomain: host.publishedSubdomain ?? null,
    publishedAt: host.publishedAt ? new Date(host.publishedAt).getTime() : null,
    accessLevel: host.accessLevel ?? null,
    hasPassword: !!host.sitePasswordHash,
    publishStatus: host.publishStatus ?? null,
    hostProjectId: host.id,
  }
}
