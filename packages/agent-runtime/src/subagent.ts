// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Subagent System
 *
 * Spawns isolated Pi agent sub-loops for focused tasks. Each subagent gets
 * its own context window, restricted tools, and optional model override.
 * Subagents cannot spawn further subagents (no infinite nesting).
 *
 * Built-in types: explore, general-purpose.
 * Custom types loaded from .shogo/agents/<name>.md at startup.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { runAgentLoop, type AgentLoopResult, type LoopDetectorConfig } from './agent-loop'
import type { ToolContext } from './gateway-tools'

// ---------------------------------------------------------------------------
// Core gateway tool names — anything NOT in this set is a dynamic/installed
// tool (Composio action, MCP tool) that should pass through when
// includeInstalledTools is true.
// ---------------------------------------------------------------------------

const CORE_GATEWAY_TOOLS = new Set([
  'exec', 'read_file', 'write_file', 'edit_file', 'web', 'browser',
  'delete_file', 'search', 'impact_radius', 'detect_changes', 'review_context',
  'todo_write', 'ask_user', 'skill',
  'memory_read', 'memory_search',
  'send_message', 'channel_connect', 'channel_disconnect', 'channel_list',
  'heartbeat_configure', 'heartbeat_status',
  'tool_search', 'tool_install', 'tool_uninstall',
  'mcp_search', 'mcp_install', 'mcp_uninstall',
  'quick_action',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTierName = 'fast' | 'default' | 'capable'

export interface SubagentConfig {
  name: string
  description: string
  systemPrompt: string
  /** Tool names to include. If empty/undefined, inherit all (minus task). */
  toolNames?: string[]
  /** Tool names to explicitly exclude. */
  disallowedTools?: string[]
  /** When true, also include dynamically installed tools (Composio actions, MCP tools) from the parent agent. */
  includeInstalledTools?: boolean
  model?: string
  provider?: string
  /** Model tier shorthand — resolved to a concrete model name via resolveModelTier(). */
  modelTier?: ModelTierName
  maxTurns?: number
  /** Override working directory for file tools (scoping). */
  workingDir?: string
  /** Max output tokens per LLM call. Defaults to the model's max from the catalog. */
  maxTokens?: number
  /** Override loop detector config. Pass false to disable. */
  loopDetection?: Partial<LoopDetectorConfig> | false
  /** When true, strip all write/mutating tools — only read-only tools are available. */
  readonly?: boolean
}

export interface SubagentResult {
  toolCalls: number
  iterations: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** The subagent's final text response (last assistant message content). */
  responseText: string
  /** Conversation messages produced during this run (for resume support). */
  newMessages?: Message[]
  /** Unique agent ID for transcript persistence and resume. */
  agentId?: string
  /** The actual model used for the final iteration (may differ from config if router active). */
  effectiveModel?: string
}

export interface SubagentStreamCallbacks {
  onStart?: (name: string, description: string, agentId: string) => void
  onEnd?: (name: string) => void
  onTextDelta?: (delta: string) => void
  onThinkingStart?: () => void
  onThinkingDelta?: (delta: string) => void
  onThinkingEnd?: () => void
  onToolCall?: (name: string, input: any) => void
  onBeforeToolCall?: (toolName: string, args: any, toolCallId: string) => Promise<void>
  onAfterToolCall?: (toolName: string, args: any, result: any, isError: boolean, toolCallId: string) => Promise<void>
  onToolCallStart?: (toolName: string, toolCallId: string) => void
  onToolCallDelta?: (toolName: string, delta: string, toolCallId: string) => void
  onToolCallEnd?: (toolName: string, toolCallId: string) => void
}

// ---------------------------------------------------------------------------
// Built-in Subagent Definitions
// ---------------------------------------------------------------------------

export const EXPLORE_SYSTEM_PROMPT = `You are an exploration subagent. Search and analyze the codebase efficiently.

## Your Scope
Read-only codebase exploration. Find files, search for patterns, read code, and return specific findings with file references.

## Available Tools
read_file, exec, search, web, impact_radius — exploration and analysis tools.

## Guidelines
- Use exec to run shell commands (e.g. find, rg, ls) for file discovery and searching.
- Use search for semantic code search.
- Read files to understand implementation details.
- Use web to look up documentation or external references when needed.
- Use impact_radius to check blast radius for specific files when assessing change scope.
- Be thorough but concise in your findings.
- Always include specific file paths and line references.
- Return a structured summary of what you found.`

export const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose subagent. Complete the given task using all available tools.

## Guidelines
- Plan your approach before acting.
- Use the most appropriate tool for each step.
- Use web to look up documentation or external references when needed.
- Be thorough but efficient.
- Return a clear summary of what you did and the results.`

export const CODE_REVIEWER_SYSTEM_PROMPT = `You are a code review subagent. Analyze code changes, assess risk, identify test gaps, and provide actionable review feedback.

## Workflow
1. Start with \`detect_changes()\` to understand what changed, which functions are affected, and their risk scores.
2. Use \`review_context()\` for a full review bundle: structural subgraph, source hunks, affected flows, and auto-generated guidance.
3. Use \`impact_radius({ files: [...] })\` to check blast radius for specific files if needed.
4. Read specific files with \`read_file\` for deeper inspection of risky areas.
5. Use \`search\` or \`exec\` to trace references or find related code.

## Review Priorities
- Untested functions with high risk scores — recommend adding tests.
- Security-sensitive code (auth, crypto, SQL, permissions) — flag for careful review.
- Wide blast radius changes — suggest incremental deployment or feature flags.
- Inheritance chain changes — verify subclass contract compatibility.
- Execution flow disruptions — check if critical flows are affected.

## Output Format
Return a structured review with:
- Summary of changes and overall risk level
- Per-file/function risk assessment
- Test coverage gaps with specific recommendations
- Review guidance and action items
- Affected execution flows and their criticality`

export const INTEGRATION_SUBAGENT_PROMPT = `You are a tool and MCP integration subagent. Discover, search, install, and uninstall tools and MCP servers.

## Available Tools
tool_search, tool_install, tool_uninstall — managed integrations (Composio, bundled tools)
mcp_search, mcp_install, mcp_uninstall — MCP server discovery and lifecycle
read_file, write_file — save config or results to the workspace

## Guidelines
- Search before installing — confirm the right tool/server exists first
- For Composio tools: search by keyword, install with the toolkit name
- For MCP servers: search the catalog, install by ID
- After installation, verify the tool is available
- Return a clear summary of what was installed and how to use it`

export const CHANNEL_SUBAGENT_PROMPT = `You are a channel management subagent. Connect, configure, and manage messaging channels.

## Available Tools
channel_connect — connect a new channel (Telegram, Discord, webchat, etc.)
channel_disconnect — disconnect an existing channel
channel_list — list connected channels
send_message — send a message through a connected channel
read_file, write_file — save config or results to the workspace

## Guidelines
- Check channel_list before connecting to avoid duplicates
- For channel_connect: guide the user through required config (tokens, webhook URLs, etc.)
- For send_message: confirm the target channel is connected first
- Return clear status updates about what was configured`

export const DEVOPS_SUBAGENT_PROMPT = `You are a DevOps subagent. Manage heartbeat schedules, monitoring, and skill server synchronization.

## Available Tools
heartbeat_configure — set up or modify heartbeat scheduling (interval, quiet hours)
heartbeat_status — check current heartbeat configuration
skill_server_sync — synchronize skills with the skill server
read_file, write_file — save config or results to the workspace

## Guidelines
- Check heartbeat_status before modifying configuration
- When setting quiet hours, confirm the user's timezone
- For skill_server_sync: run after skill changes to keep the server in sync
- Return a clear summary of the current configuration state`

export const BROWSER_SUBAGENT_PROMPT = `You are a browser automation subagent. Navigate web pages, interact with elements, and extract information.

## Available Tools
browser — full browser automation (navigate, snapshot, click, fill, screenshot, etc.)
web — HTTP fetch for APIs, documentation, or page content
read_file, write_file — save results to the workspace

## Core Workflow
1. \`navigate\` to a URL
2. \`snapshot\` to get the accessibility tree with numbered element refs
3. Read the snapshot to find the elements you need
4. Use \`click\`, \`fill\`, or \`select\` with the \`ref\` parameter to interact
5. After actions that change the page, \`snapshot\` again
6. Use \`screenshot\` for visual verification of non-text content

## Key Rules
- Always snapshot before interacting — mandatory, not optional
- Prefer \`ref\` over \`selector\` — ref numbers from snapshot are reliable
- Snapshot after every page change
- Use \`fill\` to clear and replace input content
- Use short incremental waits with snapshot checks between them
- Save important findings to workspace files for the parent agent`

export const MEDIA_SUBAGENT_PROMPT = `You are a media processing subagent. Generate images and transcribe audio.

## Available Tools
generate_image — create images from text descriptions
transcribe_audio — convert audio files to text
read_file, write_file — read inputs and save results to the workspace

## Guidelines
- For image generation: provide detailed, specific descriptions for best results
- For transcription: read the audio file path from the prompt, transcribe, and save the text output
- Always save results to the workspace so the parent agent can access them
- Return a clear summary of what was produced and where files were saved`

export function getBuiltinSubagentConfig(
  name: string,
  ctx: ToolContext,
  allTools: AgentTool[],
): SubagentConfig | null {
  switch (name) {
    case 'explore':
      return {
        name: 'explore',
        description: 'Fast read-only codebase exploration agent',
        systemPrompt: EXPLORE_SYSTEM_PROMPT,
        toolNames: ['read_file', 'exec', 'search', 'web', 'impact_radius'],
        disallowedTools: ['task', 'skill'],
        model: 'claude-haiku-4-5',
        maxTurns: 5,
      }
    case 'general-purpose':
      return {
        name: 'general-purpose',
        description: 'Full-capability subagent for complex multi-step tasks',
        systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
        disallowedTools: ['task', 'skill'],
      }
    case 'code-reviewer':
      return {
        name: 'code-reviewer',
        description: 'Code review agent — analyzes changes, risk scores, test gaps, and execution flows',
        systemPrompt: CODE_REVIEWER_SYSTEM_PROMPT,
        toolNames: ['read_file', 'search', 'exec', 'impact_radius', 'detect_changes', 'review_context'],
        disallowedTools: ['task', 'skill'],
        maxTurns: 10,
      }
    case 'browser':
      return {
        name: 'browser',
        description: 'Browser automation and web research agent',
        systemPrompt: BROWSER_SUBAGENT_PROMPT,
        toolNames: ['browser', 'web', 'read_file', 'write_file'],
        disallowedTools: ['task', 'skill'],
        model: 'claude-haiku-4-5',
        maxTurns: 15,
      }
    case 'integration':
      return {
        name: 'integration',
        description: 'Tool and MCP server discovery, installation, and management',
        systemPrompt: INTEGRATION_SUBAGENT_PROMPT,
        toolNames: ['tool_search', 'tool_install', 'tool_uninstall', 'mcp_search', 'mcp_install', 'mcp_uninstall', 'read_file', 'write_file'],
        includeInstalledTools: true,
        disallowedTools: ['task', 'skill'],
        maxTurns: 10,
      }
    case 'channel':
      return {
        name: 'channel',
        description: 'Channel connection and messaging agent',
        systemPrompt: CHANNEL_SUBAGENT_PROMPT,
        toolNames: ['channel_connect', 'channel_disconnect', 'channel_list', 'send_message', 'read_file', 'write_file'],
        disallowedTools: ['task', 'skill'],
        maxTurns: 5,
      }
    case 'media':
      return {
        name: 'media',
        description: 'Image generation and audio transcription agent',
        systemPrompt: MEDIA_SUBAGENT_PROMPT,
        toolNames: ['generate_image', 'transcribe_audio', 'read_file', 'write_file'],
        disallowedTools: ['task', 'skill'],
        model: 'claude-haiku-4-5',
        maxTurns: 5,
      }
    case 'devops':
      return {
        name: 'devops',
        description: 'Heartbeat scheduling, monitoring, and skill server management',
        systemPrompt: DEVOPS_SUBAGENT_PROMPT,
        toolNames: ['heartbeat_configure', 'heartbeat_status', 'skill_server_sync', 'read_file', 'write_file'],
        disallowedTools: ['task', 'skill'],
        maxTurns: 5,
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Custom Subagent Loader (.shogo/agents/<name>.md)
// ---------------------------------------------------------------------------

export interface CustomAgentDef {
  name: string
  description: string
  systemPrompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  maxTurns?: number
}

export function loadCustomAgents(workspaceDir: string): CustomAgentDef[] {
  const agentsDir = join(workspaceDir, '.shogo', 'agents')
  if (!existsSync(agentsDir)) return []

  const agents: CustomAgentDef[] = []
  try {
    for (const entry of readdirSync(agentsDir)) {
      if (!entry.endsWith('.md')) continue
      const filePath = join(agentsDir, entry)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = parseAgentFrontmatter(raw)
        if (!parsed.name || !parsed.description) {
          console.warn(`[Subagent] Skipping ${entry}: missing name or description`)
          continue
        }
        agents.push(parsed)
      } catch (err: any) {
        console.error(`[Subagent] Failed to load ${entry}:`, err.message)
      }
    }
  } catch { /* directory unreadable */ }
  return agents
}

function parseAgentFrontmatter(raw: string): CustomAgentDef {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { name: '', description: '', systemPrompt: raw }
  }

  const [, frontmatter, body] = match
  const meta: Record<string, any> = {}

  for (const line of frontmatter.split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const key = line.substring(0, colonIndex).trim()
    let value = line.substring(colonIndex + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean)
    } else if (value.startsWith('"') && value.endsWith('"')) {
      meta[key] = value.slice(1, -1)
    } else {
      meta[key] = value
    }
  }

  return {
    name: meta.name || '',
    description: meta.description || '',
    systemPrompt: body.trim(),
    tools: Array.isArray(meta.tools) ? meta.tools : undefined,
    disallowedTools: Array.isArray(meta.disallowedTools) ? meta.disallowedTools : undefined,
    model: meta.model,
    maxTurns: meta.maxTurns ? parseInt(meta.maxTurns, 10) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Model Tier Resolution
// ---------------------------------------------------------------------------

import { CONCURRENT_SAFE_TOOLS } from './tool-orchestration'

const MODEL_TIER_MAP: Record<ModelTierName, string> = {
  fast: 'claude-haiku-4-5',
  default: '', // sentinel — uses parent model
  capable: 'claude-sonnet-4-6',
}

export function resolveModelTier(tier: ModelTierName | undefined, parentModel: string): string {
  if (!tier || tier === 'default') return parentModel
  return MODEL_TIER_MAP[tier] || parentModel
}

// ---------------------------------------------------------------------------
// Read-only tool set (used by readonly mode)
// ---------------------------------------------------------------------------

const READONLY_TOOLS = new Set([
  ...CONCURRENT_SAFE_TOOLS,
  'ask_user',
  'todo_write',
])

// ---------------------------------------------------------------------------
// Subagent Execution
// ---------------------------------------------------------------------------

import type { ThinkingLevel } from './agent-loop'

export interface ForkContext {
  /** Parent's fully rendered system prompt (byte-exact for prompt cache reuse). */
  systemPrompt: string
  /** Parent's current conversation history. */
  parentMessages: Message[]
  /** Parent's exact tool array (used directly, no filtering). */
  parentTools: AgentTool[]
  /** Inherit thinking level from parent. */
  thinkingLevel?: ThinkingLevel
}

export interface SubagentRunOptions {
  /** Pre-existing conversation history for resume support. */
  history?: Message[]
  /** Fork context — when present, the subagent inherits the parent's full context. */
  forkContext?: ForkContext
  /** Custom stream function for testing — replaces the real LLM call. */
  streamFn?: import('@mariozechner/pi-agent-core').StreamFn
}

/**
 * Filters out assistant messages that contain tool_use blocks without matching
 * tool_result messages. This prevents API errors when passing parent history
 * to fork subagents, since incomplete tool calls cause invalid conversation state.
 *
 * Adapted for Pi AI message types (role-based with content blocks).
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  const idsWithResults = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'toolResult') {
      idsWithResults.add(msg.toolCallId)
    }
  }
  return messages.filter(msg => {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasIncomplete = msg.content.some(
        (block: any) => block.type === 'toolCall' && block.id && !idsWithResults.has(block.id),
      )
      if (hasIncomplete) return false
    }
    return true
  })
}

export async function runSubagent(
  config: SubagentConfig,
  prompt: string,
  parentCtx: ToolContext,
  allParentTools: AgentTool[],
  callbacks?: SubagentStreamCallbacks,
  options?: SubagentRunOptions,
): Promise<SubagentResult> {
  const agentId = createAgentId(config.name)
  callbacks?.onStart?.(config.name, config.description, agentId)

  const forkCtx = options?.forkContext
  const isFork = !!forkCtx

  const subCtx: ToolContext = {
    ...parentCtx,
    workspaceDir: config.workingDir || parentCtx.workspaceDir,
    fileStateCache: parentCtx.fileStateCache?.clone(),
    renderedSystemPrompt: undefined,
    sessionMessages: undefined,
  }

  // Ensure working directory exists
  if (config.workingDir && !existsSync(config.workingDir)) {
    mkdirSync(config.workingDir, { recursive: true })
  }

  let tools: AgentTool[]
  let systemPrompt: string
  let history: Message[]
  let thinkingLevel: ThinkingLevel = 'medium'

  if (isFork) {
    // Fork mode: use parent's exact system prompt, tools, and filtered history.
    // This enables prompt cache reuse and full context awareness.
    systemPrompt = forkCtx.systemPrompt
    tools = forkCtx.parentTools
    history = filterIncompleteToolCalls(forkCtx.parentMessages)
    if (forkCtx.thinkingLevel) thinkingLevel = forkCtx.thinkingLevel
  } else {
    // Normal mode: build tool set from config
    systemPrompt = config.systemPrompt
    history = options?.history || []

    if (config.toolNames && config.toolNames.length > 0) {
      const allowSet = new Set(config.toolNames)
      tools = allParentTools.filter(t => allowSet.has(t.name))

      if (config.includeInstalledTools) {
        const alreadyIncluded = new Set(tools.map(t => t.name))
        const dynamicTools = allParentTools.filter(t =>
          !alreadyIncluded.has(t.name) && !CORE_GATEWAY_TOOLS.has(t.name),
        )
        tools.push(...dynamicTools)
      }
    } else {
      tools = [...allParentTools]
    }

    // Strip orchestration tools from non-fork subagents (no infinite nesting)
    const disallowed = new Set([
      ...(config.disallowedTools || []),
      'task',
      'agent_create', 'agent_spawn', 'agent_status', 'agent_cancel', 'agent_result', 'agent_list',
    ])
    tools = tools.filter(t => !disallowed.has(t.name))

    if (config.readonly) {
      tools = tools.filter(t => READONLY_TOOLS.has(t.name))
    }
  }

  // Apply eval mock interceptors so subagent tool calls hit the same mocks
  // as the main agent (prevents real network calls during evals).
  if (parentCtx.toolMockFns && parentCtx.toolMockFns.size > 0) {
    tools = tools.map(tool => {
      const mockFn = parentCtx.toolMockFns!.get(tool.name)
      if (!mockFn) return tool
      const realExecute = tool.execute
      return {
        ...tool,
        execute: async (_id: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
          const result = mockFn(params)
          if (result === '__passthrough') return realExecute(_id, params, signal, onUpdate)
          return { type: 'text' as const, value: typeof result === 'string' ? result : JSON.stringify(result) }
        },
      }
    })
  }

  const model = resolveModelTier(config.modelTier, config.model || parentCtx.effectiveModel || parentCtx.config.model.name)
  const provider = config.provider || parentCtx.config.model.provider
  const maxIterations = config.maxTurns || (isFork ? 200 : 10)

  try {
    const result = await runAgentLoop({
      provider,
      model,
      system: systemPrompt,
      history,
      prompt,
      tools,
      maxIterations,
      maxTokens: config.maxTokens,
      thinkingLevel,
      loopDetection: config.loopDetection,
      streamFn: options?.streamFn,
      onToolCall: callbacks?.onToolCall,
      onTextDelta: callbacks?.onTextDelta,
      onThinkingStart: callbacks?.onThinkingStart,
      onThinkingDelta: callbacks?.onThinkingDelta,
      onThinkingEnd: callbacks?.onThinkingEnd,
      onBeforeToolCall: callbacks?.onBeforeToolCall,
      onAfterToolCall: callbacks?.onAfterToolCall,
      onToolCallStart: callbacks?.onToolCallStart,
      onToolCallDelta: callbacks?.onToolCallDelta,
      onToolCallEnd: callbacks?.onToolCallEnd,
    })

    callbacks?.onEnd?.(config.name)

    // Persist transcript if session persistence is available
    if (parentCtx.sessionPersistence && parentCtx.sessionId && result.newMessages) {
      try {
        await parentCtx.sessionPersistence.saveSubagentTranscript(
          agentId,
          parentCtx.sessionId,
          config.name,
          config.description,
          result.newMessages,
        )
      } catch (err: any) {
        console.warn(`[Subagent] Failed to persist transcript for ${agentId}:`, err.message)
      }
    }

    return {
      toolCalls: result.toolCalls.length,
      iterations: result.iterations,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      responseText: result.text,
      newMessages: result.newMessages,
      agentId,
      effectiveModel: result.effectiveModelId,
    }
  } catch (err: any) {
    console.error(`Subagent ${config.name} failed: ${err.message}`)
    callbacks?.onEnd?.(config.name)
    return {
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      responseText: `Subagent failed: ${err.message}`,
      newMessages: [],
      agentId,
    }
  }
}

/**
 * Generates a unique agent ID for transcript persistence.
 * Format: a-{label}-{16 hex chars}
 */
export function createAgentId(label?: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  const slug = label ? label.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 20) : 'agent'
  return `a-${slug}-${hex}`
}

// ---------------------------------------------------------------------------
// Parallel Sub-Agent Execution
// ---------------------------------------------------------------------------

export async function runSubagentsParallel(
  configs: Array<{ config: SubagentConfig; prompt: string }>,
  parentCtx: ToolContext,
  allParentTools: AgentTool[],
  callbacks?: SubagentStreamCallbacks,
): Promise<SubagentResult[]> {
  return Promise.all(
    configs.map(({ config, prompt }) =>
      runSubagent(config, prompt, parentCtx, allParentTools, callbacks),
    ),
  )
}
