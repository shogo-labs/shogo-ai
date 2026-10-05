// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The credential scope of the tool call that is running: whose integration
 * credentials it uses. Set by `withIntegrationCredentials`
 * (integration-credentials.ts); read by the internal API client, the shell's
 * GitHub env, and Composio tools. Async-local, so concurrent turns for
 * different people never see each other's credentials.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export const REQUESTER_TICKET_HEADER = 'X-Requester-Ticket'

export interface CredentialScope {
  requesterTicket?: string
  /** Env for shell commands that talk to GitHub, replacing the project connection's. */
  githubEnv?: Record<string, string>
  /** Composio entity the call runs as, replacing the session's. */
  composioEntityId?: string
  /** Who the call acts as. */
  actingAs?: string
}

const scopeStorage = new AsyncLocalStorage<CredentialScope>()

export function currentCredentialScope(): CredentialScope | undefined {
  return scopeStorage.getStore()
}

export function runInCredentialScope<T>(scope: CredentialScope, fn: () => T): T {
  return scopeStorage.run(scope, fn)
}

/** The running call's requester ticket as a header, for internal API calls. */
export function requesterTicketHeaders(): Record<string, string> {
  const ticket = scopeStorage.getStore()?.requesterTicket
  return ticket ? { [REQUESTER_TICKET_HEADER]: ticket } : {}
}
