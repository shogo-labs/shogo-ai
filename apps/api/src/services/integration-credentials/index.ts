// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pick the credential an agent's tool call uses on an integration: the
 * project's shared account, or the personal account of the person whose
 * message started the turn.
 *
 *   policy (per project + provider)  ->  mode for this op (read / write)
 *   shared                           ->  provider.shared()
 *   requester                        ->  consent grant + personal account
 *     none usable                    ->  fallback: ask (connect link) | shared | deny
 *
 * The requester always comes from a signed ticket (see lib/requester-ticket),
 * never from the runtime's say-so.
 */

import { prisma } from '../../lib/prisma'
import { getPersonalConnection, getPolicy, hasActiveGrant } from './store'
import type { CredentialOp, CredentialProvider, ResolveContext, ResolveResult } from './types'

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
  const adapter = getCredentialProvider(args.provider)
  if (!adapter) {
    return { ok: true, source: 'shared', actingAs: 'project account', credential: {} }
  }
  const project = await prisma.project.findUnique({ where: { id: args.projectId }, select: { workspaceId: true } })
  if (!project) return { ok: false, code: 'not_connected', message: 'Project not found.' }

  const policy = await getPolicy(args.projectId, args.provider)
  const ctx: ResolveContext = { projectId: args.projectId, workspaceId: project.workspaceId, provider: args.provider, policy }
  const chain = args.op === 'write' ? policy.writeChain : policy.readChain
  const label = adapter.label(args.provider)
  const requester = args.requesterUserId
  let sharedMissing: ResolveResult | null = null

  for (const step of chain) {
    if (step === 'requester') {
      if (!requester || !adapter.supportsPersonal) continue
      const personal = await personalCredential(adapter, ctx, requester)
      if (!personal) continue
      return {
        ok: true,
        source: 'personal',
        actingAs: personal.login ? `@${personal.login}` : 'the requester',
        userId: requester,
        credential: personal,
      }
    }
    if (step === 'ask') {
      if (!requester || !adapter.supportsPersonal) continue
      return {
        ok: false,
        code: 'requester_auth_required',
        message:
          `This agent acts as the person who asked on ${label}. ` +
          `They need to connect their ${label} account and allow this agent to use it.`,
        connectUrl: personalConnectUrl(args.projectId, args.provider, args.resume),
      }
    }
    if (step === 'shared') {
      if (adapter.supportsShared === false) continue
      const shared = await sharedResult(adapter, ctx)
      if (shared.ok) return shared
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

async function personalCredential(adapter: CredentialProvider, ctx: ResolveContext, userId: string) {
  if (adapter.personalForUser) return adapter.personalForUser(ctx, userId)
  if (!adapter.personal) return null
  if (!(await hasActiveGrant(userId, ctx.projectId, ctx.provider))) return null
  const connection = await getPersonalConnection(userId, ctx.provider)
  return connection ? adapter.personal(ctx, connection) : null
}
