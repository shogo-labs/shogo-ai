// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Authorize the Shogo GitHub App" connect flow — the alternative to sharing
 * an access token.
 *
 *   1. Studio or the agent asks for a link (`createAuthorizeUrl`). It points at
 *      the App's install/configure page with a signed state naming the project
 *      and repository.
 *   2. GitHub redirects to `/api/github/callback` with `installation_id`
 *      (Setup URL) and, if the App requests user authorization during
 *      install, a `code`. Without a code we bounce through OAuth to get one.
 *   3. With the code we act as the GitHub user: list the installations they
 *      can access and pick one that can see the repository. A forged
 *      `installation_id` therefore can't attach someone else's installation.
 *      If none can see it, the user goes back to the install page to grant it.
 *   4. Save the App connection and point the project's workspace at the repo.
 */

import {
  advanceGitHubAuthorizeState,
  createGitHubAuthorizeState,
  verifyGitHubAuthorizeState,
} from '../lib/github-oauth-state'
import * as githubService from './github.service'
import { runtimeGitHubWorkspace, type GitHubWorkspace, type GitHubWorkspaceOpResult } from './github-workspace'

const MAX_INSTALL_ATTEMPTS = 2

export interface AuthorizeTarget {
  projectId: string
  repoOwner: string
  repoName: string
  userId?: string
}

export function createAuthorizeUrl(target: AuthorizeTarget): string {
  if (!githubService.isOAuthConfigured()) {
    throw new Error('Authorizing the Shogo GitHub App is not configured on this server; share an access token instead.')
  }
  return githubService.getInstallationUrl(createGitHubAuthorizeState(target))
}

export type AuthorizeCallbackResult =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'done'
      ok: boolean
      projectId?: string
      repoFullName?: string
      message: string
      workspace?: GitHubWorkspaceOpResult
    }

export interface AuthorizeCallbackParams {
  state?: string
  code?: string
  installationId?: string
  error?: string
  errorDescription?: string
}

export async function handleAuthorizeCallback(
  params: AuthorizeCallbackParams,
  deps: { workspaceFor?: (projectId: string) => GitHubWorkspace } = {},
): Promise<AuthorizeCallbackResult> {
  const state = params.state ? verifyGitHubAuthorizeState(params.state) : null
  if (!state) {
    return { kind: 'done', ok: false, message: 'This GitHub authorization link is invalid or has expired. Ask for a new one.' }
  }
  const { projectId } = state
  if (params.error) {
    return { kind: 'done', ok: false, projectId, message: params.errorDescription || `GitHub returned: ${params.error}` }
  }

  const reportedInstallation = Number(params.installationId)
  const installationHint = Number.isInteger(reportedInstallation) && reportedInstallation > 0
    ? reportedInstallation
    : state.installationId

  if (!params.code) {
    const next = advanceGitHubAuthorizeState(state, { installationId: installationHint })
    return { kind: 'redirect', url: githubService.getOAuthUrl(next, githubService.getAuthorizeCallbackUrl()) }
  }

  let userToken: string
  try {
    const exchanged = await githubService.exchangeOAuthCode(params.code)
    if (!exchanged?.access_token) throw new Error('GitHub did not return an access token')
    userToken = exchanged.access_token
  } catch (err: any) {
    return { kind: 'done', ok: false, projectId, message: `Could not complete GitHub authorization: ${err?.message ?? err}` }
  }

  const repoFullName = `${state.repoOwner}/${state.repoName}`
  const installationId = await githubService.findUserInstallationForRepo(
    userToken,
    state.repoOwner,
    state.repoName,
    installationHint,
  )
  if (!installationId) {
    const attempts = (state.installAttempts ?? 0) + 1
    if (attempts > MAX_INSTALL_ATTEMPTS) {
      return {
        kind: 'done',
        ok: false,
        projectId,
        repoFullName,
        message: `The Shogo GitHub App doesn't have access to ${repoFullName}. Grant it access to that repository in GitHub, or share an access token instead.`,
      }
    }
    const next = advanceGitHubAuthorizeState(state, { installAttempts: attempts, installationId: undefined })
    return { kind: 'redirect', url: githubService.getInstallationUrl(next) }
  }

  try {
    const workspaceFor = deps.workspaceFor ?? runtimeGitHubWorkspace
    const { repo, workspace } = await githubService.connectRepository({
      projectId,
      installationId,
      repoOwner: state.repoOwner,
      repoName: state.repoName,
      workspace: workspaceFor(projectId),
    })
    const workspaceNote = workspace.ok && workspace.connect !== 'diverged'
      ? ''
      : ` The repository is connected, but the project files were not updated yet: ${workspace.error ?? 'unknown error'}`
    return {
      kind: 'done',
      ok: true,
      projectId,
      repoFullName: repo.full_name,
      message: `Connected ${repo.full_name} through the Shogo GitHub App.${workspaceNote}`,
      workspace,
    }
  } catch (err: any) {
    return { kind: 'done', ok: false, projectId, repoFullName, message: `Could not connect ${repoFullName}: ${err?.message ?? err}` }
  }
}
