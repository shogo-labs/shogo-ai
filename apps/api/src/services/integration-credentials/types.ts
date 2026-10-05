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

export interface CredentialPolicy {
  provider: string
  writeMode: ActorMode
  readMode: ActorMode
  fallback: ActorFallback
  sharedUserId: string | null
}

export const DEFAULT_POLICY: Omit<CredentialPolicy, 'provider'> = {
  writeMode: 'shared',
  readMode: 'shared',
  fallback: 'ask',
  sharedUserId: null,
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
  beginConnect?(args: { userId: string; projectId: string; provider: string; returnUrl: string }): Promise<{ url: string }>
}

export type ResolveResult =
  | {
      ok: true
      source: 'shared' | 'personal'
      /** Display name of the identity used, e.g. "@octocat" or "project account". */
      actingAs: string
      userId?: string
      credential: CredentialMaterial
    }
  | {
      ok: false
      code: 'requester_auth_required' | 'requester_unknown' | 'denied' | 'not_connected'
      message: string
      connectUrl?: string
    }
