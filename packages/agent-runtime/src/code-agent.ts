// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Code Agent — Claude Code SDK sub-agent for app building mode.
 *
 * When the Pi agent switches to "app" mode, it delegates code editing,
 * project scaffolding, and full-stack app development to Claude Code
 * via the `code_agent` tool. This module manages:
 *
 *   - Claude Code SDK session lifecycle (lazy init, reuse, interrupt)
 *   - Streaming bridge: SDK events → SSE events for SubagentPanel UI
 *   - Model tier passthrough: code agent uses same model as Pi
 *   - Workspace scoping: Claude Code operates in /app/workspace/project/
 */

import { resolve, join, dirname } from 'path'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { Type } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import {
  createSessionManager,
  type ModelTier,
  type V2SessionOptions,
  buildClaudeCodeEnv,
  streamSdkToUI,
} from '@shogo/shared-runtime'
import { textResult } from './gateway-tools'

const LOG_PREFIX = 'code-agent'
const PROJECT_SUBDIR = 'project'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')
const MCP_TEMPLATES_SERVER = resolve(MONOREPO_ROOT, 'packages/project-runtime/src/mcp-templates.ts')

export interface CodeAgentConfig {
  workspaceDir: string
  aiProxy: { url: string; token: string } | null
  /** Current Pi model tier — code agent matches this */
  getModelTier: () => ModelTier
}

let sessionManager: ReturnType<typeof createSessionManager> | null = null
let currentConfig: CodeAgentConfig | null = null

function getProjectDir(workspaceDir: string): string {
  return resolve(workspaceDir, PROJECT_SUBDIR)
}

function ensureProjectDir(workspaceDir: string): string {
  const projectDir = getProjectDir(workspaceDir)
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true })
  }
  return projectDir
}

function buildCodeAgentSessionOptions(
  config: CodeAgentConfig,
  model: ModelTier,
): V2SessionOptions {
  const projectDir = ensureProjectDir(config.workspaceDir)
  const proxyConfig = config.aiProxy
    ? { useProxy: true as const, env: { ANTHROPIC_BASE_URL: config.aiProxy.url.replace(/\/v1$/, '/anthropic'), ANTHROPIC_API_KEY: config.aiProxy.token } }
    : { useProxy: false as const, env: {} as Record<string, string> }
  const claudeCodeEnv = buildClaudeCodeEnv(proxyConfig, {
    RUNTIME_PORT: String(process.env.PORT || '8080'),
  })

  const modelName =
    model === 'haiku' ? 'claude-haiku-4-5'
    : model === 'opus' ? 'claude-opus-4-6'
    : 'claude-sonnet-4-5'

  const mcpEnv: Record<string, string> = {
    PROJECT_DIR: projectDir,
    RUNTIME_PORT: String(process.env.PORT || '8080'),
    NODE_ENV: process.env.NODE_ENV || 'development',
  }

  const mcpServerConfig = {
    command: 'bun',
    args: ['run', MCP_TEMPLATES_SERVER],
    env: mcpEnv,
  }

  // Write .mcp.json so Claude Code discovers template tools via file-based config
  const mcpJsonPath = join(projectDir, '.mcp.json')
  try {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { shogo: mcpServerConfig } }, null, 2), 'utf-8')
  } catch { /* non-fatal */ }

  return {
    model: modelName,
    cwd: projectDir,
    settingSources: ['project', 'local'],
    env: claudeCodeEnv,
    includePartialMessages: true,
    permissionMode: 'default',
    mcpServers: { shogo: mcpServerConfig },
    allowedTools: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
      'Bash',
      'Skill', 'Task', 'TodoWrite',
      'mcp__shogo__template_list',
      'mcp__shogo__template_copy',
    ],
    disallowedTools: ['EnterPlanMode', 'ExitPlanMode', 'SendMessage', 'TeamCreate', 'TeamDelete'],
  }
}

function getSessionManager(config: CodeAgentConfig): ReturnType<typeof createSessionManager> {
  if (sessionManager && currentConfig === config) return sessionManager

  sessionManager = createSessionManager({
    buildSessionOptions: (model) => buildCodeAgentSessionOptions(config, model),
    defaultModel: config.getModelTier(),
    logPrefix: LOG_PREFIX,
  })
  currentConfig = config
  return sessionManager
}

/**
 * Execute a task via the Claude Code sub-agent.
 * Streams progress events to the UI writer if provided.
 */
export async function executeCodeAgentTask(
  config: CodeAgentConfig,
  task: string,
  uiWriter?: { write(chunk: Record<string, any>): void },
  abortSignal?: AbortSignal,
): Promise<{ summary: string; filesChanged: string[] }> {
  const sm = getSessionManager(config)
  const modelTier = config.getModelTier()
  const session = sm.getOrCreate(modelTier)
  const projectDir = ensureProjectDir(config.workspaceDir)

  // Always overwrite CLAUDE.md so instructions are fresh for each task
  const claudeMdPath = join(projectDir, 'CLAUDE.md')
  writeFileSync(claudeMdPath, [
    '# Project Instructions',
    '',
    'You are a code agent inside Shogo. Your workspace is this directory.',
    '',
    '## MANDATORY: Use Templates for Scaffolding',
    '',
    'You have MCP tools: `mcp__shogo__template_list` and `mcp__shogo__template_copy`.',
    '',
    '**Required workflow for any new app/project:**',
    '1. Call `mcp__shogo__template_list` to check for a matching starter template',
    '2. If a match exists, call `mcp__shogo__template_copy` with the template name',
    '3. The template handles EVERYTHING: file copy, bun install, prisma setup, build',
    '4. After template_copy, only make customizations the user asked for',
    '',
    'DO NOT use npm create, npx create-vite, or manually scaffold when a template exists.',
    'DO NOT run bun install, prisma generate, or vite build — template_copy does this.',
    '',
    'Templates: todo-app, expense-tracker, crm, inventory, kanban, ai-chat, form-builder, feedback-form, booking-app.',
    '',
    '## Environment',
    '',
    'The Vite dev server runs automatically — changes are live-previewed.',
    'Do NOT run vite dev, vite build, bun run dev, or bun run build.',
  ].join('\n'), 'utf-8')

  const taskWithTemplateHint = [
    'MANDATORY FIRST STEP: Run mcp__shogo__template_list to check for starter templates.',
    'If a template matches, you MUST use mcp__shogo__template_copy to scaffold the project.',
    'Do NOT manually create files or run npm/vite/create commands if a template exists.',
    '',
    task,
  ].join('\n')

  console.log(`[${LOG_PREFIX}] Executing task (model=${modelTier}): ${task.substring(0, 200)}`)

  // The V2 SDK does not forward cwd to the CLI subprocess — it inherits process.cwd().
  // chdir so the CLI reads .mcp.json and CLAUDE.md from the project directory.
  const origCwd = process.cwd()
  try { process.chdir(projectDir) } catch {}

  // The V2 SDK does not forward mcpServers to the CLI subprocess.
  // This workaround accesses the internal query object to register them.
  await sm.ensureMcpServers(modelTier)

  sm.markActive(modelTier)
  const subagentId = `code-agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  if (uiWriter) {
    uiWriter.write({
      type: 'data-subagent-start',
      data: { id: subagentId, name: 'Code Agent', task: task.substring(0, 200) },
    })
  }

  let collectedText = ''
  const filesChanged = new Set<string>()

  const collectorWriter: import('@shogo/shared-runtime').UIMessageStreamWriter = {
    write(chunk: Record<string, any>) {
      if (uiWriter) {
        // Pass standard SDK events through without extra keys (strict schema validation)
        uiWriter.write(chunk)
      }
      if (chunk.type === 'text-delta' && chunk.delta) {
        collectedText += chunk.delta
      }
      if (chunk.type === 'tool-input-available') {
        const toolName = chunk.toolName as string
        if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
          const input = chunk.input as Record<string, any> | undefined
          const filePath = input?.file_path || input?.filePath
          if (filePath) filesChanged.add(filePath)
        }
      }
    },
  }

  try {
    await session.send(taskWithTemplateHint)

    await streamSdkToUI(session, collectorWriter, {
      onQueryCreated: (query) => sm.setActiveQuery(modelTier, query),
      logPrefix: LOG_PREFIX,
    })

    sm.deleteActiveQuery(modelTier)
    sm.markInactive(modelTier)

    const summary = collectedText.length > 2000
      ? collectedText.substring(0, 2000) + '\n\n[...truncated]'
      : collectedText
    const changedFiles = Array.from(filesChanged)

    if (uiWriter) {
      uiWriter.write({
        type: 'data-subagent-end',
        data: { id: subagentId, summary: summary.substring(0, 500) },
      })
    }

    console.log(`[${LOG_PREFIX}] Task completed (${changedFiles.length} files changed)`)
    return { summary, filesChanged: changedFiles }
  } catch (err: any) {
    sm.deleteActiveQuery(modelTier)
    sm.markInactive(modelTier)

    if (uiWriter) {
      uiWriter.write({
        type: 'data-subagent-error',
        data: { id: subagentId, error: err.message },
      })
    }

    console.error(`[${LOG_PREFIX}] Task failed:`, err.message)
    throw err
  } finally {
    try { process.chdir(origCwd) } catch {}
  }
}

/**
 * Interrupt the current code agent task.
 */
export async function interruptCodeAgent(config: CodeAgentConfig): Promise<void> {
  const modelTier = config.getModelTier()
  if (sessionManager) {
    await sessionManager.interrupt(modelTier)
  }
}

/**
 * Create the `code_agent` tool for use in the Pi agent's tool set.
 */
export function createCodeAgentTool(config: CodeAgentConfig): AgentTool {
  return {
    name: 'code_agent',
    description:
      'Delegate a coding task to the Claude Code sub-agent. Use this in "app" mode for ALL code creation, modification, and debugging. The sub-agent has full filesystem access to the project/ directory, can use template_list and template_copy to scaffold projects, install dependencies, run tests, and build apps. NEVER write application code yourself — always delegate to this tool.',
    label: 'Code Agent',
    parameters: Type.Object({
      task: Type.String({
        description: 'Detailed description of what to build, fix, or change. Be specific about the desired outcome, technologies, and behavior. The code agent will handle scaffolding, templates, file creation, and implementation.',
      }),
    }),
    execute: async (_id, params, context) => {
      const { task } = params as { task: string }
      try {
        const result = await executeCodeAgentTask(
          config,
          task,
          (context as any)?.uiWriter,
          (context as any)?.abortSignal,
        )
        return textResult({
          success: true,
          summary: result.summary,
          filesChanged: result.filesChanged,
        })
      } catch (err: any) {
        return textResult({
          success: false,
          error: err.message,
        })
      }
    },
  }
}
