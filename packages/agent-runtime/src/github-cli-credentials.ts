// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cached GitHub App installation credentials for agent shell commands.
 *
 * `gh` prefers `GH_TOKEN` over a user `GITHUB_TOKEN` and over `gh auth login`,
 * so setting it makes issue comments, reviews, and API calls show up as the
 * App bot (the same identity that opens pull requests). Git author env vars
 * use the bot's noreply address so commits link to that account too.
 *
 * The token is process memory only. It is never written to the workspace.
 */
import { getGitHubCliCredentials, projectScopedId } from './internal-api'

const REFRESH_SKEW_MS = 5 * 60 * 1000

interface CachedEnv {
  expiresAtMs: number
  env: Record<string, string>
}

const cache = new Map<string, CachedEnv>()

export function clearGitHubCliEnvCache(): void {
  cache.clear()
}

export function githubCliEnvFromCredentials(credentials: {
  token?: string
  expiresAt?: string
  name?: string
  email?: string
}): { env: Record<string, string>; expiresAtMs: number } | null {
  if (!credentials.token) return null
  const env: Record<string, string> = { GH_TOKEN: credentials.token }
  if (credentials.name && credentials.email) {
    env.GIT_AUTHOR_NAME = credentials.name
    env.GIT_AUTHOR_EMAIL = credentials.email
    env.GIT_COMMITTER_NAME = credentials.name
    env.GIT_COMMITTER_EMAIL = credentials.email
  }
  const parsed = credentials.expiresAt ? Date.parse(credentials.expiresAt) : NaN
  const expiresAtMs = Number.isFinite(parsed) ? parsed : Date.now() + 50 * 60 * 1000
  return { env, expiresAtMs }
}

/**
 * Env to merge into an agent shell for this project. Empty when the project
 * has no GitHub App connection or the API cannot mint a token — the shell
 * then keeps whatever user token is in the workspace `.env`.
 */
export async function githubCliEnvForProject(
  projectId: string | null | undefined,
): Promise<Record<string, string>> {
  const id = projectScopedId(projectId)
  if (!id) return {}

  const hit = cache.get(id)
  if (hit && hit.expiresAtMs - Date.now() > REFRESH_SKEW_MS) return hit.env

  try {
    const result = await getGitHubCliCredentials(id)
    if (!result.ok || !result.data) {
      cache.delete(id)
      return {}
    }
    const built = githubCliEnvFromCredentials(result.data)
    if (!built) {
      cache.delete(id)
      return {}
    }
    cache.set(id, built)
    return built.env
  } catch (err: any) {
    console.warn(`[GitHub] CLI credentials unavailable for ${id}:`, err?.message ?? err)
    return {}
  }
}
