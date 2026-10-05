// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pick the credential an agent's tool call uses on an integration by walking
 * the project's chain for the op (see `ChainStep`): the person who asked,
 * a connect link, an approval card, the project's delegate, the shared
 * account, or a refusal.
 *
 * The requester always comes from a signed ticket (see lib/requester-ticket),
 * never from the runtime's say-so. Every credential handed out is recorded
 * in the project's audit log.
 */

import { prisma } from '../../lib/prisma'
import { getPersonalConnection, getPolicy, hasActiveGrant } from './store'
import type { ChainStep, CredentialOp, CredentialProvider, CredentialSource, ResolveContext, ResolveResult } from './types'

export * from './types'
export {
  deletePersonalConnection,
  getPolicy,
  grantAccess,
  isValidProviderId,
  listPolicies,
  listUserIntegrations,
  PolicyValidationError,
  revokeGrant,
  savePolicy,
  setDelegate,
} from './store'

const providers: CredentialProvider[] = []

export function registerCredentialProvider(provider: CredentialProvider): void {
  const index = providers.findIndex((p) => p.id === provider.id)
  if (index >= 0) providers[index] = provider
  else providers.push(provider)
}

export function _resetCredentialProvidersForTests(): void {
  providers.length = 0
}

export function getCredentialProvider(provider: string): CredentialProvider | null {
  return (
    providers.find((p) => p.id === provider) ??
    providers.find((p) => p.id.endsWith(':') && provider.startsWith(p.id) && provider.length > p.id.length) ??
    null
  )
}

function publicApiBaseUrl(): string {
  return (process.env.SHOGO_PUBLIC_API_URL || process.env.BETTER_AUTH_URL || 'http://localhost:8002').replace(/\/+$/, '')
}

/**
 * The link a requester opens to connect their account and consent for this
 * project. `resume` (signed) says where to pick the conversation back up.
 */
export function personalConnectUrl(projectId: string, provider: string, resume?: string): string {
  const url = `${publicApiBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(provider)}/connect`
  return resume ? `${url}?resume=${encodeURIComponent(resume)}` : url
}

export interface ResolveArgs {
  projectId: string
  provider: string
  op: CredentialOp
  /** From a verified requester ticket; null when the turn has no known person. */
  requesterUserId: string | null
  /** Signed resume token for the connect link (see resume.ts). */
  resume?: string
  /**
   * False when nobody is there to follow a connect link (event-triggered
   * turns); `ask` steps are skipped and the chain moves on.
   */
  canAsk?: boolean
  /**
   * Posts an approval card for the `approve` step. Null (or absent) when the
   * turn has nowhere to post, and the step is skipped.
   */
  approve?: () => Promise<{ approvalId: string; expiresAt: string } | null>
  /**
   * Walk the chain again for someone who approved this call: they stand in
   * as the requester, `approve` is skipped, and the source is `approved`.
   */
  approval?: { approvalId: string; approverUserId: string; requesterUserId: string | null }
  /** The turn's origin, for the audit log. */
  origin?: unknown
}

async function sharedResult(adapter: CredentialProvider, ctx: ResolveContext): Promise<ResolveResult> {
  const credential = await adapter.shared(ctx)
  if (!credential) {
    return {
      ok: false,
      code: 'not_connected',
      message: `This project has no shared ${adapter.label(ctx.provider)} account connected.`,
    }
  }
  return { ok: true, source: 'shared', actingAs: 'project account', credential }
}

export async function resolveIntegrationCredential(args: ResolveArgs): Promise<ResolveResult> {
  const result = await walkChain(args)
  if (result.ok) await recordCredentialUse(args, result)
  return result
}

async function walkChain(args: ResolveArgs): Promise<ResolveResult> {
  const adapter = getCredentialProvider(args.provider)
  if (!adapter) {
    return { ok: true, source: 'shared', actingAs: 'project account', credential: {} }
  }
  const project = await prisma.project.findUnique({ where: { id: args.projectId }, select: { workspaceId: true } })
  if (!project) return { ok: false, code: 'not_connected', message: 'Project not found.' }

  const policy = await getPolicy(args.projectId, args.provider)
  const ctx: ResolveContext = { projectId: args.projectId, workspaceId: project.workspaceId, provider: args.provider, policy }
  // Someone who approved volunteered their own account: use it, or link them to connect it.
  const chain: readonly ChainStep[] = args.approval ? ['requester', 'ask'] : args.op === 'write' ? policy.writeChain : policy.readChain
  const label = adapter.label(args.provider)
  const requester = args.approval?.approverUserId ?? args.requesterUserId
  const personalSource: CredentialSource = args.approval ? 'approved' : 'personal'
  let sharedMissing: ResolveResult | null = null

  for (const step of chain) {
    if (step === 'requester') {
      if (!requester || !adapter.supportsPersonal) continue
      const personal = await personalCredential(adapter, ctx, requester)
      if (!personal) continue
      return {
        ok: true,
        source: personalSource,
        actingAs: personal.login ? `@${personal.login}` : 'the requester',
        userId: requester,
        credential: personal,
      }
    }
    if (step === 'ask') {
      if (!requester || !adapter.supportsPersonal || args.canAsk === false) continue
      return {
        ok: false,
        code: 'requester_auth_required',
        message: args.approval
          ? `Approving uses your own ${label} account. Connect it and allow this agent to use it, then run the step again.`
          : `This agent acts as the person who asked on ${label}. ` +
            `They need to connect their ${label} account and allow this agent to use it.`,
        connectUrl: personalConnectUrl(args.projectId, args.provider, args.resume),
      }
    }
    if (step === 'approve') {
      if (!adapter.supportsPersonal || !args.approve) continue
      const pending = await args.approve()
      if (!pending) continue
      return {
        ok: false,
        code: 'approval_pending',
        message: `Waiting for someone in the conversation to approve this with their own ${label} account.`,
        approvalId: pending.approvalId,
        expiresAt: pending.expiresAt,
      }
    }
    if (step === 'delegate') {
      const delegate = policy.delegateUserId
      if (!delegate || !adapter.supportsPersonal) continue
      if (!(await isWorkspaceMember(project.workspaceId, delegate))) continue
      const personal = await personalCredential(adapter, ctx, delegate)
      if (!personal) continue
      return {
        ok: true,
        source: 'delegate',
        actingAs: personal.login ? `@${personal.login}` : 'the delegate',
        userId: delegate,
        credential: personal,
      }
    }
    if (step === 'shared') {
      if (adapter.supportsShared === false) continue
      const shared = await sharedResult(adapter, ctx)
      if (shared.ok) {
        const onBehalfOf = requester ? await requesterDisplayName(requester) : null
        return onBehalfOf ? { ...shared, onBehalfOf } : shared
      }
      sharedMissing = shared
      continue
    }
    if (step === 'deny') break
  }

  if (sharedMissing && !chain.includes('deny')) return sharedMissing
  return {
    ok: false,
    code: requester ? 'denied' : 'requester_unknown',
    message: requester
      ? `This agent only acts on ${label} as the person who asked, and they haven't connected an account.`
      : `This agent only acts on ${label} as the person who asked, and this run wasn't started by a person.`,
  }
}

async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const row = await prisma.member.findFirst({ where: { workspaceId, userId }, select: { id: true } })
  return !!row
}

/** The name a shared-account action credits, e.g. "requested by Bob". */
export async function requesterDisplayName(userId: string): Promise<string | null> {
  const user = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })) as
    | { name: string | null; email: string | null }
    | null
  return user?.name || user?.email || null
}

async function recordCredentialUse(args: ResolveArgs, result: Extract<ResolveResult, { ok: true }>): Promise<void> {
  try {
    await (prisma as any).integrationCredentialAudit.create({
      data: {
        projectId: args.projectId,
        provider: args.provider,
        op: args.op,
        source: result.source,
        actingAs: result.actingAs,
        actingUserId: result.userId ?? null,
        requesterUserId: args.approval ? args.approval.requesterUserId : args.requesterUserId,
        origin: args.origin && typeof args.origin === 'object' ? args.origin : null,
        approvalId: args.approval?.approvalId ?? null,
      },
    })
  } catch (err: any) {
    console.warn(`[IntegrationCredentials] Audit write failed for ${args.projectId}/${args.provider}:`, err?.message ?? err)
  }
}

async function personalCredential(adapter: CredentialProvider, ctx: ResolveContext, userId: string) {
  if (adapter.personalForUser) return adapter.personalForUser(ctx, userId)
  if (!adapter.personal) return null
  if (!(await hasActiveGrant(userId, ctx.projectId, ctx.provider))) return null
  const connection = await getPersonalConnection(userId, ctx.provider)
  return connection ? adapter.personal(ctx, connection) : null
}

/** The account `userId` would act with on `provider` for this project, or null when they can't be acted as. */
export async function personalAccountFor(projectId: string, provider: string, userId: string) {
  const adapter = getCredentialProvider(provider)
  if (!adapter?.supportsPersonal) return null
  const project = (await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })) as
    | { workspaceId: string }
    | null
  if (!project) return null
  const policy = await getPolicy(projectId, provider)
  return personalCredential(adapter, { projectId, workspaceId: project.workspaceId, provider, policy }, userId)
}

/** Workspace members who can do more than view: who can approve a card or act for the project. */
export async function canActForProject(userId: string, projectId: string): Promise<boolean> {
  const project = (await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } })) as
    | { workspaceId: string }
    | null
  if (!project) return false
  const member = (await prisma.member.findFirst({
    where: { userId, workspaceId: project.workspaceId },
    select: { role: true },
  })) as { role: string } | null
  return !!member && member.role !== 'viewer'
}

/** Workspace owners and admins, and the project's creator, may change how its integrations act. */
export async function canEditCredentialPolicies(userId: string, projectId: string): Promise<boolean> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true, createdBy: true },
  })) as { workspaceId: string; createdBy: string | null } | null
  if (!project) return false
  if (project.createdBy === userId) return true
  const member = (await prisma.member.findFirst({
    where: { userId, workspaceId: project.workspaceId },
    select: { role: true },
  })) as { role: string } | null
  return member?.role === 'owner' || member?.role === 'admin'
}
