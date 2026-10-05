// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared vocabulary for "who does the agent act as" on an integration.
 *
 * Every integration is a `CredentialProvider`. The policy, consent grants,
 * resolver, routes, and UI only ever deal in provider ids, so adding an
 * integration means writing one adapter.
 */

export type ActorMode = 'shared' | 'requester'
export type ActorFallback = 'ask' | 'shared' | 'deny'
export type CredentialOp = 'read' | 'write'

export const ACTOR_MODES: readonly ActorMode[] = ['shared', 'requester']
export const ACTOR_FALLBACKS: readonly ActorFallback[] = ['ask', 'shared', 'deny']

/**
 * One step of a fallback chain. The resolver walks a chain in order and
 * skips steps that don't apply:
 *   requester - the person's own account, when they've connected and allowed this project
 *   ask       - a known person who hasn't connected yet gets a connect link
 *   approve   - post a card where the turn is happening; whoever approves
 *               becomes the person and the chain restarts with them
 *   delegate  - the account of whoever opted in to stand in for runs with no
 *               usable person
 *   shared    - the project's account, when it has one
 *   deny      - refuse
 */
export type ChainStep = 'requester' | 'ask' | 'approve' | 'delegate' | 'shared' | 'deny'
export const CHAIN_STEPS: readonly ChainStep[] = ['requester', 'ask', 'approve', 'delegate', 'shared', 'deny']

export interface CredentialPolicy {
  provider: string
  writeChain: ChainStep[]
  readChain: ChainStep[]
  /** Summaries of the chains, for older runtimes and simple UIs. */
  writeMode: ActorMode
  readMode: ActorMode
  fallback: ActorFallback
  sharedUserId: string | null
  /** Who stands in for runs with no usable person (the `delegate` step). */
  delegateUserId: string | null
}

/** The chain a v1 policy (mode + single fallback) behaves as. */
export function legacyChain(mode: ActorMode, fallback: ActorFallback, op: CredentialOp): ChainStep[] {
  if (mode === 'shared') return ['shared']
  if (fallback === 'shared') return ['requester', 'shared']
  if (fallback === 'deny') return ['requester', 'deny']
  // Reads never stopped for a connect prompt.
  return op === 'read' ? ['requester', 'shared'] : ['requester', 'ask', 'deny']
}

export function chainMode(chain: readonly ChainStep[]): ActorMode {
  return chain[0] === 'shared' ? 'shared' : 'requester'
}

export function chainFallback(chain: readonly ChainStep[]): ActorFallback {
  if (chain.includes('ask')) return 'ask'
  if (chain.slice(1).includes('shared')) return 'shared'
  return 'deny'
}

export const DEFAULT_POLICY: Omit<CredentialPolicy, 'provider'> = {
  writeChain: ['shared'],
  readChain: ['shared'],
  writeMode: 'shared',
  readMode: 'shared',
  fallback: 'ask',
  sharedUserId: null,
  delegateUserId: null,
}

/** A stored personal connection, decrypted. */
export interface PersonalConnection {
  userId: string
  provider: string
  externalId: string | null
  externalLogin: string | null
  accessToken: string | null
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  refreshTokenExpiresAt: Date | null
  scopes: string | null
}

/** What `completeConnect` hands back to be stored. */
export interface ConnectResult {
  externalId?: string | null
  externalLogin?: string | null
  /** Email the provider reported for the account; stored on the identity link only. */
  email?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  accessTokenExpiresAt?: Date | null
  refreshTokenExpiresAt?: Date | null
  scopes?: string | null
}

/**
 * The credential material a tool needs. Each provider fills what applies:
 * GitHub returns a token plus commit identity, Composio an entity id.
 */
export interface CredentialMaterial {
  token?: string
  expiresAt?: string
  login?: string
  name?: string
  email?: string
  entityId?: string
}

export interface ResolveContext {
  projectId: string
  workspaceId: string
  provider: string
  policy: CredentialPolicy
}

export interface CredentialProvider {
  /** Provider id, or a prefix ending in ':' for a family ("composio:"). */
  id: string
  label(provider: string): string
  /** False for shared-only integrations (a Slack bot token, a pasted API key). */
  supportsPersonal: boolean
  /** False when the integration has no project-wide account (default true). */
  supportsShared?: boolean
  /** The project's own credential. Null when the project has none. */
  shared(ctx: ResolveContext): Promise<CredentialMaterial | null>
  /** Usable credentials from a person's stored connection (refreshed when needed). */
  personal?(ctx: ResolveContext, connection: PersonalConnection): Promise<CredentialMaterial | null>
  /**
   * For providers whose personal accounts live elsewhere (Composio), the
   * material for a user without a stored connection row. Null when that
   * user has no usable account there.
   */
  personalForUser?(ctx: ResolveContext, userId: string): Promise<CredentialMaterial | null>
  /** Where to send the person to connect their own account. */
  beginConnect?(args: { userId: string; projectId: string; provider: string; returnUrl: string; resume?: string }): Promise<{ url: string }>
}

/**
 * Where a credential came from: the project's account, the person who asked,
 * the project's delegate, or someone who approved this call.
 */
export type CredentialSource = 'shared' | 'personal' | 'delegate' | 'approved'

export type ResolveResult =
  | {
      ok: true
      source: CredentialSource
      /** Display name of the identity used, e.g. "@octocat" or "project account". */
      actingAs: string
      userId?: string
      /** On a shared account: the person it acted for, to credit them in what it writes. */
      onBehalfOf?: string
      credential: CredentialMaterial
    }
  | {
      ok: false
      code: 'requester_auth_required' | 'requester_unknown' | 'denied' | 'not_connected' | 'approval_denied' | 'approval_expired'
      message: string
      connectUrl?: string
    }
  | {
      ok: false
      code: 'approval_pending'
      message: string
      approvalId: string
      expiresAt: string
    }
