// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-call integration credentials: which account a tool call acts as.
 *
 * A project can set, per integration, whether its agent acts as the shared
 * project account or as the person whose message started the turn. Tools
 * don't implement that themselves. They declare `{ provider, op }` (or have
 * it derived here), and `withIntegrationCredentials` wraps every tool:
 *
 *   - runs the call inside a credential scope carrying the turn's requester
 *     ticket, so internal API calls prove who asked;
 *   - when the provider has a saved policy, asks the API which credential to
 *     use and puts it in the scope (`GH_TOKEN` env for shells, a Composio
 *     entity for Composio tools);
 *   - when the requester has to connect first, returns the connect link
 *     instead of running the tool.
 *
 * No saved policy for a provider means no lookup and today's behavior.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { REQUESTER_TICKET_HEADER, runInCredentialScope, type CredentialScope } from './credential-scope'
import { githubCliEnvFromCredentials } from './github-cli-credentials'
import { deriveApiUrl, getInternalHeaders, projectScopedId } from './internal-api'

export type CredentialOp = 'read' | 'write'

export interface ToolCredentialMeta {
  provider: string
  op: CredentialOp
}

// ---------------------------------------------------------------------------
// Policies (cached briefly; the API is the source of truth)
// ---------------------------------------------------------------------------

export interface CredentialPolicySummary {
  provider: string
  writeMode: 'shared' | 'requester'
  readMode: 'shared' | 'requester'
  fallback: 'ask' | 'shared' | 'deny'
  sharedUserId: string | null
}

const POLICY_TTL_MS = 15_000
const policyCache = new Map<string, { at: number; policies: Map<string, CredentialPolicySummary> }>()

export function clearCredentialPolicyCache(): void {
  policyCache.clear()
}

async function policiesFor(projectId: string): Promise<Map<string, CredentialPolicySummary>> {
  const hit = policyCache.get(projectId)
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.policies
  const apiUrl = deriveApiUrl()
  const policies = new Map<string, CredentialPolicySummary>()
  if (apiUrl) {
    try {
      const res = await fetch(`${apiUrl}/api/internal/projects/${encodeURIComponent(projectId)}/integrations/policies`, {
        headers: getInternalHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { policies?: CredentialPolicySummary[] }
        for (const p of body.policies ?? []) policies.set(p.provider, p)
      }
    } catch (err: any) {
      console.warn(`[IntegrationCredentials] Policies unavailable for ${projectId}:`, err?.message ?? err)
      if (hit) return hit.policies
    }
  }
  policyCache.set(projectId, { at: Date.now(), policies })
  return policies
}

/** True when a policy changes who `op` runs as on `provider`, so a lookup is needed. */
function needsResolve(policy: CredentialPolicySummary | undefined, provider: string, op: CredentialOp): boolean {
  if (!policy) return false
  const mode = op === 'write' ? policy.writeMode : policy.readMode
  if (mode === 'requester') return true
  // Composio's default is already the requester's own entity; "shared" is the change.
  return provider.startsWith('composio:') && mode === 'shared'
}

export type ResolvedCredential =
  | {
      ok: true
      source: 'shared' | 'personal'
      actingAs: string
      credential: { token?: string; expiresAt?: string; login?: string; name?: string; email?: string; entityId?: string }
    }
  | { ok: false; code: string; message: string; connectUrl?: string }

export async function resolveIntegrationCredential(
  projectId: string,
  provider: string,
  op: CredentialOp,
  requesterTicket: string | undefined,
): Promise<ResolvedCredential> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, code: 'unavailable', message: 'No API URL configured' }
  try {
    const res = await fetch(`${apiUrl}/api/internal/projects/${encodeURIComponent(projectId)}/integrations/resolve`, {
      method: 'POST',
      headers: {
        ...getInternalHeaders(),
        ...(requesterTicket ? { [REQUESTER_TICKET_HEADER]: requesterTicket } : {}),
      },
      body: JSON.stringify({ provider, op }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => null)) as ResolvedCredential | null
    if (!res.ok || !body) return { ok: false, code: 'unavailable', message: `Credential lookup failed: HTTP ${res.status}` }
    return body
  } catch (err: any) {
    return { ok: false, code: 'unavailable', message: err?.message ?? String(err) }
  }
}

// ---------------------------------------------------------------------------
// What a tool call needs
// ---------------------------------------------------------------------------

const GH_WRITE_RE =
  /\bgh\s+(?:issue|pr|release|repo|label|gist|discussion|project|workflow|run|secret|variable)\s+(?:create|comment|edit|close|reopen|delete|merge|review|ready|lock|unlock|pin|unpin|transfer|develop|fork|rename|archive|upload|add|remove|set|enable|disable|cancel|rerun)\b/
const GH_API_WRITE_RE = /\bgh\s+api\b[^\n;|&]*(?:-X\s*|--method[\s=]+)(?:POST|PUT|PATCH|DELETE)\b|\bgh\s+api\b[^\n;|&]*\s-(?:f|F|-field|-raw-field|-input)\b/i
const GIT_WRITE_RE = /\bgit\s+push\b/
const RAW_TOKEN_RE = /\$\{?(?:GH_TOKEN|GITHUB_TOKEN)\b|api\.github\.com/
const GITHUB_CLI_RE = /\bgh\s|\bgit\s+(?:fetch|pull|clone|ls-remote|remote\s+update|submodule)\b/

/**
 * How a shell command uses GitHub: `write` for anything that changes GitHub
 * (or that uses the token directly, which can't be told apart), `read` for
 * other `gh` / network git commands, `none` when it doesn't touch GitHub.
 */
export function classifyGitHubShellOp(command: string): 'none' | CredentialOp {
  if (GH_WRITE_RE.test(command) || GH_API_WRITE_RE.test(command) || GIT_WRITE_RE.test(command) || RAW_TOKEN_RE.test(command)) {
    return 'write'
  }
  return GITHUB_CLI_RE.test(command) ? 'read' : 'none'
}

const READ_SLUG_RE = /_(?:GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|DOWNLOAD|EXPORT|QUERY|CHECK|VIEW|DESCRIBE|COUNT)(?:_|$)/

/** Read/write for a Composio action from its catalog tags, else from its slug's verb. */
export function composioToolOp(slug: string, tags: string[] | undefined): CredentialOp {
  const lowered = (tags ?? []).map((t) => t.toLowerCase())
  if (lowered.includes('readonlyhint') || lowered.includes('read_only')) return 'read'
  if (lowered.includes('destructivehint')) return 'write'
  return READ_SLUG_RE.test(slug.toUpperCase()) ? 'read' : 'write'
}

/** The credential a call to `tool` with `params` needs, or null when it needs none. */
export function toolCredentialMeta(tool: AgentTool, params: unknown): ToolCredentialMeta | null {
  const declared = (tool as AgentTool & { credential?: ToolCredentialMeta }).credential
  if (declared) return declared
  if (tool.name === 'exec') {
    const command = (params as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return null
    const op = classifyGitHubShellOp(command)
    return op === 'none' ? null : { provider: 'github', op }
  }
  return null
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

export interface CredentialWrapperContext {
  projectId: string
  requesterTicket?: string
  uiWriter?: { write(chunk: Record<string, any>): void }
}

function blockedResult(provider: string, resolved: Extract<ResolvedCredential, { ok: false }>) {
  const payload = {
    error: resolved.message,
    code: resolved.code,
    provider,
    ...(resolved.connectUrl
      ? {
          connectUrl: resolved.connectUrl,
          next:
            'Do not retry and do not use another account. Tell the person they need to connect their own account for this, ' +
            'and put the connectUrl in your reply exactly as given (they cannot see this tool result). ' +
            'Once they say they have connected it, run the same step again.',
        }
      : { next: 'Do not retry this with another account. Tell the person why it could not be done.' }),
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], details: payload }
}

/**
 * A per-turn wrapper: `wrap(tool)` returns the tool with credential handling,
 * the same object each time for the same tool.
 */
export function createIntegrationCredentialWrapper(ctx: CredentialWrapperContext): (tool: AgentTool) => AgentTool {
  const wrapped = new WeakMap<AgentTool, AgentTool>()
  return (tool) => {
    let result = wrapped.get(tool)
    if (!result) {
      result = withIntegrationCredentials(tool, ctx)
      wrapped.set(tool, result)
    }
    return result
  }
}

export function withIntegrationCredentials(tool: AgentTool, ctx: CredentialWrapperContext): AgentTool {
  const execute: AgentTool['execute'] = async (toolCallId, params, signal, onUpdate) => {
    const scope: CredentialScope = { requesterTicket: ctx.requesterTicket }
    const meta = toolCredentialMeta(tool, params)
    const projectId = projectScopedId(ctx.projectId)
    if (meta && projectId) {
      const policy = (await policiesFor(projectId)).get(meta.provider)
      if (needsResolve(policy, meta.provider, meta.op)) {
        const resolved = await resolveIntegrationCredential(projectId, meta.provider, meta.op, ctx.requesterTicket)
        if (!resolved.ok) {
          if (resolved.code === 'requester_auth_required') {
            ctx.uiWriter?.write({
              type: 'data-integration-auth-required',
              data: { provider: meta.provider, connectUrl: resolved.connectUrl, message: resolved.message },
            })
          }
          return blockedResult(meta.provider, resolved) as any
        }
        scope.actingAs = resolved.actingAs
        if (meta.provider === 'github' && resolved.credential.token) {
          scope.githubEnv = githubCliEnvFromCredentials(resolved.credential)?.env
        }
        if (resolved.credential.entityId) scope.composioEntityId = resolved.credential.entityId
      }
    }
    return runInCredentialScope(scope, () => tool.execute(toolCallId, params, signal, onUpdate))
  }
  return { ...tool, execute } as AgentTool
}
