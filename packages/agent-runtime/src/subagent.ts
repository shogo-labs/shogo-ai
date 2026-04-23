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
import { createBrowserTool } from './gateway-tools'

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
  effectiveModelId?: string
}

export interface SubagentStreamCallbacks {
  onStart?: (name: string, description: string, agentId: string) => void
  /** Fired once the subagent's concrete model id is known (after routing/tier resolution). */
  onModelResolved?: (model: string) => void
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

export const BROWSER_QA_SUBAGENT_PROMPT = `You are a QA engineer testing a running web app via the browser. Exercise user flows end-to-end, note the timing and UX of everything as you go, and build a live QA Run canvas surface so the user can watch your progress in real time.

**While you are doing this test, note the timing and UX of everything and compile it into a report when you are done.** The canvas IS the report — keep it updated as you work.

## Available Tools
browser — full browser automation (navigate, snapshot, click, fill, screenshot, console messages, network activity)
web — HTTP fetch for APIs or health-check endpoints
read_file, write_file, edit_file — build and update the canvas surface + save artifacts

## Input Contract
The spawning agent will pass:
- A target URL (the running app — project preview URL or an explicit URL the user supplied)
- A list of user flows to test, or simply "smoke test"
- Optional: credentials, viewport, focus areas

If no URL is provided in the prompt, STOP immediately and return the literal string \`NEED_URL: please provide the URL or preview URL to test\` as your response. Do NOT guess or browse unrelated sites.

## Canvas Surface — the live view

The canvas lives at \`canvas/src/surfaces/\` (TSX components) with sibling \`<Name>.data.json\` files holding live state. The mobile app renders this surface in real time as you edit those files.

**First, check whether \`canvas/src/\` exists in the workspace (use \`read_file\` on \`canvas/src/App.tsx\`):**

- **If canvas exists:** build a QA Run surface.
- **If canvas does NOT exist (read_file fails):** skip the canvas steps entirely and fall back to the markdown report only. Do not try to bootstrap a full canvas project.

### On start (canvas exists)

1. Write \`canvas/src/surfaces/QaRun.data.json\` with the initial state:
\`\`\`json
{
  "targetUrl": "<url>",
  "status": "running",
  "startedAt": "<ISO>",
  "flows": [{ "name": "<flow>", "status": "pending" }],
  "steps": [],
  "issues": [],
  "errors": [],
  "latestScreenshot": null,
  "summary": null,
  "recommendations": []
}
\`\`\`
2. Write \`canvas/src/surfaces/QaRun.tsx\` — a self-contained React component that imports \`./QaRun.data.json\` and renders the dashboard using the primitives other surfaces use: \`Card\`, \`CardHeader\`, \`CardTitle\`, \`CardContent\` from \`@/components/ui/card\`, \`Badge\` from \`@/components/ui/badge\`. Render sections in this order: header card (target URL + status badge + started-at), Flows card (list with status badges), Timing Table, Issues card (severity-prefixed), Errors card, Latest Screenshot (\`<img src={data.latestScreenshot} />\` when non-null), Summary + Recommendations cards (appear at end).
3. Append a \`<TabsTrigger value="qa_run">QA Run</TabsTrigger>\` and matching \`<TabsContent>\` to \`canvas/src/App.tsx\` using \`edit_file\` — only if App.tsx exists and uses Tabs.

### On every step

Use \`write_file\` to overwrite \`canvas/src/surfaces/QaRun.data.json\` with the updated state after each meaningful change:
- Flip the current flow's \`status\` ("pending" → "running" → "pass"/"fail"/"blocked").
- Append a row to \`steps\`: \`{ "step": N, "action": "...", "ms": 123, "notes": "..." }\`.
- Append any new issues to \`issues\`: \`{ "severity": "blocker"|"major"|"minor"|"nit", "text": "...", "screenshot": "<path or null>" }\`.
- Append any console / network errors to \`errors\`: \`{ "step": N, "kind": "console"|"network", "text": "..." }\`.
- Update \`latestScreenshot\` to the most recent PNG path any time you call \`browser({action:"screenshot"})\`.

Prefer overwriting the whole file with \`write_file\` — it's simpler and avoids edit_file merge risk on structured JSON.

### On end

Update \`QaRun.data.json\` one last time:
- Flip \`status\` to \`"completed"\` / \`"failed"\` / \`"blocked"\`.
- Fill in \`summary\` (2-3 sentences: overall verdict, biggest issue, did all flows complete).
- Fill in \`recommendations\` (ordered list of actionable suggestions).

## Browser Workflow (per flow)
1. \`navigate\` to the URL — record the navigation start/end timestamps.
2. \`snapshot\` the page — record how long until interactive content appears and whether a spinner/skeleton was shown.
3. For each flow in the directive:
   a. Identify the next element from the snapshot (prefer \`ref\`).
   b. Record wall-clock ms for each action (click / fill / select) from dispatch to the follow-up snapshot settling.
   c. Re-snapshot after every state change.
   d. **\`screenshot\` after every navigate and every meaningful state change** so the canvas Latest Screenshot stays fresh.
   e. Check console messages and network activity for errors after each step.
4. After each step, write the updated \`QaRun.data.json\` (when canvas exists). When flows are complete (or blocked), finalize the canvas and save the markdown artifact.

## What to Record Per Step
- URL after the step
- Action taken (navigate / click ref=X / fill ref=Y / etc.)
- Observed duration in ms (dispatch → next stable snapshot)
- Whether a spinner/skeleton/loading indicator appeared
- Visible layout shift, jank, or flicker
- Console errors or warnings emitted during the step
- Network errors (non-2xx responses, timeouts)
- Accessibility issues visible in the snapshot (missing labels, heading order, unlabeled buttons, low-contrast placeholders if noted)

## Markdown Artifact (always saved)

Regardless of whether the canvas exists, always save a final markdown artifact to \`.shogo/reports/qa-<ISO-timestamp>.md\` with these sections:

- **Summary** — 2-3 sentences: overall verdict, biggest issue, did all flows complete.
- **Coverage** — bulleted list of flows attempted and their outcome (pass / fail / blocked).
- **Timing Table** — markdown table with columns: Step | Action | Duration (ms) | Notes. Include p50/max rows if a step was repeated.
- **UX Issues** — one bullet per issue prefixed with severity \`[blocker]\`, \`[major]\`, \`[minor]\`, or \`[nit]\`, referencing screenshot paths when relevant.
- **Console / Network Errors** — raw error lines grouped by step, or "None observed".
- **Recommendations** — prioritized, actionable suggestions for the main agent / developer.

The \`browser\` tool saves screenshots automatically under \`.shogo/screenshots/<run>/step-N.png\` (relative to the workspace) — use the \`path\` field it returns verbatim when you reference a screenshot from the canvas \`latestScreenshot\` field or from the markdown report. Do not construct screenshot paths yourself.

Return a short final response (≤ 10 lines): canvas surface path if built, markdown report path, overall verdict.

## Stopping Rules
- Stop and report if you hit a login wall, captcha, payment wall, or any other blocker you cannot resolve with the provided inputs — record it as a \`[blocker]\` UX issue (in the canvas and in the report).
- Stop and report if the page fails to load after two retries — record network details.
- Stop once every flow in the directive has a pass/fail/blocked outcome. Don't keep exploring beyond the requested scope.`

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
      }
    case 'browser_qa':
      return {
        name: 'browser_qa',
        description: 'Browser-based QA tester — exercises a running app and builds a live QA Run canvas surface as it goes',
        systemPrompt: BROWSER_QA_SUBAGENT_PROMPT,
        toolNames: ['browser', 'web', 'read_file', 'write_file', 'edit_file'],
        disallowedTools: ['task', 'skill'],
        model: 'gpt-5.4-nano',
        provider: 'openai',
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
import {
  selectModelForSpawn,
  escalateModel,
  buildAutoTierMap,
  formatRoutingLog,
  type RoutingDecision,
  type ModelRouterOptions,
  type SpawnClassificationInput,
} from './model-router'
import { inferProviderFromModel } from '@shogo/model-catalog'

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
  /** AgentManager instance id for this run — plumbed into ToolContext.subagentInstanceId
   *  so tools (e.g. `browser`) can key per-instance resources like the CDP screencast. */
  instanceId?: string
  /** AbortSignal for external cancellation. When aborted, the underlying
   *  agent loop stops after the current LLM call / tool execution completes. */
  signal?: AbortSignal
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
    subagentInstanceId: options?.instanceId,
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

    // Build a fresh `browser` tool bound to subCtx so it sees
    // ctx.subagentInstanceId and can publish CDP screencast frames keyed by
    // this run's instance id (see screencast-broadcaster.ts). The parent's
    // browser tool closure captured the parent ctx where subagentInstanceId
    // is always undefined, which would silently disable the screencast.
    // Also isolates the browser/page/cdp state per subagent run.
    const debugScreencast = process.env.DEBUG_SCREENCAST === '1' || process.env.DEBUG_SCREENCAST === 'true'
    if (tools.some(t => t.name === 'browser')) {
      if (debugScreencast) {
        console.log(
          `[screencast] runSubagent rebuilding browser tool instanceId=${options?.instanceId ?? '<none>'} ` +
          `agent=${config.name}`,
        )
      }
      tools = tools.filter(t => t.name !== 'browser')
      tools.push(createBrowserTool(subCtx))
    } else if (debugScreencast) {
      console.log(
        `[screencast] runSubagent no browser tool to rebuild instanceId=${options?.instanceId ?? '<none>'} ` +
        `agent=${config.name}`,
      )
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

  const parentModel = config.model || parentCtx.effectiveModel || parentCtx.config.model.name
  const provider = config.provider || parentCtx.config.model.provider
  const maxIterations = config.maxTurns || (isFork ? 200 : 50)

  // Spawn-time model routing: when Auto mode is active and no explicit
  // model_tier was set by the main agent, use the router to pick the
  // cheapest model capable of handling this sub-agent's task.
  let model: string
  let routingDecision: RoutingDecision | undefined
  let routerOptions: ModelRouterOptions | undefined

  const useAutoRouting = parentCtx.autoRouting && !config.modelTier && !config.model
  if (useAutoRouting) {
    const autoTiers = buildAutoTierMap()
    routerOptions = { ceilingModel: autoTiers.premium, availableModels: autoTiers }
    const classInput: SpawnClassificationInput = {
      prompt,
      subagentType: config.name,
      toolNames: tools.map(t => t.name),
      contextTokens: estimateContextTokens(history, prompt, systemPrompt),
    }
    routingDecision = selectModelForSpawn(classInput, routerOptions)
    model = routingDecision.selectedModel
    console.log(`[Subagent:${config.name}] ${formatRoutingLog(routingDecision, prompt)}`)
    if (parentCtx.uiWriter) {
      parentCtx.uiWriter.write({ type: 'data-routing-decision', data: routingDecision })
    }
  } else {
    model = resolveModelTier(config.modelTier, parentModel)
  }

  try { callbacks?.onModelResolved?.(model) } catch { /* non-fatal */ }

  const runOnce = async (runModel: string): Promise<SubagentResult> => {
    const runProvider = useAutoRouting ? inferProviderFromModel(runModel, provider) : provider
    const result = await runAgentLoop({
      provider: runProvider,
      model: runModel,
      system: systemPrompt,
      history,
      prompt,
      tools,
      maxIterations,
      maxTokens: config.maxTokens,
      thinkingLevel,
      loopDetection: config.loopDetection,
      streamFn: options?.streamFn,
      signal: options?.signal,
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
      effectiveModelId: result.effectiveModelId,
    }
  }

  try {
    let result = await runOnce(model)
    callbacks?.onEnd?.(config.name)

    // Spawn-time fallback: if auto-routed sub-agent produced a bad result
    // (empty response, error text), escalate and retry with a higher tier.
    if (useAutoRouting && routingDecision && routerOptions && isSubagentFailure(result)) {
      const escalated = escalateModel(routingDecision, routerOptions, `subagent_failure:${config.name}`)
      if (escalated) {
        console.log(`[Subagent:${config.name}] [Router] Escalating: ${routingDecision.selectedModel} → ${escalated.selectedModel} (reason: ${escalated.fallbackReason})`)
        if (parentCtx.uiWriter) {
          parentCtx.uiWriter.write({ type: 'data-routing-decision', data: escalated })
        }
        callbacks?.onStart?.(config.name, config.description, agentId)
        result = await runOnce(escalated.selectedModel)
        result.effectiveModelId = escalated.selectedModel
        callbacks?.onEnd?.(config.name)
      }
    }

    return result
  } catch (err: any) {
    // If auto-routed and the cheap model threw, try escalation
    if (useAutoRouting && routingDecision && routerOptions) {
      const escalated = escalateModel(routingDecision, routerOptions, `subagent_error:${err.message?.slice(0, 80)}`)
      if (escalated) {
        console.log(`[Subagent:${config.name}] [Router] Error escalation: ${routingDecision.selectedModel} → ${escalated.selectedModel}`)
        try {
          const retryResult = await runOnce(escalated.selectedModel)
          retryResult.effectiveModelId = escalated.selectedModel
          callbacks?.onEnd?.(config.name)
          return retryResult
        } catch (retryErr: any) {
          console.error(`[Subagent:${config.name}] Escalated retry also failed: ${retryErr.message}`)
        }
      }
    }

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
 * Checks if a sub-agent result looks like a failure (empty or error output).
 */
function isSubagentFailure(result: SubagentResult): boolean {
  if (!result.responseText || result.responseText.trim().length === 0) return true
  if (result.responseText.startsWith('Subagent failed:')) return true
  if (result.iterations === 0 && result.toolCalls === 0) return true
  return false
}

/**
 * Rough token estimate for spawn-time routing decisions.
 */
function estimateContextTokens(history: Message[], prompt: string, systemPrompt: string): number {
  let chars = systemPrompt.length + prompt.length
  for (const m of history) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ('text' in block) chars += (block as any).text.length
      }
    }
  }
  return Math.ceil(chars / 4)
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
