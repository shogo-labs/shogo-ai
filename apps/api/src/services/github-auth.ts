// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How a project's GitHubConnection authenticates.
 *
 * A connection uses either the Shogo GitHub App installation (`authType=app`,
 * short-lived installation tokens, bot attribution) or a user-supplied access
 * token (`authType=token`: a fine-grained / classic personal access token or
 * an OAuth token), stored encrypted with `secret-crypto`.
 *
 * Kept free of `jsonwebtoken` so the internal runtime routes can resolve a
 * connection without loading the GitHub App client.
 */

import { decryptSecret } from '../lib/secret-crypto'

export type GitHubConnectionAuth =
  | { kind: 'app'; installationId: number }
  | { kind: 'token'; token: string; login: string | null }

export interface GitHubConnectionAuthFields {
  authType?: string | null
  installationId?: number | null
  encryptedToken?: string | null
  tokenLogin?: string | null
}

/**
 * Resolve a connection row to usable credentials. Returns null when the row
 * carries neither a valid installation nor a stored token.
 */
export function resolveConnectionAuth(
  connection: GitHubConnectionAuthFields | null | undefined,
): GitHubConnectionAuth | null {
  if (!connection) return null
  if (connection.authType === 'token') {
    if (!connection.encryptedToken) return null
    return {
      kind: 'token',
      token: decryptSecret(connection.encryptedToken),
      login: connection.tokenLogin ?? null,
    }
  }
  const installationId = connection.installationId
  if (typeof installationId === 'number' && Number.isInteger(installationId)) {
    return { kind: 'app', installationId }
  }
  return null
}

/**
 * Env that authenticates git's HTTPS transport to github.com for one command,
 * so the token is never written into `.git/config` or a remote URL.
 */
export function githubGitAuthEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

export function githubRemoteUrl(repoOwner: string, repoName: string): string {
  return `https://github.com/${repoOwner}/${repoName}.git`
}
