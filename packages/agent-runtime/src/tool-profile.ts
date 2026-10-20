/**
 * Tool advertising profile (SHO-97).
 *
 * Every registered tool stays callable, but only a small *advertised* set has
 * its full JSON schema sent to the provider on each API call. Everything else
 * is *deferred*: still dispatchable, named in a compact catalog in the system
 * prompt, and advertised the moment the model asks for it
 * (`read_guide({ tool })`) or calls it directly.
 *
 * Why: tool definitions were ~29k tokens on every API call on a fully-enabled
 * agent — 61% of that in parameter schemas, which only deferral removes.
 *
 * Stability matters as much as size. The tools block is the first segment of
 * the provider cache prefix, so the advertised set is computed once per session
 * and never re-derived per turn; activating a tool only ever *adds* to it.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'

/** Overrides the flag below — `SHOGO_DEFERRED_TOOLS=0` turns deferral off. */
export const DEFERRED_TOOLS_ENV = 'SHOGO_DEFERRED_TOOLS'

/**
 * Always described, whatever the agent's history says: a tool the model must be
 * able to reach without first being told it exists (or without being able to
 * discover it) — file/shell primitives, the discovery tool itself, and the
 * two tools every turn tends to end with.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'exec',
  'todo_write',
  'web',
  'read_guide',
  'ask_user',
  'share_file',
  'agent_spawn',
  // Registered only on some profiles/runtimes — `computeAdvertisedNames` skips
  // names that are not in the tool list, so listing them is free elsewhere.
  'search',
  'read_lints',
]

/**
 * Fallback ranking, most-useful first, used when an agent has too little
 * history to learn from. Order follows 30 days of US production
 * `tool_call_logs` (627k calls): the tools the core set does not already cover
 * come next, then the workspace-agent surfaces.
 */
export const DEFAULT_TOOL_PRIORITY: readonly string[] = [
  'exec',
  'edit_file',
  'read_file',
  'write_file',
  'web',
  'todo_write',
  'agent_spawn',
  'read_lints',
  'share_file',
  'project_call',
  'wait',
  'task_list',
  'task_cancel',
  'search',
  'memory_search',
  'memory_read',
  'create_plan',
  'update_plan',
  'read_history',
  'search_history',
  'browser',
  'terminal_exec',
  'terminal_read',
  'publish',
  'preview_project',
  'list_projects',
  'mount_project',
  'unmount_project',
  'expose_port',
  'skill',
  'quick_action',
  'checkpoint',
  'work_item_get',
  'work_item_list',
  'work_item_update',
  'work_item_move',
  'work_item_create',
  'work_item_comment',
  'team_chat_post',
  'team_chat_read',
  'team_chat_update',
  'team_chat_dm',
  'team_directory',
  'search_integrations',
  'connect',
  'disconnect',
  'channel_connect',
  'channel_list',
  'send_message',
  'notify_user',
  'heartbeat_configure',
  'heartbeat_status',
  'schedule_create',
  'schedule_list',
  'trigger_create',
  'trigger_list',
  'goal_create',
  'goal_log',
  'goal_list',
  'fetch_chat_files',
  'invoke_skill',
  'ask_human',
]

/** Default cap on learned tools advertised on top of the core set. */
export const DEFAULT_MAX_LEARNED = 8

/**
 * Ceiling for the whole advertised tool block, in estimated tokens
 * (`chars / 4`, the same estimate the prompt breakdown logs).
 */
export const DEFAULT_TOKEN_BUDGET = 8_000

/** Below this many logged calls in 30 days the static ranking is used. */
export const LEARNING_MIN_CALLS = 50

/** How long a project's learned ranking is reused before re-reading it. */
export const RANKING_TTL_MS = 60 * 60 * 1000

/** Advertise a core set + the agent's most-used tools; defer the rest. */
export function deferredToolsEnabled(
  config: { deferredToolsEnabled?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env[DEFERRED_TOOLS_ENV]
  if (flag === '0' || flag === 'false') return false
  return config.deferredToolsEnabled !== false
}

/** Estimated provider tokens for one tool definition (same `chars / 4` basis as the prompt breakdown). */
export function estimateToolTokens(tool: AgentTool): number {
  return Math.ceil(toolDefinitionChars(tool) / 4)
}

export function toolDefinitionChars(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }).length
}

/** A deferred tool's full definition, in the shape the model reads. */
export function describeTool(tool: AgentTool): string {
  const lines = [`## \`${tool.name}\``, '', tool.description || '(no description)', '', 'Input schema:']
  lines.push('```json', JSON.stringify(tool.parameters ?? { type: 'object', properties: {} }, null, 2), '```')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface CatalogGroup {
  key: string
  label: string
  names: string[]
}

const INTEGRATION_SLUG_RE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/

/**
 * Managed-integration (`GMAIL_FETCH_EMAILS`) and MCP (`mcp_postgres_query`)
 * tools are named per *toolkit* rather than per tool: a fully-connected agent
 * carries 240 of them and one line each would cost more than the schemas did.
 */
function catalogGroupKey(name: string): { key: string; label: string } | null {
  if (name.startsWith('mcp_')) {
    const rest = name.slice(4)
    const server = rest.split('_')[0] || 'server'
    return { key: `mcp:${server}`, label: `MCP · ${server}` }
  }
  if (INTEGRATION_SLUG_RE.test(name)) {
    const toolkit = name.slice(0, name.indexOf('_'))
    const label = toolkit.charAt(0) + toolkit.slice(1).toLowerCase()
    return { key: `integration:${toolkit}`, label }
  }
  return null
}

function firstSentence(text: string, maxChars = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const stop = flat.search(/\.(\s|$)/)
  const sentence = stop === -1 ? flat : flat.slice(0, stop)
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1).trimEnd()}…` : sentence
}

/**
 * The prompt-zone catalog of deferred tools: one line per ordinary tool, one
 * line per integration/MCP toolkit. Byte-stable for a given (tools, profile).
 */
export function renderDeferredCatalog(tools: readonly AgentTool[], advertised: ReadonlySet<string>): string {
  const deferred = tools.filter((t) => !advertised.has(t.name))
  if (deferred.length === 0) return ''

  const singles: AgentTool[] = []
  const groups = new Map<string, CatalogGroup>()
  for (const tool of deferred) {
    const g = catalogGroupKey(tool.name)
    if (!g) {
      singles.push(tool)
      continue
    }
    const existing = groups.get(g.key)
    if (existing) existing.names.push(tool.name)
    else groups.set(g.key, { key: g.key, label: g.label, names: [tool.name] })
  }

  const lines: string[] = [
    '## Deferred Tools',
    '',
    `These tools are registered and callable, but their schemas are not in the advertised set — that is what keeps`,
    `${deferred.length} definitions off every API call. To use one, either call it directly with the right arguments`,
    '(a direct call works and advertises it for the rest of the session), or call `read_guide({ tool: "<NAME>" })`',
    'first to read its exact description and JSON schema.',
    '',
  ]

  for (const tool of singles) {
    const purpose = firstSentence(tool.description ?? '')
    lines.push(`- \`${tool.name}\`${purpose ? ` — ${purpose}` : ''}`)
  }

  if (groups.size > 0) {
    lines.push('', 'Managed integrations and MCP servers (schemas load on demand):')
    for (const group of groups.values()) {
      const examples = group.names.slice(0, 4)
      const more = group.names.length - examples.length
      const list = more > 0 ? `${examples.join(', ')}, +${more} more` : examples.join(', ')
      const first = group.names[0]
      lines.push(
        `- ${group.label} (${group.names.length} tool${group.names.length === 1 ? '' : 's'}: ${list}) — ` +
          `\`read_guide({ tool: "${first}" })\``,
      )
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface ToolProfileOptions {
  /** Ranked tool names, most-used first. Defaults to `DEFAULT_TOOL_PRIORITY`. */
  learned?: readonly string[]
  /** Always advertised, in order. Defaults to `CORE_TOOL_NAMES`. */
  core?: readonly string[]
  /** Cap on the learned tools added on top of the core set. */
  maxLearned?: number
  /** Ceiling for the advertised block, in estimated tokens. */
  tokenBudget?: number
}

export interface ToolProfile {
  /** Is `name` sent to the provider on the next API call? Unknown names are (they were never deferred). */
  isAdvertised(name: string): boolean
  /** Deferred now, and therefore part of the catalog. */
  isDeferred(name: string): boolean
  /** Advertise a deferred tool from now on. Returns true when it was deferred. */
  advertise(name: string): boolean
  /** Cost of asking `read_guide({ tool })` for it; null when there is no such tool. */
  describe(name: string): string | null
  /** Advertised names, in provider order. */
  advertisedNames(): string[]
  /** Deferred names, in registration order. */
  deferredNames(): string[]
  /** Estimated tokens of the advertised block. */
  advertisedTokens: number
  /** Prompt-zone catalog for everything deferred. Empty when nothing is deferred. */
  catalog: string
}

/**
 * Decide what the provider sees, once per session.
 *
 * Core tools are always advertised. Then learned tools in rank order, while the
 * block stays inside `tokenBudget`. Everything else is deferred.
 */
export function createToolProfile(tools: readonly AgentTool[], opts: ToolProfileOptions = {}): ToolProfile {
  const byName = new Map<string, AgentTool>()
  for (const tool of tools) byName.set(tool.name, tool)

  const advertised = new Set<string>()
  let advertisedTokens = 0
  const add = (name: string, enforceBudget: boolean) => {
    if (advertised.has(name)) return
    const tool = byName.get(name)
    if (!tool) return
    const cost = estimateToolTokens(tool)
    if (enforceBudget && advertisedTokens + cost > (opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET)) return
    advertised.add(name)
    advertisedTokens += cost
  }

  const core = opts.core ?? CORE_TOOL_NAMES
  for (const name of core) add(name, false)

  const learned = opts.learned ?? DEFAULT_TOOL_PRIORITY
  const maxLearned = opts.maxLearned ?? DEFAULT_MAX_LEARNED
  let learnedAdded = 0
  for (const name of learned) {
    if (learnedAdded >= maxLearned) break
    if (advertised.has(name) || !byName.has(name)) continue
    const before = advertised.size
    add(name, true)
    if (advertised.size > before) learnedAdded++
  }

  const deferred = new Set(tools.filter((t) => !advertised.has(t.name)).map((t) => t.name))
  const catalog = renderDeferredCatalog(tools, advertised)

  return {
    isAdvertised: (name: string) => !deferred.has(name),
    isDeferred: (name: string) => deferred.has(name),
    advertise: (name: string) => {
      if (!deferred.has(name)) return false
      deferred.delete(name)
      if (!advertised.has(name) && byName.has(name)) {
        advertised.add(name)
        advertisedTokens += estimateToolTokens(byName.get(name)!)
      }
      return true
    },
    describe: (name: string) => {
      const tool = byName.get(name)
      return tool ? describeTool(tool) : null
    },
    advertisedNames: () => [...advertised].filter((n) => byName.has(n)),
    deferredNames: () => tools.filter((t) => deferred.has(t.name)).map((t) => t.name),
    advertisedTokens,
    catalog,
  }
}

/**
 * Advertise a deferred tool the moment it is called directly, so a model that
 * guessed the name correctly gets the schema on the next call of the same turn.
 */
export function withActivationOnCall<T extends AgentTool>(tool: T, profile: ToolProfile): T {
  const execute = tool.execute
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      profile.advertise(tool.name)
      return execute(toolCallId, params, signal, onUpdate)
    },
  } as T
}

// ---------------------------------------------------------------------------
// Learning: which tools does THIS agent actually use?
// ---------------------------------------------------------------------------

export interface ToolUsageRanking {
  /** Tool names, most-called first. */
  order: string[]
  /** Calls behind the ranking; below `LEARNING_MIN_CALLS` it is not trusted. */
  totalCalls: number
}

const rankingCache = new Map<string, { at: number; value: readonly string[] }>()

/** Drop the in-memory ranking cache (tests, or after a project's data changes). */
export function resetToolRankingCache(): void {
  rankingCache.clear()
}

/**
 * The tool order to advertise for a project: its measured top tools when there
 * is enough history, the static priority otherwise. Cached for `RANKING_TTL_MS`
 * and never throws — a failed lookup just means the static default.
 */
export async function resolveLearnedToolOrder(opts: {
  projectId?: string | null
  load?: (projectId: string) => Promise<ToolUsageRanking | null>
  now?: number
}): Promise<readonly string[]> {
  const { projectId, load } = opts
  if (!projectId || !load) return DEFAULT_TOOL_PRIORITY

  const now = opts.now ?? Date.now()
  const cached = rankingCache.get(projectId)
  if (cached && now - cached.at < RANKING_TTL_MS) return cached.value

  try {
    const ranking = await load(projectId)
    if (!ranking || ranking.totalCalls < LEARNING_MIN_CALLS || ranking.order.length === 0) {
      rankingCache.set(projectId, { at: now, value: DEFAULT_TOOL_PRIORITY })
      return DEFAULT_TOOL_PRIORITY
    }
    const order = [...ranking.order, ...DEFAULT_TOOL_PRIORITY.filter((n) => !ranking.order.includes(n))]
    rankingCache.set(projectId, { at: now, value: order })
    return order
  } catch {
    return DEFAULT_TOOL_PRIORITY
  }
}
