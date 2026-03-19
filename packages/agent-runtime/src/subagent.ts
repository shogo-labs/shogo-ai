// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Subagent System
 *
 * Spawns isolated Pi agent sub-loops for focused tasks. Each subagent gets
 * its own context window, restricted tools, and optional model override.
 * Subagents cannot spawn further subagents (no infinite nesting).
 *
 * Built-in types: code_agent, canvas_agent, explore, general-purpose.
 * Custom types loaded from .claude/agents/<name>.md at startup.
 */

import { existsSync, readdirSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { runAgentLoop, type AgentLoopResult, type LoopDetectorConfig } from './agent-loop'
import type { ToolContext } from './gateway-tools'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentConfig {
  name: string
  description: string
  systemPrompt: string
  /** Tool names to include. If empty/undefined, inherit all (minus task). */
  toolNames?: string[]
  /** Tool names to explicitly exclude. */
  disallowedTools?: string[]
  model?: string
  provider?: string
  maxTurns?: number
  /** Override working directory for file tools (scoping). */
  workingDir?: string
  /** Max output tokens per LLM call (default: 4096 from agent-loop). */
  maxTokens?: number
  /** Override loop detector config. Pass false to disable. */
  loopDetection?: Partial<LoopDetectorConfig> | false
}

export interface SubagentResult {
  text: string
  toolCalls: number
  iterations: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SubagentStreamCallbacks {
  onStart?: (name: string, description: string) => void
  onEnd?: (name: string, summary: string) => void
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

import { CODE_AGENT_CODING_GUIDE, CODE_AGENT_ENVIRONMENT_GUIDE } from './code-agent-prompt'

export const CODE_AGENT_SYSTEM_PROMPT = `You are code_agent — a coding subagent that builds applications, writes scripts, and executes commands.

## Your Scope
You work within the project/ directory for app code. You can also write and run scripts, install packages, and execute commands. All file operations are relative to the project directory.

## Available Tools
You have: edit_file, glob, grep, ls, read_file, write_file, exec, todo_write, web, search_files, template_list, template_copy.

${CODE_AGENT_ENVIRONMENT_GUIDE}

${CODE_AGENT_CODING_GUIDE}`

import { BASIC_CANVAS_TOOLS_GUIDE, BASIC_CANVAS_EXAMPLES } from './canvas-prompt'

export const CANVAS_AGENT_SYSTEM_PROMPT = `You are canvas_agent — a focused subagent for building view-only displays with canvas components that can show live integration data.

## Your Scope
You build agent dashboards and displays using canvas_* tools. Canvas components are declarative and view-only — you describe what to show, and the UI renders it. No interactive components (Button, TextField, Select, Checkbox) are available, but you CAN bind live data from integrations using canvas_api_bind and auto-refresh metrics with canvas_api_hooks.

## Available Tools
canvas_create, canvas_update, canvas_data, canvas_data_patch, canvas_delete, canvas_components, canvas_inspect, canvas_api_schema, canvas_api_seed, canvas_api_query, canvas_api_hooks, canvas_api_bind, read_file.

${BASIC_CANVAS_TOOLS_GUIDE}

${BASIC_CANVAS_EXAMPLES}

## Final Reminder
- Return a summary of what you built and what data sources are bound.
- Canvas is view-only for user interaction, but supports live data binding from integrations via canvas_api_bind.
- If the user needs interactive elements (forms, buttons), suggest switching to app mode.`

export const EXPLORE_SYSTEM_PROMPT = `You are an exploration subagent. Search and analyze the codebase efficiently.

## Your Scope
Read-only codebase exploration. Find files, search for patterns, read code, and return specific findings with file references.

## Available Tools
read_file, glob, grep, ls — all read-only.

## Guidelines
- Use glob to find files by pattern first.
- Use grep to search for specific patterns, symbols, or strings.
- Use ls to understand directory structure.
- Read files to understand implementation details.
- Be thorough but concise in your findings.
- Always include specific file paths and line references.
- Return a structured summary of what you found.`

export const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose subagent. Complete the given task using all available tools.

## Guidelines
- Plan your approach before acting.
- Use the most appropriate tool for each step.
- Be thorough but efficient.
- Return a clear summary of what you did and the results.`

export function getBuiltinSubagentConfig(
  name: string,
  ctx: ToolContext,
  allTools: AgentTool[],
): SubagentConfig | null {
  switch (name) {
    case 'code_agent': {
      let dynamicContext = ''
      const templatePath = join(ctx.workspaceDir, '.app-template')
      const hasTemplate = existsSync(templatePath)
      if (hasTemplate) {
        const template = readFileSync(templatePath, 'utf-8').trim()
        const humanName = template.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        dynamicContext += `\n\n## Project Template: ${humanName}\nThis project was scaffolded from the \`${template}\` template. Check existing files in \`src/\` before creating new ones.\n`
      } else {
        dynamicContext += `\n\n## ⚠️ NO TEMPLATE SELECTED — MANDATORY FIRST STEP

**No app template has been set up yet.** You MUST scaffold from a template before writing ANY code.

1. Call \`template_list\` to see available templates
2. Pick the best match for the task (or \`_template\` for a blank starter)
3. Call \`template_copy({ template: "<name>", name: "<app-name>" })\`
4. THEN read the scaffolded files and make customizations

**NEVER create files from scratch.** NEVER run \`npm create\`, \`npx create-vite\`, \`bun create\`, or manually scaffold a project. A template handles everything: file structure, dependencies, prisma setup, build config, and preview server restart.\n`
      }
      const projectDir = join(ctx.workspaceDir, 'project')
      if (existsSync(projectDir)) {
        try {
          const entries = readdirSync(projectDir).filter(e => !e.startsWith('.') && e !== 'node_modules').slice(0, 25)
          if (entries.length > 0) {
            dynamicContext += `\n## Project Structure (top-level)\n\`\`\`\n${entries.join('\n')}\n\`\`\`\n`
          }
        } catch { /* non-fatal */ }
      }
      return {
        name: 'code_agent',
        description: 'Coding subagent that builds apps, writes scripts, and executes commands in project/',
        systemPrompt: CODE_AGENT_SYSTEM_PROMPT + dynamicContext,
        toolNames: [
          'edit_file', 'glob', 'grep', 'ls', 'read_file', 'write_file', 'exec',
          'todo_write', 'web', 'search_files',
          'template_list', 'template_copy',
        ],
        disallowedTools: ['task', 'skill', 'code_agent'],
        workingDir: projectDir,
        maxTurns: 30,
        maxTokens: 16384,
        loopDetection: { maxIdenticalCalls: 5 },
      }
    }
    case 'canvas_agent':
      return {
        name: 'canvas_agent',
        description: 'Declarative UI subagent for building canvas dashboards and displays',
        systemPrompt: CANVAS_AGENT_SYSTEM_PROMPT,
        toolNames: [
          'canvas_create', 'canvas_update', 'canvas_data', 'canvas_data_patch',
          'canvas_delete', 'canvas_components', 'canvas_inspect',
          'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query',
          'canvas_api_hooks', 'canvas_api_bind', 'read_file',
        ],
        disallowedTools: ['task', 'skill', 'code_agent'],
        maxTurns: 30,
        maxTokens: 16384,
      }
    case 'explore':
      return {
        name: 'explore',
        description: 'Fast read-only codebase exploration agent',
        systemPrompt: EXPLORE_SYSTEM_PROMPT,
        toolNames: ['read_file', 'glob', 'grep', 'ls'],
        disallowedTools: ['task', 'skill', 'code_agent'],
        model: 'claude-haiku-4-5',
        maxTurns: 5,
      }
    case 'general-purpose':
      return {
        name: 'general-purpose',
        description: 'Full-capability subagent for complex multi-step tasks',
        systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
        disallowedTools: ['task', 'skill', 'code_agent'],
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Custom Subagent Loader (.claude/agents/<name>.md)
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
  const agentsDir = join(workspaceDir, '.claude', 'agents')
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
// Subagent Execution
// ---------------------------------------------------------------------------

export async function runSubagent(
  config: SubagentConfig,
  prompt: string,
  parentCtx: ToolContext,
  allParentTools: AgentTool[],
  callbacks?: SubagentStreamCallbacks,
): Promise<SubagentResult> {
  callbacks?.onStart?.(config.name, config.description)

  const subCtx: ToolContext = {
    ...parentCtx,
    workspaceDir: config.workingDir || parentCtx.workspaceDir,
  }

  // Ensure working directory exists
  if (config.workingDir && !existsSync(config.workingDir)) {
    mkdirSync(config.workingDir, { recursive: true })
  }

  // Build tool set: filter from parent tools based on config
  let tools: AgentTool[]
  if (config.toolNames && config.toolNames.length > 0) {
    const allowSet = new Set(config.toolNames)
    tools = allParentTools.filter(t => allowSet.has(t.name))
  } else {
    tools = [...allParentTools]
  }

  // Always strip task/skill/code_agent from subagent tools to prevent nesting
  const disallowed = new Set([
    ...(config.disallowedTools || []),
    'task', 'code_agent',
  ])
  tools = tools.filter(t => !disallowed.has(t.name))

  const model = config.model || parentCtx.config.model.name
  const provider = config.provider || parentCtx.config.model.provider
  const maxIterations = config.maxTurns || 10

  try {
    const result = await runAgentLoop({
      provider,
      model,
      system: config.systemPrompt,
      history: [],
      prompt,
      tools,
      maxIterations,
      maxTokens: config.maxTokens,
      thinkingLevel: 'medium',
      loopDetection: config.loopDetection,
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

    const summary = result.text || '(no text output)'
    callbacks?.onEnd?.(config.name, summary)

    return {
      text: summary,
      toolCalls: result.toolCalls.length,
      iterations: result.iterations,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    }
  } catch (err: any) {
    const errorMsg = `Subagent ${config.name} failed: ${err.message}`
    callbacks?.onEnd?.(config.name, errorMsg)
    return {
      text: errorMsg,
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  }
}
