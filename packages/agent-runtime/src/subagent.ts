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
  'exec', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'ls', 'web', 'browser',
  'list_files', 'delete_file', 'search_files',
  'todo_write', 'ask_user', 'skill',
  'memory_read', 'memory_search',
  'send_message', 'channel_connect', 'channel_disconnect', 'channel_list', 'cron',
  'canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch', 'canvas_delete', 'canvas_components',
  'canvas_inspect', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_api_hooks', 'canvas_api_bind',
  'tool_search', 'tool_install', 'tool_uninstall',
  'mcp_search', 'mcp_install', 'mcp_uninstall',
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
read_file, glob, grep, ls, web — read-only exploration tools.

## Guidelines
- Use glob to find files by pattern first.
- Use grep to search for specific patterns, symbols, or strings.
- Use ls to understand directory structure.
- Read files to understand implementation details.
- Use web to look up documentation or external references when needed.
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
        toolNames: ['read_file', 'glob', 'grep', 'ls', 'web'],
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
