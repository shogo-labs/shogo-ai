// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo deploy` — reconcile `shogo.config.json#agents` with the
 * project's cloud-side `project_agents` table.
 *
 * The CLI is a thin wrapper around
 * `POST /api/projects/:projectId/agents/sync` (apps/api). All
 * validation of the manifest happens once on the client (here) and
 * once on the server (`projectAgentSync.service.ts`). The server is
 * still authoritative — but pushing validation to the CLI gives users
 * helpful errors before any network round-trip and makes the deploy
 * command CI-friendly.
 *
 * Pure module: no I/O at import time. Side effects (fetch, console)
 * are reachable only through `runDeploy`. The validator and payload
 * builder are exported so unit tests can exercise them without
 * spinning up a network mock.
 */

/**
 * A tool the named agent is permitted to invoke. Either form is
 * accepted in `shogo.config.json`:
 *
 *   - `"add_memory"` — name-only sugar; the consumer's `clientTools`
 *     map is responsible for declaring the schema to the model. Used
 *     for backwards-compat with manifests written before tool schemas
 *     existed.
 *   - `{ name, description?, inputSchema? }` — full descriptor. The
 *     manifest becomes the source of truth: ElevenLabs gets the same
 *     schema (so the voice agent can `tool-call`), and the chat route
 *     declares it to `streamText` directly. `clientTools` only needs
 *     to provide the handler.
 */
export type AgentToolEntry =
  | string
  | {
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
    }

/**
 * Normalized tool descriptor shipped on the wire to
 * `POST /api/projects/:id/agents/sync`. String sugar from the manifest
 * is expanded to `{ name }` here so the API receives a single shape.
 */
export interface ToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface AgentManifestEntry {
  systemPrompt?: string
  /**
   * Tools the named agent is permitted to invoke. See {@link AgentToolEntry}.
   * After validation the descriptors are normalized to
   * {@link ToolDescriptor}; `manifest.tools` keeps the user's original
   * shape so downstream code can preserve sugar in error messages.
   */
  tools?: AgentToolEntry[]
  characterName?: string
  displayName?: string
  voiceId?: string
  firstMessage?: string
  /**
   * Chat-side model id (forwarded to the AI proxy / Anthropic
   * directly). Falls back to the project's default chat model when
   * unset.
   */
  model?: string
}

export interface AgentsManifest {
  [name: string]: AgentManifestEntry
}

/** Allowed agent name shape; server enforces the same regex. */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

export interface ValidationIssue {
  /** Dot-path to the offending field, e.g. `agents.architect.tools[2]`. */
  path: string
  message: string
}

export interface ValidatedManifest {
  agents: AgentsManifest
  issues: ValidationIssue[]
}

const KNOWN_KEYS = new Set<keyof AgentManifestEntry>([
  'systemPrompt',
  'tools',
  'characterName',
  'displayName',
  'voiceId',
  'firstMessage',
  'model',
])

/**
 * Validate the `agents` block of a parsed `shogo.config.json`.
 * Returns the trimmed manifest plus a list of issues. The deploy
 * command treats a non-empty issues list as a hard failure unless
 * the caller passes `--force` (not implemented here; the CLI layer
 * decides).
 */
export function validateManifest(raw: unknown): ValidatedManifest {
  const issues: ValidationIssue[] = []
  if (raw == null) return { agents: {}, issues }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({
      path: 'agents',
      message: '`agents` must be an object keyed by agent name',
    })
    return { agents: {}, issues }
  }

  const agents: AgentsManifest = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT_NAME_PATTERN.test(name)) {
      issues.push({
        path: `agents.${name}`,
        message: `agent name must match ${AGENT_NAME_PATTERN}`,
      })
      continue
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({
        path: `agents.${name}`,
        message: 'value must be an object',
      })
      continue
    }
    const entry: AgentManifestEntry = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!KNOWN_KEYS.has(k as keyof AgentManifestEntry)) {
        issues.push({
          path: `agents.${name}.${k}`,
          message: `unknown field; supported: ${[...KNOWN_KEYS].join(', ')}`,
        })
        continue
      }
      if (k === 'tools') {
        if (!Array.isArray(v)) {
          issues.push({
            path: `agents.${name}.tools`,
            message: 'must be an array of strings or { name, description?, inputSchema? } objects',
          })
          continue
        }
        const tools: AgentToolEntry[] = []
        const seenNames = new Set<string>()
        let valid = true
        for (let i = 0; i < v.length; i++) {
          const t = v[i]
          if (typeof t === 'string') {
            if (t.length === 0) {
              issues.push({
                path: `agents.${name}.tools[${i}]`,
                message: 'tool name must be a non-empty string',
              })
              valid = false
              continue
            }
            if (seenNames.has(t)) {
              issues.push({
                path: `agents.${name}.tools[${i}]`,
                message: `duplicate tool name '${t}'`,
              })
              valid = false
              continue
            }
            seenNames.add(t)
            tools.push(t)
            continue
          }
          if (t == null || typeof t !== 'object' || Array.isArray(t)) {
            issues.push({
              path: `agents.${name}.tools[${i}]`,
              message: 'tools entries must be a string or { name, description?, inputSchema? }',
            })
            valid = false
            continue
          }
          const obj = t as Record<string, unknown>
          if (typeof obj.name !== 'string' || obj.name.length === 0) {
            issues.push({
              path: `agents.${name}.tools[${i}].name`,
              message: 'name is required and must be a non-empty string',
            })
            valid = false
            continue
          }
          if (seenNames.has(obj.name)) {
            issues.push({
              path: `agents.${name}.tools[${i}]`,
              message: `duplicate tool name '${obj.name}'`,
            })
            valid = false
            continue
          }
          if (
            obj.description !== undefined &&
            typeof obj.description !== 'string'
          ) {
            issues.push({
              path: `agents.${name}.tools[${i}].description`,
              message: 'description must be a string',
            })
            valid = false
            continue
          }
          if (
            obj.inputSchema !== undefined &&
            (obj.inputSchema === null ||
              typeof obj.inputSchema !== 'object' ||
              Array.isArray(obj.inputSchema))
          ) {
            issues.push({
              path: `agents.${name}.tools[${i}].inputSchema`,
              message: 'inputSchema must be a JSON Schema object',
            })
            valid = false
            continue
          }
          seenNames.add(obj.name)
          const descriptor: AgentToolEntry = { name: obj.name }
          if (typeof obj.description === 'string') {
            descriptor.description = obj.description
          }
          if (obj.inputSchema !== undefined) {
            descriptor.inputSchema = obj.inputSchema as Record<string, unknown>
          }
          tools.push(descriptor)
        }
        if (valid) entry.tools = tools
        continue
      }
      if (typeof v !== 'string') {
        issues.push({
          path: `agents.${name}.${k}`,
          message: 'must be a string',
        })
        continue
      }
      ;(entry as Record<string, unknown>)[k] = v
    }
    if (entry.voiceId && !entry.firstMessage) {
      issues.push({
        path: `agents.${name}.firstMessage`,
        message: 'voiceId is set; consider providing firstMessage so the agent has a greeting',
      })
    }
    agents[name] = entry
  }
  return { agents, issues }
}

export interface BuildSyncPayloadOptions {
  manifest: AgentsManifest
  prune: boolean
  dryRun: boolean
}

/** Wire payload for `POST /api/projects/:id/agents/sync`. */
export interface SyncPayload {
  agents: Record<
    string,
    {
      systemPrompt?: string
      tools?: ToolDescriptor[]
      characterName?: string
      displayName?: string
      voiceId?: string
      firstMessage?: string
      model?: string
    }
  >
  prune: boolean
  dryRun: boolean
}

/** Expand string sugar into a normalized {@link ToolDescriptor}. */
export function normalizeToolEntry(entry: AgentToolEntry): ToolDescriptor {
  if (typeof entry === 'string') return { name: entry }
  const out: ToolDescriptor = { name: entry.name }
  if (entry.description !== undefined) out.description = entry.description
  if (entry.inputSchema !== undefined) out.inputSchema = entry.inputSchema
  return out
}

/**
 * Convert a CLI-side manifest to the wire shape the API expects. The
 * shape matches `apps/api/src/services/projectAgentSync.service.ts`.
 *
 * Tool entries are normalized to `ToolDescriptor[]` here — the API
 * never sees the string sugar.
 */
export function buildSyncPayload(opts: BuildSyncPayloadOptions): SyncPayload {
  const out: SyncPayload = { agents: {}, prune: opts.prune, dryRun: opts.dryRun }
  for (const [name, entry] of Object.entries(opts.manifest)) {
    const a: SyncPayload['agents'][string] = {}
    if (entry.systemPrompt !== undefined) a.systemPrompt = entry.systemPrompt
    if (entry.tools !== undefined) {
      a.tools = entry.tools.map(normalizeToolEntry)
    }
    if (entry.characterName !== undefined) a.characterName = entry.characterName
    if (entry.displayName !== undefined) a.displayName = entry.displayName
    if (entry.voiceId !== undefined) a.voiceId = entry.voiceId
    if (entry.firstMessage !== undefined) a.firstMessage = entry.firstMessage
    if (entry.model !== undefined) a.model = entry.model
    out.agents[name] = a
  }
  return out
}

/**
 * Two ways to authenticate a deploy:
 *
 *   - `apiKey` — `Authorization: Bearer shogo_sk_*`. The default for
 *     a developer running `shogo deploy` from their own machine.
 *   - `runtimeToken` — `x-runtime-token: <token>`. The path used by
 *     `shogo dev` preflight inside a warm pod, where the pod's
 *     runtime token is already in env (`RUNTIME_AUTH_SECRET`).
 *
 * The server enforces that runtime-token deploys are scoped to the
 * token's own project (no cross-project mutations).
 */
export type DeployAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'runtimeToken'; token: string }

export interface RunDeployOptions {
  apiUrl: string
  projectId: string
  manifest: AgentsManifest
  prune: boolean
  dryRun: boolean
  /**
   * Authentication for the deploy request. Either `{ kind: 'apiKey',
   * apiKey }` (developer flow) or `{ kind: 'runtimeToken', token }`
   * (warm-pod preflight flow).
   *
   * Legacy callers may still pass `shogoApiKey` directly — it is
   * promoted to `auth: { kind: 'apiKey', apiKey: shogoApiKey }` for
   * backwards compatibility.
   */
  auth?: DeployAuth
  /** @deprecated Pass `auth: { kind: 'apiKey', apiKey }` instead. */
  shogoApiKey?: string
  fetchImpl?: typeof fetch
}

export interface RunDeployResult {
  status: number
  body: unknown
}

/**
 * Resolve the auth header pair for a deploy request. Throws when
 * neither `auth` nor the legacy `shogoApiKey` is supplied.
 */
function resolveDeployHeaders(
  options: RunDeployOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  const auth: DeployAuth | undefined =
    options.auth ??
    (options.shogoApiKey
      ? { kind: 'apiKey', apiKey: options.shogoApiKey }
      : undefined)
  if (!auth) {
    throw new Error(
      'runDeploy: missing auth — pass `auth: { kind: "apiKey", apiKey }` or `auth: { kind: "runtimeToken", token }`',
    )
  }
  if (auth.kind === 'apiKey') {
    headers.authorization = `Bearer ${auth.apiKey}`
  } else {
    headers['x-runtime-token'] = auth.token
  }
  return headers
}

/**
 * Issue the sync request. Caller is responsible for resolving
 * `apiUrl`, `projectId`, and `auth` (typically from the environment +
 * `shogo.config.json`).
 */
export async function runDeploy(
  options: RunDeployOptions,
): Promise<RunDeployResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('runDeploy: global fetch is unavailable; pass options.fetchImpl')
  }
  const url = `${options.apiUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(options.projectId)}/agents/sync`
  const payload = buildSyncPayload({
    manifest: options.manifest,
    prune: options.prune,
    dryRun: options.dryRun,
  })
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: resolveDeployHeaders(options),
    body: JSON.stringify(payload),
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body }
}
