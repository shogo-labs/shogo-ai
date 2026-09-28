// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invoke a project's agent-runtime pod for one turn, outside of any chat
 * session. Two callers:
 *
 *   - `POST /api/internal/projects/:id/agent-call` (`apps/api/src/routes/
 *     internal.ts`) — backs the `project_call` tool (`project-tools.ts`).
 *     The route authenticates the caller against a runtime token first,
 *     then calls `callProjectAgent` with the workspace it already proved.
 *   - GitHub webhook handlers (`github.service.ts`) — `issues` /
 *     `issue_comment` / `pull_request_review` / `pull_request_review_comment`
 *     events wake the connected project's agent the same way a sibling
 *     project would via `project_call`. The API is the caller here (not an
 *     external runtime token holder), so it already knows `workspaceId`
 *     from a trusted `GitHubConnection` → `Project` lookup and skips the
 *     token-auth step.
 *
 * Resolves the target the same way the public agent-proxy does (pinned
 * Instance tunnel first, then cloud pod / host runtime) and forwards to the
 * runtime's `/agent/pipeline/call`, which is guarded by the runtime token
 * alone — workspace runtimes are never given a `WEBHOOK_TOKEN`, so the
 * external `/agent/hooks/*` path can't be reused here.
 */
import type { Context } from 'hono'

export interface AgentCallRequest {
  message: string
  /** Pipeline correlation id, threaded into the callee's AgentCostMetric.metadata. */
  runId?: string
  /** Callee session key. Defaults to `run:<runId>` when a runId is given. */
  sessionId?: string
  /** Block for the reply (default true). */
  wait?: boolean
  /** Reply timeout in ms when waiting (default 5 min, max 20 min). */
  timeoutMs?: number
  callerProjectId?: string
}

export interface AgentCallOutcome {
  status: number
  body: any
}

/**
 * `wait=true` blocks for the reply (bounded by `timeoutMs`, default 5 min,
 * max 20 min); otherwise the runtime acks with 202 and the turn runs in the
 * background. Never throws — failures come back as a `4xx`/`5xx` outcome so
 * callers (an HTTP route, or a webhook handler that must still ack GitHub)
 * can decide how to surface it.
 */
export async function callProjectAgent(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: AgentCallRequest,
): Promise<AgentCallOutcome> {
  if (!req.message || !req.message.trim()) {
    return { status: 400, body: { error: { code: 'bad_request', message: 'message is required' } } }
  }
  const wait = req.wait !== false
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 5 * 60_000, 10_000), 20 * 60_000)

  const forwardBody = JSON.stringify({
    message: req.message,
    runId: req.runId,
    sessionId: req.sessionId,
    wait,
    callerProjectId: req.callerProjectId,
  })

  try {
    const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
    const runtimeToken = await deriveProjectRuntimeToken(projectId, { workspaceId })

    let runtimeUrl: string
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      // Desktop: every project runs on the host RuntimeManager. The tunnel /
      // Redis resolver below is cloud-only and stays out of the local bundle.
      const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url')
      runtimeUrl = (await resolveProjectPodUrl(projectId, { logTag: 'AgentCall' })).url
    } else {
      const { resolveAgentProxyPodUrl } = await import('../lib/agent-proxy-resolver')
      const resolution = await resolveAgentProxyPodUrl(projectId, { logTag: 'AgentCall' })
      if (!resolution.ok) return { status: resolution.status, body: resolution.body }

      if (resolution.kind === 'tunnel') {
        const { relayAgentProxyViaTunnel } = await import('../lib/tunnel-relay')
        const res = await relayAgentProxyViaTunnel({
          c,
          instanceId: resolution.instanceId,
          workspaceId: resolution.workspaceId,
          projectId,
          agentPath: '/agent/pipeline/call',
          cleanPath: '/agent/pipeline/call',
          method: 'POST',
          body: forwardBody,
          headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken },
        })
        const json = await res.json().catch(() => ({}))
        return { status: res.status, body: json }
      }
      runtimeUrl = resolution.url
    }

    const res = await fetch(`${runtimeUrl}/agent/pipeline/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': runtimeToken },
      body: forwardBody,
      signal: AbortSignal.timeout(wait ? timeoutMs + 5_000 : 15_000),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, body: json }
  } catch (err: any) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return {
      status: timedOut ? 504 : 502,
      body: {
        error: {
          code: timedOut ? 'agent_call_timeout' : 'agent_call_failed',
          message: timedOut
            ? `The target agent did not reply within ${Math.round(timeoutMs / 1000)}s. Re-issue with wait=false and poll, or raise timeoutMs.`
            : (err?.message ?? 'Failed to reach the target runtime'),
        },
      },
    }
  }
}
