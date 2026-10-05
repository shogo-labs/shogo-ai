// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub as a credential provider.
 *
 * Shared: the project's GitHubConnection (App installation token or stored
 * access token). Personal: the person's own GitHub user token from the Shogo
 * GitHub App's user-to-server OAuth, so issues, comments, and PRs show that
 * person as the author ("via Shogo"), within what the App is installed on.
 */

import { signPersonalConnectState } from './connect-state'
import { savePersonalConnection } from './store'
import type { ConnectResult, CredentialMaterial, CredentialProvider, PersonalConnection } from './types'

type GitHubService = typeof import('../github.service')

/** Refresh this long before GitHub would reject the token. */
const REFRESH_SKEW_MS = 5 * 60 * 1000
/** How long the runtime may cache a token that has no expiry of its own. */
const UNBOUNDED_TOKEN_CACHE_MS = 50 * 60 * 1000

interface OAuthTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

function tokenResultFrom(body: OAuthTokenResponse, nowMs = Date.now()): ConnectResult {
  if (!body.access_token) throw new Error(body.error_description || body.error || 'GitHub did not return an access token')
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    accessTokenExpiresAt: typeof body.expires_in === 'number' ? new Date(nowMs + body.expires_in * 1000) : null,
    refreshTokenExpiresAt:
      typeof body.refresh_token_expires_in === 'number' ? new Date(nowMs + body.refresh_token_expires_in * 1000) : null,
    scopes: body.scope ?? null,
  }
}

async function refreshUserToken(refreshToken: string): Promise<ConnectResult> {
  const clientId = process.env.GH_APP_CLIENT_ID
  const clientSecret = process.env.GH_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('GitHub App OAuth credentials not configured')
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) throw new Error(`GitHub token refresh failed: HTTP ${response.status}`)
  return tokenResultFrom((await response.json()) as OAuthTokenResponse)
}

export function githubCredentialProvider(loadGitHub: () => Promise<GitHubService>): CredentialProvider & {
  completeConnect(args: { userId: string; code: string }): Promise<{ login: string }>
} {
  return {
    id: 'github',
    label: () => 'GitHub',
    supportsPersonal: true,

    async shared(ctx) {
      const github = await loadGitHub()
      const credentials = await github.getProjectGitHubCliCredentials(ctx.projectId)
      return credentials ? { ...credentials } : null
    },

    async personal(_ctx, connection: PersonalConnection): Promise<CredentialMaterial | null> {
      let current = connection
      const expiresAtMs = current.accessTokenExpiresAt?.getTime()
      const expired = expiresAtMs !== undefined && expiresAtMs - Date.now() < REFRESH_SKEW_MS
      if (!current.accessToken || expired) {
        if (!current.refreshToken) return null
        const refreshExpired = current.refreshTokenExpiresAt && current.refreshTokenExpiresAt.getTime() < Date.now()
        if (refreshExpired) return null
        let refreshed: ConnectResult
        try {
          refreshed = await refreshUserToken(current.refreshToken)
        } catch (err: any) {
          console.warn(`[IntegrationCredentials] GitHub refresh failed for ${current.userId}:`, err?.message ?? err)
          return null
        }
        await savePersonalConnection(current.userId, 'github', {
          ...refreshed,
          externalId: current.externalId,
          externalLogin: current.externalLogin,
        })
        current = {
          ...current,
          accessToken: refreshed.accessToken ?? null,
          refreshToken: refreshed.refreshToken ?? current.refreshToken,
          accessTokenExpiresAt: refreshed.accessTokenExpiresAt ?? null,
        }
      }
      const github = await loadGitHub()
      const login = current.externalLogin ?? 'github-user'
      const userId = Number(current.externalId)
      return {
        token: current.accessToken!,
        expiresAt: new Date(
          current.accessTokenExpiresAt?.getTime() ?? Date.now() + UNBOUNDED_TOKEN_CACHE_MS,
        ).toISOString(),
        login,
        name: login,
        email: Number.isFinite(userId) && userId > 0
          ? github.githubBotCommitEmail(userId, login)
          : `${login}@users.noreply.github.com`,
      }
    },

    async beginConnect({ userId, projectId, provider, resume }) {
      const github = await loadGitHub()
      if (!github.isOAuthConfigured()) {
        throw new Error('Connecting a personal GitHub account is not configured on this server.')
      }
      const state = signPersonalConnectState({ userId, provider, projectId, ...(resume ? { resume } : {}) })
      return { url: github.getOAuthUrl(state, github.getAuthorizeCallbackUrl()) }
    },

    async completeConnect({ userId, code }) {
      const github = await loadGitHub()
      const exchanged = (await github.exchangeOAuthCode(code)) as OAuthTokenResponse
      const tokens = tokenResultFrom(exchanged)
      const user = await github.getTokenUser(tokens.accessToken!)
      await savePersonalConnection(userId, 'github', {
        ...tokens,
        externalId: String(user.id),
        externalLogin: user.login,
      })
      return { login: user.login }
    },
  }
}
