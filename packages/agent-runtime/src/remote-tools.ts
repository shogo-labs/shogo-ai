// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote tool channel: run an allow-listed tool inside another project's own
 * runtime, like ssh. A project is online in exactly one runtime, so instead of
 * mounting a second writable copy of it somewhere else, the caller sends the
 * tool call to that runtime:
 *
 *   caller tool (`project: "<id or name>"`)
 *     → POST {SHOGO_API_URL}/api/internal/projects/:targetProjectId/remote-tool   (RBAC, wake)
 *     → POST <target runtime>/agent/remote/tool                                   (x-runtime-token)
 *     → the target's own tool, rooted at the target project's folder
 *
 * Remotable tools (`REMOTE_TOOL_ALLOWLIST`):
 *   exec, exec_wait, exec_list, read_file, write_file, edit_file, delete_file, search
 * Read-only subset (`REMOTE_READONLY_TOOLS`; the API keeps its own copy for RBAC):
 *   read_file, search, exec_list, exec_wait
 *
 * Never remotable: mount/unmount, connect_project, copy_to_project, the project lifecycle tools
 * (project_attach, project_create, project_call, …) and anything that spawns
 * agents. The runtime route strips `project` from the args it receives, so a
 * call can never hop on to a third runtime.
 */

import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { deriveApiUrl, getInternalHeaders } from './internal-api'
import { isHostMediatedDurability } from './host-durability'

export const REMOTE_TOOL_ALLOWLIST = [
  'exec',
  'exec_wait',
  'exec_list',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'search',
] as const

export const REMOTE_READONLY_TOOLS = ['read_file', 'search', 'exec_list', 'exec_wait'] as const

export type RemoteToolName = (typeof REMOTE_TOOL_ALLOWLIST)[number]

/**
 * Known tools that must answer 403 rather than 404 even when this runtime
 * does not register them (mount_project only exists in workspace runtimes).
 */
export const REMOTE_DENIED_TOOLS = [
  'mount_project',
  'unmount_project',
  'connect_project',
  'copy_to_project',
  'list_projects',
  'preview_project',
  'project_list',
  'project_create',
  'project_attach',
  'project_detach',
  'project_configure',
  'capabilities_configure',
  'project_call',
  'system_apply',
  'agent_create',
  'agent_spawn',
  'team_create',
  'skill',
] as const

const ALLOWED = new Set<string>(REMOTE_TOOL_ALLOWLIST)
const DENIED = new Set<string>(REMOTE_DENIED_TOOLS)

export function isRemotableTool(name: string): name is RemoteToolName {
  return ALLOWED.has(name)
}

/**
 * The metal substrate: one runtime per project, so other projects are reached
 * over the remote channel instead of being mounted. Metal guests are the
 * host-mediated-durability ones (`SHOGO_DURABILITY_HOST_MEDIATED`, set by the
 * API's build-project-env / build-workspace-env); `SHOGO_RUNTIME_SUBSTRATE`
 * overrides either way.
 */
export function isMetalRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const substrate = env.SHOGO_RUNTIME_SUBSTRATE?.trim().toLowerCase()
  if (substrate) return substrate === 'metal'
  return isHostMediatedDurability(env)
}

/** The project this runtime serves: the anchor in a workspace runtime, else PROJECT_ID. */
export function currentRuntimeProjectId(fallback?: string): string | undefined {
  return process.env.WORKSPACE_ANCHOR_PROJECT_ID || process.env.PROJECT_ID || fallback
}

/**
 * Exec runs are soft-bounded so a remote call answers well inside the ~100s a
 * Cloudflare-fronted request may stay silent. Longer runs come back as
 * `status: "running"` and are polled with `exec_wait` over the same channel.
 */
export const REMOTE_MAX_SOFT_TIMEOUT_MS = 60_000

export function clampRemoteArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const key = tool === 'exec' ? 'timeout' : tool === 'exec_wait' ? 'timeout_ms' : null
  if (!key) return args
  const value = args[key]
  if (typeof value !== 'number' || value <= REMOTE_MAX_SOFT_TIMEOUT_MS) return args
  return { ...args, [key]: REMOTE_MAX_SOFT_TIMEOUT_MS }
}

/** Prompt/WORKSPACE.md text for runtimes that reach other projects remotely. */
export function remoteProjectsGuidance(opts: { copyToProject?: boolean } = {}): string {
  return (
    'Other projects in this workspace are not mounted here: each one runs in its own runtime. ' +
    'Call `connect_project` to check that one is reachable, then pass `project: "<id or name>"` to ' +
    `${REMOTE_TOOL_ALLOWLIST.map((name) => `\`${name}\``).join(', ')} to run that tool inside the other project ` +
    "(paths are relative to that project's root). " +
    (opts.copyToProject
      ? 'To move several files or any binary files into another project, use `copy_to_project`: never copy into a folder ' +
        'named after another project here (it lands only on this runtime), and never use `share_file` for this. '
      : 'Never copy into a folder named after another project here: it lands only on this runtime. ') +
    "Previews are per project too: call `preview_project` with that project's id and use only the URL it " +
    'returns — do not build a link from this runtime\'s base URL. ' +
    "Use `project_call` to hand work to that project's agent."
  )
}

// ---------------------------------------------------------------------------
// Client: caller runtime → API
// ---------------------------------------------------------------------------

export class RemoteToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The failed call's JSON body, when the API or runtime sent one. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RemoteToolError'
  }
}

/** Wake + RBAC + the target's own tool budget, padded. */
const REMOTE_TOOL_REQUEST_TIMEOUT_MS = REMOTE_MAX_SOFT_TIMEOUT_MS + 30_000

/**
 * Run `tool` in `targetProjectId`'s own runtime through the API. Same headers
 * as project_call (runtime token plus the signed requester ticket of the
 * person whose turn this is), so the API authorizes the call as that person.
 */
export async function callRemoteTool(
  targetProjectId: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult<any>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) throw new RemoteToolError('No API URL configured', 0)
  const timeout = AbortSignal.timeout(REMOTE_TOOL_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/internal/projects/${encodeURIComponent(targetProjectId)}/remote-tool`, {
      method: 'POST',
      headers: getInternalHeaders(),
      body: JSON.stringify({ tool, args: clampRemoteArgs(tool, args) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err: any) {
    if (signal?.aborted && !timeout.aborted) {
      throw new RemoteToolError(`Remote ${tool} in project ${targetProjectId} was cancelled`, 0, 'aborted')
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new RemoteToolError(
      timedOut
        ? `Remote ${tool} in project ${targetProjectId} timed out`
        : `Remote ${tool} in project ${targetProjectId} failed: ${err?.message ?? err}`,
      0,
      timedOut ? 'timeout' : undefined,
    )
  }
  const json = (await res.json().catch(() => null)) as any
  if (res.ok && json?.ok === true && json.result && Array.isArray(json.result.content)) {
    return json.result as AgentToolResult<any>
  }
  const err = json?.error
  const code = typeof err === 'string' ? err : typeof err?.code === 'string' ? err.code : undefined
  const message = typeof err?.message === 'string' ? err.message : typeof err === 'string' ? err : `HTTP ${res.status}`
  throw new RemoteToolError(
    `Remote ${tool} in project ${targetProjectId} failed (HTTP ${res.status}): ${message}`,
    res.status,
    code,
    json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined,
  )
}

// ---------------------------------------------------------------------------
// Server: `/agent/remote/tool` on the target runtime
// ---------------------------------------------------------------------------

export type RemoteToolResponse =
  | { ok: true; result: AgentToolResult<any> }
  | { ok: false; error: string }

export interface RemoteToolOutcome {
  status: 200 | 400 | 403 | 404 | 500
  body: RemoteToolResponse
}

/**
 * Execute one remote tool call against `tools` (this runtime's own tool set,
 * built for its own project root). Pure apart from the tool itself, so the
 * route stays a thin adapter.
 */
export async function executeRemoteTool(tools: AgentTool[], rawBody: unknown): Promise<RemoteToolOutcome> {
  const body = rawBody as { tool?: unknown; args?: unknown; callerProjectId?: unknown } | null
  if (!body || typeof body.tool !== 'string' || !body.tool) {
    return { status: 400, body: { ok: false, error: 'Missing required field: tool (string)' } }
  }
  const tool = body.tool
  const caller = typeof body.callerProjectId === 'string' && body.callerProjectId ? body.callerProjectId : 'unknown'
  const outcome = await run()
  console.log(`[remote-tool] caller=${caller} tool=${tool} status=${outcome.status}`)
  return outcome

  async function run(): Promise<RemoteToolOutcome> {
    const found = tools.find((t) => t.name === tool)
    if (!isRemotableTool(tool)) {
      return found || DENIED.has(tool)
        ? { status: 403, body: { ok: false, error: 'tool_not_remotable' } }
        : { status: 404, body: { ok: false, error: 'unknown_tool' } }
    }
    if (!found) return { status: 404, body: { ok: false, error: 'unknown_tool' } }
    const rawArgs = body!.args && typeof body!.args === 'object' && !Array.isArray(body!.args)
      ? (body!.args as Record<string, unknown>)
      : {}
    const { project: _project, ...args } = rawArgs
    try {
      const result = await found.execute(`remote-${crypto.randomUUID()}`, clampRemoteArgs(tool, args))
      return { status: 200, body: { ok: true, result } }
    } catch (err: any) {
      return { status: 500, body: { ok: false, error: err?.message ?? String(err) } }
    }
  }
}
