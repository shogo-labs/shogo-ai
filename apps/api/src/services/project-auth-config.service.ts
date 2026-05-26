// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectAuthConfig service — per-project sign-in allowlist for users
 * authenticating via the Shogo SDK (`shogo.auth` -> platform
 * `/api/auth/*`).
 *
 * The Better Auth before-hook in apps/api/src/auth.ts calls
 * `evaluateAllowlist()` on every project-scoped sign-in / sign-up; the
 * Studio UI calls `getConfig()` / `upsertConfig()` to render and update
 * the allowlist from the project's Settings -> Auth & Database pane.
 *
 * Storage shape (PG):  ProjectAuthConfig with allowedEmails / allowedDomains
 *                      as TEXT[].
 * Storage shape (SQLite): same model, columns stored as JSON-encoded TEXT.
 *                      apps/api/src/lib/prisma.ts ARRAY_FIELDS handles
 *                      parse/stringify on read/write transparently, so
 *                      this module always sees String[].
 */

import { prisma } from '../lib/prisma'

export type ProjectAuthMode = 'anyone' | 'workspace' | 'custom'

export interface ProjectAuthConfigData {
  mode: ProjectAuthMode
  allowedEmails: string[]
  allowedDomains: string[]
  requireEmailVerification: boolean
}

const DEFAULT_CONFIG: ProjectAuthConfigData = {
  mode: 'anyone',
  allowedEmails: [],
  allowedDomains: [],
  requireEmailVerification: false,
}

const VALID_MODES: ReadonlySet<ProjectAuthMode> = new Set(['anyone', 'workspace', 'custom'])

// RFC-lite email pattern. Mirrors what Better Auth itself accepts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Domain pattern. Allows subdomains, requires at least one dot.
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/

export class ProjectAuthConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ProjectAuthConfigError'
  }
}

/**
 * Lowercases and validates a single email address. Throws
 * ProjectAuthConfigError with code `invalid_email` on bad input.
 */
function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProjectAuthConfigError('invalid_email', `Email must be a string, got ${typeof raw}`)
  }
  const lower = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(lower)) {
    throw new ProjectAuthConfigError('invalid_email', `Not a valid email address: "${raw}"`)
  }
  return lower
}

/**
 * Lowercases, strips a leading `@`, and validates a single domain.
 * Throws ProjectAuthConfigError with code `invalid_domain` on bad input.
 */
function normalizeDomain(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProjectAuthConfigError('invalid_domain', `Domain must be a string, got ${typeof raw}`)
  }
  const lower = raw.trim().toLowerCase().replace(/^@/, '')
  if (!DOMAIN_RE.test(lower)) {
    throw new ProjectAuthConfigError('invalid_domain', `Not a valid domain: "${raw}"`)
  }
  return lower
}

/**
 * Get the project's auth-config. Returns the default ("anyone")
 * when no row exists so callers don't have to special-case absence.
 */
export async function getConfig(projectId: string): Promise<ProjectAuthConfigData> {
  const row = await prisma.projectAuthConfig.findUnique({ where: { projectId } })
  if (!row) return { ...DEFAULT_CONFIG }
  return {
    mode: (VALID_MODES.has(row.mode as ProjectAuthMode) ? row.mode : 'anyone') as ProjectAuthMode,
    allowedEmails: Array.isArray(row.allowedEmails) ? row.allowedEmails : [],
    allowedDomains: Array.isArray(row.allowedDomains) ? row.allowedDomains : [],
    requireEmailVerification: !!row.requireEmailVerification,
  }
}

export interface UpsertConfigInput {
  mode?: unknown
  allowedEmails?: unknown
  allowedDomains?: unknown
  requireEmailVerification?: unknown
}

/**
 * Upsert the project's auth-config. Validates and normalizes input;
 * de-duplicates the email and domain lists.
 */
export async function upsertConfig(
  projectId: string,
  input: UpsertConfigInput,
): Promise<ProjectAuthConfigData> {
  const existing = await prisma.projectAuthConfig.findUnique({ where: { projectId } })

  let mode: ProjectAuthMode = (existing?.mode as ProjectAuthMode | undefined) ?? 'anyone'
  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !VALID_MODES.has(input.mode as ProjectAuthMode)) {
      throw new ProjectAuthConfigError(
        'invalid_mode',
        `mode must be one of "anyone" | "workspace" | "custom"`,
      )
    }
    mode = input.mode as ProjectAuthMode
  }

  let allowedEmails: string[] = Array.isArray(existing?.allowedEmails) ? existing!.allowedEmails : []
  if (input.allowedEmails !== undefined) {
    if (!Array.isArray(input.allowedEmails)) {
      throw new ProjectAuthConfigError('invalid_emails', 'allowedEmails must be an array')
    }
    const seen = new Set<string>()
    allowedEmails = []
    for (const raw of input.allowedEmails) {
      const e = normalizeEmail(raw)
      if (!seen.has(e)) {
        seen.add(e)
        allowedEmails.push(e)
      }
    }
  }

  let allowedDomains: string[] = Array.isArray(existing?.allowedDomains) ? existing!.allowedDomains : []
  if (input.allowedDomains !== undefined) {
    if (!Array.isArray(input.allowedDomains)) {
      throw new ProjectAuthConfigError('invalid_domains', 'allowedDomains must be an array')
    }
    const seen = new Set<string>()
    allowedDomains = []
    for (const raw of input.allowedDomains) {
      const d = normalizeDomain(raw)
      if (!seen.has(d)) {
        seen.add(d)
        allowedDomains.push(d)
      }
    }
  }

  let requireEmailVerification = !!existing?.requireEmailVerification
  if (input.requireEmailVerification !== undefined) {
    if (typeof input.requireEmailVerification !== 'boolean') {
      throw new ProjectAuthConfigError(
        'invalid_require_email_verification',
        'requireEmailVerification must be a boolean',
      )
    }
    requireEmailVerification = input.requireEmailVerification
  }

  await prisma.projectAuthConfig.upsert({
    where: { projectId },
    create: {
      projectId,
      mode,
      allowedEmails,
      allowedDomains,
      requireEmailVerification,
    },
    update: {
      mode,
      allowedEmails,
      allowedDomains,
      requireEmailVerification,
    },
  })

  return { mode, allowedEmails, allowedDomains, requireEmailVerification }
}

export interface AllowlistEvaluation {
  allowed: boolean
  reason?: 'workspace_not_member' | 'custom_not_listed' | 'email_invalid'
}

/**
 * Decide whether the given email is allowed to sign in / sign up for
 * the given project, based on the project's `ProjectAuthConfig`.
 *
 * Modes:
 *   - `anyone`     -> always allowed
 *   - `workspace`  -> allowed iff the email already corresponds to a
 *                     User who has a Member row in the project's
 *                     workspace, OR there is a pending Invitation
 *                     scoped to that workspace for this email.
 *   - `custom`     -> allowed iff the email is in `allowedEmails` OR
 *                     the email's domain is in `allowedDomains`.
 *
 * `null` config (no row) is treated as `anyone`.
 */
export async function evaluateAllowlist(
  projectId: string,
  email: string,
): Promise<AllowlistEvaluation> {
  const lower = email.trim().toLowerCase()
  if (!EMAIL_RE.test(lower)) {
    return { allowed: false, reason: 'email_invalid' }
  }

  const cfg = await getConfig(projectId)
  if (cfg.mode === 'anyone') return { allowed: true }

  if (cfg.mode === 'custom') {
    if (cfg.allowedEmails.includes(lower)) return { allowed: true }
    const domain = lower.split('@')[1] ?? ''
    if (domain && cfg.allowedDomains.includes(domain)) return { allowed: true }
    return { allowed: false, reason: 'custom_not_listed' }
  }

  // mode === 'workspace'
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) return { allowed: false, reason: 'workspace_not_member' }

  const user = await prisma.user.findUnique({ where: { email: lower }, select: { id: true } })
  if (user) {
    const member = await prisma.member.findFirst({
      where: { userId: user.id, workspaceId: project.workspaceId },
      select: { id: true },
    })
    if (member) return { allowed: true }
  }

  const invitation = await prisma.invitation.findFirst({
    where: {
      email: lower,
      workspaceId: project.workspaceId,
      status: 'pending',
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  })
  if (invitation) return { allowed: true }

  return { allowed: false, reason: 'workspace_not_member' }
}

/**
 * Stamp a successful project-scoped sign-in. Idempotent: increments
 * `signInCount` and bumps `lastSignInAt` on subsequent sign-ins.
 *
 * Failures here are non-fatal (auth has already succeeded by the time
 * the after-hook runs); callers should swallow errors.
 */
export async function recordSignIn(projectId: string, userId: string): Promise<void> {
  const now = new Date()
  await prisma.projectAuthSignIn.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: { projectId, userId, firstSignInAt: now, lastSignInAt: now, signInCount: 1 },
    update: { lastSignInAt: now, signInCount: { increment: 1 } },
  })
}

export interface ProjectAuthUserRow {
  userId: string
  email: string
  name: string | null
  emailVerified: boolean
  firstSignInAt: Date
  lastSignInAt: Date
  signInCount: number
  isWorkspaceMember: boolean
  isAllowlisted: boolean
}

export interface ListProjectAuthUsersOptions {
  cursor?: string
  limit?: number
  query?: string
}

/**
 * Page through users who have signed in to this project via the SDK.
 * Joins User for the email/name display, plus a workspace-membership
 * boolean and an allowlist-membership boolean for the row UI.
 */
export async function listUsers(
  projectId: string,
  opts: ListProjectAuthUsersOptions = {},
): Promise<{ items: ProjectAuthUserRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })
  if (!project) {
    return { items: [], nextCursor: null }
  }

  const cfg = await getConfig(projectId)
  const allowEmails = new Set(cfg.allowedEmails)
  const allowDomains = new Set(cfg.allowedDomains)

  const queryFilter = opts.query?.trim()
    ? {
        user: {
          OR: [
            { email: { contains: opts.query.trim(), mode: 'insensitive' as const } },
            { name: { contains: opts.query.trim(), mode: 'insensitive' as const } },
          ],
        },
      }
    : {}

  const rows = await prisma.projectAuthSignIn.findMany({
    where: { projectId, ...queryFilter },
    include: { user: { select: { id: true, email: true, name: true, emailVerified: true } } },
    orderBy: { lastSignInAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  })

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows

  const userIds = visible.map((r) => r.userId)
  const memberRows = userIds.length
    ? await prisma.member.findMany({
        where: { userId: { in: userIds }, workspaceId: project.workspaceId },
        select: { userId: true },
      })
    : []
  const memberSet = new Set(memberRows.map((m) => m.userId))

  const items: ProjectAuthUserRow[] = visible.map((r) => {
    const email = (r.user.email ?? '').toLowerCase()
    const domain = email.split('@')[1] ?? ''
    return {
      userId: r.userId,
      email: r.user.email ?? '',
      name: r.user.name,
      emailVerified: !!r.user.emailVerified,
      firstSignInAt: r.firstSignInAt,
      lastSignInAt: r.lastSignInAt,
      signInCount: r.signInCount,
      isWorkspaceMember: memberSet.has(r.userId),
      isAllowlisted: allowEmails.has(email) || (!!domain && allowDomains.has(domain)),
    }
  })

  return {
    items,
    nextCursor: hasMore ? visible[visible.length - 1]!.id : null,
  }
}

/**
 * Revoke a user's access to this project: delete the audit row (so
 * they no longer appear in the Users panel) and invalidate any active
 * Better Auth sessions for that user. Note this does NOT remove them
 * from the allowlist if they're explicitly listed — call
 * `removeFromAllowlist` separately for that.
 */
export async function revokeUser(projectId: string, userId: string): Promise<void> {
  await prisma.projectAuthSignIn.deleteMany({ where: { projectId, userId } })
  await prisma.session.deleteMany({ where: { userId } })
}
