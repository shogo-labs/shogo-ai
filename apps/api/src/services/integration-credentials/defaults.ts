// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Registers the built-in credential providers. GitHub only registers when the
 * caller can load the GitHub App client (cloud); the slim desktop bundle
 * leaves it out the same way the internal runtime routes do.
 */

import { composioCredentialProvider } from './composio-provider'
import { githubCredentialProvider } from './github-provider'
import { getCredentialProvider, registerCredentialProvider } from './index'

type GitHubService = typeof import('../github.service')

export function ensureDefaultCredentialProviders(opts: { loadGitHub?: () => Promise<GitHubService> } = {}): void {
  if (opts.loadGitHub && !getCredentialProvider('github')) {
    registerCredentialProvider(githubCredentialProvider(opts.loadGitHub))
  }
  if (!getCredentialProvider('composio:x')) registerCredentialProvider(composioCredentialProvider())
}

/** The GitHub adapter with its OAuth completion step, when registered. */
export function githubAdapter(): ReturnType<typeof githubCredentialProvider> | null {
  const adapter = getCredentialProvider('github') as ReturnType<typeof githubCredentialProvider> | null
  return adapter && typeof (adapter as any).completeConnect === 'function' ? adapter : null
}
