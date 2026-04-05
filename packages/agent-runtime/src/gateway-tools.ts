// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gateway Tools
 *
 * Tool definitions available to the live gateway agent during agent turns.
 * Uses Pi Agent Core's AgentTool format with TypeBox parameter schemas.
 *
 * Tools are created via createGatewayTools(ctx) which closes over the
 * ToolContext, since Pi's execute() signature doesn't accept external context.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, statSync, copyFileSync } from 'fs'
import { join, resolve, extname, dirname } from 'path'
import { execSync } from 'child_process'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { sandboxExec } from './sandbox-exec'
import {
  runSubagent,
  getBuiltinSubagentConfig,
  loadCustomAgents,
  type SubagentConfig,
  type SubagentResult,
  type SubagentStreamCallbacks,
  type CustomAgentDef,
} from './subagent'
import {
  findActualString, preserveQuoteStyle, stripTrailingWhitespace,
  applyEditToFile, readFileWithMetadata, writeWithMetadata, getStructuredPatch,
  type LineEndingType,
} from './edit-file-utils'
import { MemorySearchEngine } from './memory-search'
import { IndexEngine, createDefaultConfig } from './index-engine'
import { MCP_CATALOG, isPreinstalledMcpId, isMcpServerAllowed, getPreinstalledPackages } from './mcp-catalog'
import { initComposioSession, isComposioEnabled, isComposioInitialized, searchComposioToolkits, findComposioToolkit, registerToolkitProxyTools, checkComposioAuth } from './composio'
import { loadAllSkills, loadBundledSkills, searchSkills } from './skills'
import { withPermissionGate, assertWithinWorkspace as assertWithinWorkspaceSecure, type PermissionEngine } from './permission-engine'
import { deriveApiUrl, derivePublicApiUrl } from './internal-api'
import { getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'
import { FileStateCache } from './file-state-cache'
import { resolveRgPath } from './rg-resolve'
import type { TeamManager } from './team-manager'
import type { TeammateLoopHandle } from './teammate-loop'

export interface ToolContext {
  workspaceDir: string
  channels: Map<string, import('./types').ChannelAdapter>
  config: import('./gateway').GatewayConfig
  projectId: string
  sessionId?: string
  sandbox?: Partial<import('./types').SandboxConfig>
  mainSessionIds?: string[]
  mcpClientManager?: import('./mcp-client').MCPClientManager
  /** Hot-connect a channel at runtime (called by channel_connect tool) */
  connectChannel?: (type: string, config: Record<string, string>) => Promise<void>
  disconnectChannel?: (type: string) => Promise<void>
  /** Unified index engine for search over workspace code and user files */
  indexEngine?: IndexEngine
  /** Workspace knowledge graph for structural analysis and blast radius */
  workspaceGraph?: import('./workspace-graph').WorkspaceGraph
  /** Authenticated user ID from the chat request (for per-user integrations like Composio) */
  userId?: string
  /** File watcher — notified when src/ files are written/edited/deleted to trigger rebuilds */
  canvasFileWatcher?: import('./canvas-file-watcher').CanvasFileWatcher
  /** Permission engine for local-mode security guardrails */
  permissionEngine?: PermissionEngine
  /** AI Proxy URL for image generation and other proxy-routed calls */
  aiProxyUrl?: string
  /** AI Proxy token for authenticating proxy calls */
  aiProxyToken?: string
  /** UI message writer for streaming events to the client (set during agent turns, not heartbeats) */
  uiWriter?: any
  /** Sync heartbeat config to the central DB (called by heartbeat_configure tool) */
  updateHeartbeatConfig?: (config: {
    heartbeatEnabled?: boolean
    heartbeatInterval?: number
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
    quietHoursTimezone?: string | null
  }) => Promise<void>
  /** Multi-language LSP manager for read_lints diagnostics */
  lspManager?: import('@shogo/shared-runtime').WorkspaceLSPManager
  /** Tracks which files the agent has read, their mtimes, and line counts */
  fileStateCache?: FileStateCache
  /** Dynamic sub-agent registry and lifecycle manager */
  agentManager?: import('./agent-manager').AgentManager
  /** Skill server manager — exposed so tools can sync/query the skill server */
  skillServerManager?: import('./skill-server-manager').SkillServerManager
  /** Parent's fully rendered system prompt (for fork mode context sharing) */
  renderedSystemPrompt?: string
  /** Parent's current conversation history (for fork mode context sharing) */
  sessionMessages?: import('@mariozechner/pi-ai').Message[]
  /** Session persistence layer (for subagent transcript storage) */
  sessionPersistence?: import('./sqlite-session-persistence').SqliteSessionPersistence
  /** Team coordination manager (for teammate swarm features) */
  teamManager?: TeamManager
  /** Current team context (set when agent is part of a team) */
  teamContext?: { teamId: string; agentId: string; isLeader: boolean }
  /** Active teammate loop handles (for lifecycle management) */
  teammateHandles?: Map<string, TeammateLoopHandle>
  /** Effective model ID for this turn (accounts for session modelOverride + alias resolution) */
  effectiveModel?: string
}

// Legacy blocked-command check kept as lightweight fallback for contexts
// without a PermissionEngine (e.g. heartbeat tools in cloud mode).
// The PermissionEngine's HARD_BLOCKED_COMMAND_PATTERNS is the authoritative
// version and supersedes this when available.
const BLOCKED_COMMANDS: string[] = [ 'sudo', 'rm -rf *' ]

function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return BLOCKED_COMMANDS.some((pattern: string) => {
    if (pattern.includes('.*')) {
      try {
        return new RegExp(pattern, 'i').test(command)
      } catch {
        return false
      }
    }
    return lower.includes(pattern.toLowerCase())
  })
}

function assertWithinWorkspace(workspaceDir: string, filePath: string): string {
  return assertWithinWorkspaceSecure(workspaceDir, filePath)
}

function applyPermissionGate(
  tool: AgentTool,
  category: import('./types').PermissionCategory,
  engine?: PermissionEngine,
): AgentTool {
  return engine ? withPermissionGate(tool, category, engine) : tool
}

export function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    details: data,
  }
}

const MAX_EXEC_OUTPUT_CHARS = 16000

function truncateExecOutput(text: string): string {
  if (!text || text.length <= MAX_EXEC_OUTPUT_CHARS) return text
  const headSize = Math.floor(MAX_EXEC_OUTPUT_CHARS * 0.75)
  const tailSize = MAX_EXEC_OUTPUT_CHARS - headSize
  const head = text.substring(0, headSize)
  const tail = text.substring(text.length - tailSize)
  return `${head}\n\n... [${text.length - MAX_EXEC_OUTPUT_CHARS} chars truncated — use head/tail/grep for more targeted output] ...\n\n${tail}`
}

// ---------------------------------------------------------------------------
// Tool Definitions (created via factory)
// ---------------------------------------------------------------------------

function createExecTool(ctx: ToolContext): AgentTool {
  return {
    name: 'exec',
    description:
      'Run a shell command in the agent workspace. Destructive commands are blocked. ' +
      'Quote file paths containing spaces. Use && to chain dependent commands, ; for independent ones. ' +
      'Never use interactive flags (-i). Prefer read_file over cat/head/tail, and grep tool over exec("grep ..."). ' +
      'Pre-installed CLIs: gh (GitHub), glab (GitLab), aws, stripe, oci. ' +
      'Tokens saved to .env are auto-loaded into exec commands.',
    label: 'Execute Command',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 300000)' })),
    }),
    execute: async (toolCallId, params) => {
      const { command, timeout = 300_000 } = params as { command: string; timeout?: number }

      if (isBlockedCommand(command)) {
        return textResult({ error: `Blocked command: ${command}` })
      }

      const startTime = Date.now()
      const result = sandboxExec({
        command,
        workspaceDir: ctx.workspaceDir,
        timeout,
        sandboxConfig: ctx.sandbox,
        sessionId: ctx.sessionId,
        mainSessionIds: ctx.mainSessionIds,
      })
      const durationMs = Date.now() - startTime

      return textResult({
        stdout: truncateExecOutput(result.stdout),
        stderr: result.stderr ? truncateExecOutput(result.stderr) : undefined,
        exitCode: result.exitCode,
        durationMs,
        sandboxed: result.sandboxed || undefined,
      })
    },
  }
}

function createReadFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_file',
    description:
      'Read a file from the agent workspace. Supports partial reads via offset and limit ' +
      'to handle large files without consuming the full context window. ' +
      'When using offset/limit, output includes line numbers in N|content format. ' +
      'For large files (500+ lines), prefer offset/limit or use grep to find specific sections.',
    label: 'Read File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      offset: Type.Optional(Type.Union([
        Type.Number({ description: 'Line number to start reading from (1-based)' }),
        Type.Array(Type.Number(), { description: 'Tuple [start, end] line range' }),
      ])),
      limit: Type.Optional(Type.Number({ description: 'Number of lines to read' })),
    }),
    execute: async (_toolCallId, params) => {
      let { path: filePath, offset, limit } = params as {
        path: string; offset?: number | number[]; limit?: number
      }
      if (Array.isArray(offset)) {
        const sorted = [...offset].sort((a, b) => a - b)
        if (!limit) limit = sorted[sorted.length - 1] - sorted[0]
        offset = sorted[0]
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      if (!existsSync(resolved)) {
        return textResult({ error: `File not found: ${filePath}` })
      }
      try {
        const stat = statSync(resolved)
        if (stat.isDirectory()) {
          const entries = lsDir(resolved, ctx.workspaceDir, false, 0, 1)
          return textResult({
            note: `"${filePath}" is a directory, not a file. Listing its contents instead. Use ls for directories.`,
            path: filePath,
            entries,
            count: entries.length,
          })
        }
      } catch { /* proceed to read */ }
      const fullContent = readFileSync(resolved, 'utf-8')

      const totalLineCount = fullContent.split('\n').length
      const mtime = statSync(resolved).mtimeMs

      if (offset !== undefined || limit !== undefined) {
        const lines = fullContent.split('\n')
        const startLine = Math.max(0, ((offset as number) ?? 1) - 1)
        const endLine = limit !== undefined ? startLine + limit : lines.length
        const sliced = lines.slice(startLine, endLine)
        const numberedLines = sliced.map((line, i) => `${startLine + i + 1}|${line}`)
        ctx.fileStateCache?.recordRead(filePath, mtime, totalLineCount, {
          offset: startLine + 1,
          limit: Math.min(endLine, lines.length) - startLine,
        }, undefined)
        return textResult({
          content: numberedLines.join('\n'),
          totalLines: lines.length,
          startLine: startLine + 1,
          endLine: Math.min(endLine, lines.length),
        })
      }

      ctx.fileStateCache?.recordRead(filePath, mtime, totalLineCount, undefined, fullContent)
      const result: Record<string, any> = { content: fullContent, bytes: fullContent.length }
      if (totalLineCount > 500) {
        result.totalLines = totalLineCount
        result.note = `Large file (${totalLineCount} lines). Use offset/limit to read specific sections, or grep to find the code you need. Reading the whole file wastes context.`
      }
      return textResult(result)
    },
  }
}

/**
 * If the workspace graph is available, append a brief impact note to the
 * tool result indicating how many files reference the changed file.
 */
function appendImpactHint(ctx: ToolContext, filePath: string, result: Record<string, unknown>): void {
  try {
    const graph = ctx.workspaceGraph
    if (!graph) return

    const impact = graph.getImpactRadius([filePath], 1, 20)
    if (impact.impactedFiles.length > 0) {
      result.impact_note = `This file is referenced by ${impact.impactedFiles.length} other file(s): ${
        impact.impactedFiles.slice(0, 5).join(', ')
      }${impact.impactedFiles.length > 5 ? ` and ${impact.impactedFiles.length - 5} more` : ''}. ` +
        'Use impact_radius for full analysis.'
    }
  } catch { /* best-effort — do not fail the write */ }
}

function createWriteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'write_file',
    description: 'Create a NEW file in the agent workspace. Creates parent directories as needed. ' +
      'WARNING: Do NOT use write_file to modify existing files — use edit_file instead. ' +
      'write_file overwrites the entire file which risks losing code. Only use for creating brand-new files.',
    label: 'Write File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      content: Type.String({ description: 'Content to write' }),
      append: Type.Optional(Type.Boolean({ description: 'Append instead of overwrite (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, content, append } = params as {
        path: string
        content: string
        append?: boolean
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      const dir = dirname(resolved)
      if (dir && dir !== resolved) mkdirSync(dir, { recursive: true })

      if (append) {
        const existing = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
        writeFileSync(resolved, existing + content, 'utf-8')
      } else {
        writeFileSync(resolved, content, 'utf-8')
      }
      ctx.fileStateCache?.invalidate(filePath)
      ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)

      if (ctx.lspManager && /\.(ts|tsx|js|jsx|py)$/.test(filePath)) {
        const finalContent = append
          ? (existsSync(resolved) ? readFileSync(resolved, 'utf-8') : content)
          : content
        ctx.lspManager.notifyFileChanged(resolved, finalContent)
      }

      const base: Record<string, unknown> = { ok: true, path: filePath, bytes: content.length }
      appendImpactHint(ctx, filePath, base)
      const schemaResult = await maybeSchemaSync(ctx, filePath, resolved, base)
      return textResult(schemaResult ?? base)
    },
  }
}

/**
 * If the file is .shogo/server/schema.prisma, sync the skill server and
 * return an enriched result.  Otherwise returns null (caller uses default).
 */
/**
 * Scan canvas/src files for fetch('/api/...') calls that don't match any
 * active server route. Returns per-file orphaned route info.
 */
function findOrphanedFetches(
  workspaceDir: string,
  activeRoutes: string[],
): { route: string; file: string }[] {
  const routeSet = new Set(activeRoutes.map(r => r.toLowerCase()))
  const fetchPattern = /fetch\(\s*[`"'](?:https?:\/\/localhost:\d+)?\/api\/([^`"'/\s?]+)/g
  const orphaned: { route: string; file: string }[] = []

  const scanDir = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'generated' && entry.name !== '.shogo') {
          scanDir(full)
        } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
          try {
            const content = readFileSync(full, 'utf-8')
            for (const m of content.matchAll(fetchPattern)) {
              if (!routeSet.has(m[1].toLowerCase())) {
                const relPath = full.startsWith(workspaceDir)
                  ? full.slice(workspaceDir.length + 1)
                  : full
                orphaned.push({ route: `/api/${m[1]}`, file: relPath })
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  scanDir(join(workspaceDir, 'src'))
  const canvasDir = join(workspaceDir, 'canvas')
  if (existsSync(canvasDir)) scanDir(canvasDir)

  return orphaned
}

async function maybeSchemaSync(
  ctx: ToolContext,
  filePath: string,
  resolved: string,
  baseResult: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!ctx.skillServerManager) return null

  const customRoutesResult = await maybeCustomRoutesSync(ctx, filePath, resolved, baseResult)
  if (customRoutesResult) return customRoutesResult

  const isSchemaWrite = filePath === '.shogo/server/schema.prisma' ||
    resolved.endsWith('.shogo/server/schema.prisma')
  if (!isSchemaWrite) return null

  const content = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
  if (!/^model\s+\w+/m.test(content)) return null

  try {
    const syncResult = await ctx.skillServerManager.sync()
    const routes = ctx.skillServerManager.getActiveRoutes()
    const activeRoutePaths = routes.map(r => `/api/${r}`)

    const orphaned = findOrphanedFetches(ctx.workspaceDir, routes)

    const result: Record<string, unknown> = {
      ...baseResult,
      skillServer: {
        synced: syncResult.ok,
        phase: syncResult.phase,
        activeRoutes: activeRoutePaths,
        ...(syncResult.error ? { error: syncResult.error } : {}),
      },
    }

    if (orphaned.length > 0) {
      const unique = [...new Map(orphaned.map(o => [`${o.route}::${o.file}`, o])).values()]
      ;(result.skillServer as Record<string, unknown>).orphanedFetches = unique
      ;(result.skillServer as Record<string, unknown>).warning =
        `Your schema is missing models for ${new Set(unique.map(o => o.route)).size} route(s) that your UI code fetches. ` +
        `These fetch calls will fail at runtime. Either add the missing models to the schema or remove the fetch calls.`
    }

    return result
  } catch (err: any) {
    return {
      ...baseResult,
      skillServer: {
        synced: false,
        error: err.message,
        hint: 'Schema saved but regeneration failed. Check the schema for errors.',
      },
    }
  }
}

async function maybeCustomRoutesSync(
  ctx: ToolContext,
  filePath: string,
  _resolved: string,
  baseResult: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const isCustomRoutesWrite =
    /\.shogo\/server\/custom-routes\.tsx?$/.test(filePath)
  if (!isCustomRoutesWrite || !ctx.skillServerManager) return null

  try {
    await ctx.skillServerManager.restart()
    return {
      ...baseResult,
      skillServer: {
        customRoutesMounted: true,
        phase: ctx.skillServerManager.phase,
        url: ctx.skillServerManager.url,
        hint: 'Custom routes are now live. They are mounted at /api/ alongside CRUD routes.',
      },
    }
  } catch (err: any) {
    return {
      ...baseResult,
      skillServer: {
        customRoutesMounted: false,
        error: err.message,
        hint: 'Custom routes file saved but server restart failed.',
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Skill Server Sync Tool
// ---------------------------------------------------------------------------

function createSkillServerSyncTool(ctx: ToolContext): AgentTool {
  return {
    name: 'skill_server_sync',
    description:
      'Force the skill server to regenerate routes from schema.prisma and restart. ' +
      'Use this when routes are returning 404 after a schema change, or to verify the server is healthy. ' +
      'Returns the current phase and list of active API routes.',
    label: 'Skill Server Sync',
    parameters: Type.Object({}),
    execute: async () => {
      if (!ctx.skillServerManager) {
        return textResult({ ok: false, error: 'Skill server manager not available' })
      }

      try {
        const result = await ctx.skillServerManager.sync()
        const routes = ctx.skillServerManager.getActiveRoutes()
        const models = ctx.skillServerManager.getSchemaModels()
        return textResult({
          ok: result.ok,
          phase: result.phase,
          activeRoutes: routes.map(r => `/api/${r}`),
          schemaModels: models,
          url: ctx.skillServerManager.url,
        })
      } catch (err: any) {
        return textResult({
          ok: false,
          error: err.message,
          phase: ctx.skillServerManager.phase,
        })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Edit File Tool (search_replace)
// ---------------------------------------------------------------------------

function fuzzyFindInContent(content: string, needle: string): { index: number; match: string } | null {
  // 1. Try exact match first
  const exactIdx = content.indexOf(needle)
  if (exactIdx !== -1) return { index: exactIdx, match: needle }

  // 2. Try unescaping JSON-escaped quotes (model sometimes emits \\\" instead of ")
  const unescaped = needle.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  if (unescaped !== needle) {
    const unescIdx = content.indexOf(unescaped)
    if (unescIdx !== -1) return { index: unescIdx, match: unescaped }
  }

  // 3. Try normalizing line endings (\r\n vs \n)
  const normalizedNeedle = needle.replace(/\r\n/g, '\n')
  const normalizedContent = content.replace(/\r\n/g, '\n')
  const normIdx = normalizedContent.indexOf(normalizedNeedle)
  if (normIdx !== -1) {
    const lines = needle.split('\n')
    let rebuilt = ''
    let pos = normIdx
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length
      rebuilt += content.substring(pos, pos + lineLen)
      pos += lineLen
      if (i < lines.length - 1) {
        if (content[pos] === '\r' && content[pos + 1] === '\n') { rebuilt += '\r\n'; pos += 2 }
        else if (content[pos] === '\n') { rebuilt += '\n'; pos += 1 }
      }
    }
    if (content.includes(rebuilt)) return { index: content.indexOf(rebuilt), match: rebuilt }
    return { index: normIdx, match: normalizedNeedle }
  }

  // 4. Try stripping trailing whitespace per line
  const stripTrailing = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n')
  const strippedNeedle = stripTrailing(normalizedNeedle)
  const strippedContent = stripTrailing(normalizedContent)
  const stripIdx = strippedContent.indexOf(strippedNeedle)
  if (stripIdx !== -1) {
    const contentLines = content.split('\n')
    const needleLineCount = needle.split('\n').length
    const strippedLines = strippedContent.substring(0, stripIdx).split('\n')
    const startLineIdx = strippedLines.length - 1
    const startPos = content.split('\n').slice(0, startLineIdx).join('\n').length + (startLineIdx > 0 ? 1 : 0)
    const matchStr = contentLines.slice(startLineIdx, startLineIdx + needleLineCount).join('\n')
    return { index: startPos, match: matchStr }
  }

  // 5. Try whitespace-flexible matching (collapse runs of whitespace, trim lines)
  const collapseWS = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n')
  const collapsedNeedle = collapseWS(needle)
  const collapsedContent = collapseWS(content)
  const wsIdx = collapsedContent.indexOf(collapsedNeedle)
  if (wsIdx !== -1) {
    const needleLines = needle.split('\n').map(l => l.trim())
    const contentLines = content.split('\n')
    for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
      let matched = true
      for (let j = 0; j < needleLines.length; j++) {
        if (contentLines[i + j].trim() !== needleLines[j]) { matched = false; break }
      }
      if (matched) {
        const startPos = content.split('\n').slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
        const matchStr = contentLines.slice(i, i + needleLines.length).join('\n')
        return { index: startPos, match: matchStr }
      }
    }
  }

  return null
}

const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB

function createEditFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'edit_file',
    description:
      'Performs exact string replacements in files.\n\n' +
      'Usage:\n' +
      '- You must use read_file at least once before editing. This tool will error if you attempt an edit without reading.\n' +
      '- When editing text from read_file output, preserve the exact indentation (tabs/spaces) as it appears in the file content.\n' +
      '- ALWAYS prefer editing existing files. NEVER use write_file for existing files unless replacing the entire content.\n' +
      '- The edit will FAIL if old_string is not unique. Provide more surrounding context to make it unique, or use replace_all.\n' +
      '- Use replace_all for renaming a variable or string across the file.',
    label: 'Edit File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
      old_string: Type.String({ description: 'Exact text to find in the file' }),
      new_string: Type.String({ description: 'Replacement text (must differ from old_string)' }),
      replace_all: Type.Optional(Type.Boolean({ description: 'Replace all occurrences (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, old_string, new_string, replace_all = false } = params as {
        path: string; old_string: string; new_string: string; replace_all?: boolean
      }
      if (old_string === new_string) {
        return textResult({ error: 'old_string and new_string must differ' })
      }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)

      // Jupyter notebook redirect
      if (filePath.endsWith('.ipynb')) {
        return textResult({ error: 'File is a Jupyter Notebook. Use the notebook_edit tool instead.' })
      }

      // Create file on edit: if file doesn't exist and old_string is empty,
      // create it with new_string as content (matches Claude Code behavior)
      if (!existsSync(resolved)) {
        if (old_string === '') {
          mkdirSync(dirname(resolved), { recursive: true })
          writeFileSync(resolved, new_string, 'utf-8')
          const newMtime = Math.floor(statSync(resolved).mtimeMs)
          ctx.fileStateCache?.recordEdit(filePath, new_string, newMtime)
          ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)
          if (ctx.lspManager && /\.(ts|tsx|js|jsx|py)$/.test(filePath)) {
            ctx.lspManager.notifyFileChanged(resolved, new_string)
            ctx.lspManager.notifyFileSaved?.(resolved)
          }
          return textResult({ ok: true, path: filePath, created: true })
        }
        return textResult({ error: `File not found: ${filePath}` })
      }

      // File size guard
      const stats = statSync(resolved)
      if (stats.size > MAX_EDIT_FILE_SIZE) {
        return textResult({
          error: `File too large to edit (${(stats.size / 1024 / 1024).toFixed(0)} MB). Max: 1 GB.`,
        })
      }

      // Read-before-edit enforcement — block only if never read at all
      const readRecord = ctx.fileStateCache?.getRecord(filePath)
      if (ctx.fileStateCache && !readRecord) {
        return textResult({
          error: 'File has not been read yet. Read it first with read_file before editing.',
        })
      }

      // Staleness detection — content-comparison fallback only for full reads
      if (readRecord && ctx.fileStateCache?.isStale(filePath, resolved)) {
        const isFullRead = !readRecord.partial
        if (isFullRead && readRecord.content) {
          const currentContent = readFileSync(resolved, 'utf-8')
          if (currentContent === readRecord.content) {
            // mtime changed but content is identical — safe to proceed
          } else {
            return textResult({
              error: 'File has been modified since last read (by user, linter, or another process). Read it again before editing.',
            })
          }
        } else {
          return textResult({
            error: 'File has been modified since last read (by user, linter, or another process). Read it again before editing.',
          })
        }
      }

      // Read with encoding + line-ending detection
      const { content, encoding, lineEndings } = readFileWithMetadata(resolved)
      const isMarkdown = /\.(md|mdx)$/i.test(filePath)
      const cleanNewString = isMarkdown ? new_string : stripTrailingWhitespace(new_string)

      // --- Match pipeline ---
      // 1. Exact match
      const exactOccurrences = content.split(old_string).length - 1
      if (exactOccurrences === 1 || (exactOccurrences > 1 && replace_all)) {
        const updated = applyEditToFile(content, old_string, cleanNewString, replace_all)
        return commitEdit(ctx, filePath, resolved, content, updated, encoding, lineEndings, replace_all ? exactOccurrences : 1)
      }
      if (exactOccurrences > 1 && !replace_all) {
        return textResult({
          error: `old_string found ${exactOccurrences} times in ${filePath}. ` +
            'Provide more context to make it unique, or set replace_all: true.',
        })
      }

      // 2. Curly quote normalization
      if (!replace_all) {
        const actualString = findActualString(content, old_string)
        if (actualString && actualString !== old_string) {
          const adjustedNew = preserveQuoteStyle(old_string, actualString, cleanNewString)
          const updated = applyEditToFile(content, actualString, adjustedNew, false)
          return commitEdit(ctx, filePath, resolved, content, updated, encoding, lineEndings, 1, 'Matched with quote normalization')
        }
      }

      // 3. Fuzzy match (whitespace/line-ending normalization)
      if (!replace_all) {
        const fuzzy = fuzzyFindInContent(content, old_string)
        if (fuzzy) {
          const updated = content.substring(0, fuzzy.index) + cleanNewString + content.substring(fuzzy.index + fuzzy.match.length)
          return commitEdit(ctx, filePath, resolved, content, updated, encoding, lineEndings, 1, 'Matched with whitespace normalization')
        }
      }

      // No match — provide helpful context
      const lines = content.split('\n')
      const needleFirst = old_string.split('\n')[0]?.trim()
      const nearbyLines: string[] = []
      if (needleFirst) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(needleFirst)) {
            const start = Math.max(0, i - 1)
            const end = Math.min(lines.length, i + 3)
            nearbyLines.push(`Lines ${start + 1}-${end}: ${lines.slice(start, end).join('\n')}`)
            if (nearbyLines.length >= 2) break
          }
        }
      }

      return textResult({
        error: `old_string not found in ${filePath}`,
        hint: nearbyLines.length > 0
          ? `Similar content found near:\n${nearbyLines.join('\n---\n')}`
          : 'No similar content found. Try reading the file first to get the exact text.',
      })
    },
  }
}

async function commitEdit(
  ctx: ToolContext,
  filePath: string,
  resolved: string,
  originalContent: string,
  updated: string,
  encoding: BufferEncoding,
  lineEndings: LineEndingType,
  replacements: number,
  note?: string,
): Promise<AgentToolResult<any>> {
  writeWithMetadata(resolved, updated, encoding, lineEndings)

  // Post-edit state tracking (recordEdit instead of invalidate)
  const newMtime = Math.floor(statSync(resolved).mtimeMs)
  if (ctx.fileStateCache) {
    ctx.fileStateCache.recordEdit(filePath, updated, newMtime)
  }

  ctx.canvasFileWatcher?.onFileChanged(filePath, resolved)
  if (ctx.lspManager && /\.(ts|tsx|js|jsx|py)$/.test(filePath)) {
    ctx.lspManager.notifyFileChanged(resolved, updated)
    ctx.lspManager.notifyFileSaved?.(resolved)
  }

  const patch = getStructuredPatch(filePath, originalContent, updated)
  const base: Record<string, any> = { ok: true, path: filePath, replacements, patch }
  if (note) base.note = note
  appendImpactHint(ctx, filePath, base)
  const schemaResult = await maybeSchemaSync(ctx, filePath, resolved, base)
  return textResult(schemaResult ?? base)
}

// ---------------------------------------------------------------------------
// Glob Tool (file pattern matching)
// ---------------------------------------------------------------------------

function createGlobTool(ctx: ToolContext): AgentTool {
  return {
    name: 'glob',
    description:
      'Find files matching a glob pattern in the workspace. ' +
      'Returns matching file paths sorted by modification time (newest first). Max 500 results. ' +
      'Example patterns: "**/*.tsx", "src/components/**", "*.test.ts".',
    label: 'Glob',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Glob pattern (e.g. **/*.ts, src/**/*.py)' }),
      path: Type.Optional(Type.String({ description: 'Directory to search (default: workspace root)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string }
      const baseDir = searchPath
        ? assertWithinWorkspace(ctx.workspaceDir, searchPath)
        : ctx.workspaceDir

      if (!existsSync(baseDir)) {
        return textResult({ error: `Directory not found: ${searchPath || '/'}` })
      }

      try {
        const glob = new Bun.Glob(pattern)
        const matches: Array<{ path: string; modified: number }> = []
        const MAX_RESULTS = 500
        for (const match of glob.scanSync({ cwd: baseDir, absolute: false })) {
          const absPath = join(baseDir, match)
          if (!absPath.startsWith(resolve(ctx.workspaceDir))) continue
          try {
            const stat = statSync(absPath)
            matches.push({ path: match, modified: stat.mtimeMs })
          } catch { /* skip inaccessible */ }
          if (matches.length >= MAX_RESULTS) break
        }
        matches.sort((a, b) => b.modified - a.modified)
        return textResult({
          pattern,
          files: matches.map(m => m.path),
          count: matches.length,
          truncated: matches.length >= MAX_RESULTS,
        })
      } catch (err: any) {
        return textResult({ error: `Glob error: ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Grep Tool (regex search in file contents)
// ---------------------------------------------------------------------------

function createGrepTool(ctx: ToolContext): AgentTool {
  return {
    name: 'grep',
    description:
      'Search for a regex pattern in file contents across the workspace. ' +
      'Uses ripgrep when available, falls back to a built-in scanner. ' +
      'Returns matches with file path, line number, and matched text. Max 50 results by default. ' +
      'Use the include param to filter by file type (e.g., "*.tsx"). Prefer this over exec("grep ...").',
    label: 'Grep',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path: Type.Optional(Type.String({ description: 'File or directory to search (default: workspace root)' })),
      include: Type.Optional(Type.String({ description: 'Glob filter for files (e.g. *.ts, *.{js,jsx})' })),
      context_lines: Type.Optional(Type.Number({ description: 'Lines of context around each match (default: 0)' })),
      max_results: Type.Optional(Type.Number({ description: 'Maximum number of matches to return (default: 50)' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        pattern, path: searchPath, include, context_lines = 0, max_results = 50,
      } = params as {
        pattern: string; path?: string; include?: string; context_lines?: number; max_results?: number
      }
      const targetPath = searchPath
        ? assertWithinWorkspace(ctx.workspaceDir, searchPath)
        : ctx.workspaceDir

      const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
      const rgBin = resolveRgPath().replace(/\\/g, '/')
      const args = [sq(rgBin), '--json', '-e', sq(pattern), '--max-count', String(max_results)]
      if (context_lines > 0) args.push('-C', String(context_lines))
      if (include) args.push('--glob', sq(include))
      args.push('--', sq(targetPath))

      const rgResult = sandboxExec({
        command: args.join(' '),
        workspaceDir: ctx.workspaceDir,
        timeout: 15000,
        sandboxConfig: ctx.sandbox,
      })

      // rg exit code: 0=matches found, 1=no matches, 2+=error
      if (rgResult.exitCode <= 1 && !rgResult.stderr.includes('command not found')) {
        const matches: Array<{
          file: string; line: number; text: string; context?: string[]
        }> = []
        for (const line of rgResult.stdout.split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'match' && msg.data) {
              const filePath = msg.data.path?.text || ''
              const relativePath = filePath.startsWith(ctx.workspaceDir)
                ? filePath.slice(ctx.workspaceDir.length + 1)
                : filePath
              matches.push({
                file: relativePath,
                line: msg.data.line_number,
                text: msg.data.lines?.text?.trimEnd() || '',
              })
            }
          } catch { /* skip malformed lines */ }
        }
        const grepResult: Record<string, any> = { pattern, matches, count: matches.length }
        if (matches.length >= max_results) {
          grepResult.truncated = true
          grepResult.note = `Showing first ${max_results} matches. Use a more specific pattern or include filter to narrow results.`
        }
        return textResult(grepResult)
      } else {
        try {
          const regex = new RegExp(pattern, 'gm')
          const matches: Array<{ file: string; line: number; text: string }> = []
          const targetStat = statSync(targetPath)
          const filesToSearch = targetStat.isDirectory()
            ? readdirSync(targetPath, { recursive: true })
                .map(f => String(f))
                .filter(f => !f.includes('node_modules') && !f.startsWith('.'))
                .slice(0, 200)
            : ['']

          for (const file of filesToSearch) {
            const fullPath = targetStat.isDirectory() ? join(targetPath, file) : targetPath
            try {
              const stat = statSync(fullPath)
              if (!stat.isFile() || stat.size > 1_000_000) continue
              const content = readFileSync(fullPath, 'utf-8')
              const lines = content.split('\n')
              for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                if (regex.test(lines[i])) {
                  matches.push({
                    file: targetStat.isDirectory() ? file : (searchPath || fullPath.slice(ctx.workspaceDir.length + 1)),
                    line: i + 1,
                    text: lines[i].trimEnd(),
                  })
                }
                regex.lastIndex = 0
              }
            } catch { /* skip unreadable files */ }
          }
          const fallbackResult: Record<string, any> = { pattern, matches, count: matches.length, fallback: true }
          if (matches.length >= max_results) {
            fallbackResult.truncated = true
            fallbackResult.note = `Showing first ${max_results} matches. Use a more specific pattern or include filter to narrow results.`
          }
          return textResult(fallbackResult)
        } catch (err: any) {
          return textResult({ error: `Grep failed: ${err.message}` })
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// LS Tool (workspace directory listing)
// ---------------------------------------------------------------------------

function createLsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'ls',
    description:
      'List files and directories at a path within the workspace. ' +
      'Unlike list_files (scoped to files/), this can list any workspace directory. ' +
      'Recursive mode has max depth 3. Skips node_modules and dotfiles at root level.',
    label: 'List Directory',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory path relative to workspace (default: root)' })),
      recursive: Type.Optional(Type.Boolean({ description: 'List recursively, max depth 3 (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: dirPath = '', recursive = false } = params as { path?: string; recursive?: boolean }
      const targetDir = dirPath
        ? assertWithinWorkspace(ctx.workspaceDir, dirPath)
        : ctx.workspaceDir

      if (!existsSync(targetDir)) {
        return textResult({ error: `Directory not found: ${dirPath || '/'}` })
      }
      try {
        const stat = statSync(targetDir)
        if (!stat.isDirectory()) {
          return textResult({ error: `Not a directory: ${dirPath}` })
        }
      } catch (err: any) {
        return textResult({ error: `Cannot stat: ${err.message}` })
      }

      const MAX_ENTRIES = 200
      const allEntries = lsDir(targetDir, ctx.workspaceDir, recursive, 0, 3)
      const truncated = allEntries.length > MAX_ENTRIES
      const entries = truncated ? allEntries.slice(0, MAX_ENTRIES) : allEntries
      const result: Record<string, any> = { path: dirPath || '/', entries, count: entries.length }
      if (truncated) {
        result.truncated = true
        result.totalEntries = allEntries.length
        result.note = `Showing first ${MAX_ENTRIES} of ${allEntries.length} entries. Use a more specific path or glob to narrow results.`
      }
      return textResult(result)
    },
  }
}

const LS_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.hg', '.svn', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.eggs', '*.egg-info'])

function lsDir(dir: string, rootDir: string, recursive: boolean, depth: number, maxDepth: number): any[] {
  const results: any[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.claude') continue
      if (LS_SKIP_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue
      const absPath = join(dir, entry.name)
      const relPath = absPath.slice(resolve(rootDir).length + 1)
      try {
        const stat = statSync(absPath)
        if (entry.isDirectory()) {
          results.push({ name: entry.name, path: relPath, type: 'directory', modified: stat.mtimeMs })
          if (recursive && depth < maxDepth) {
            results.push(...lsDir(absPath, rootDir, true, depth + 1, maxDepth))
          }
        } else {
          results.push({ name: entry.name, path: relPath, type: 'file', size: stat.size, modified: stat.mtimeMs })
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip unreadable dirs */ }
  return results
}

// ---------------------------------------------------------------------------
// App Template Tools (template_list, template_copy) — DISABLED (app mode removed)
// See APP_MODE_DISABLED.md for re-enablement instructions.
// ---------------------------------------------------------------------------

/* APP_MODE_DISABLED: template tools commented out

const APP_TEMPLATE_METADATA: Array<{
  name: string
  description: string
  complexity: 'beginner' | 'intermediate' | 'advanced'
  models: string[]
}> = [
  { name: '_template', description: 'Blank starter — minimal scaffolding with no pre-built models. Use when no other template matches.', complexity: 'beginner', models: ['User'] },
  { name: 'todo-app', description: 'Simple task management with user auth', complexity: 'beginner', models: ['User', 'Todo'] },
  { name: 'kanban', description: 'Kanban board with drag-and-drop task management', complexity: 'intermediate', models: ['User', 'Board', 'Column', 'Card'] },
  { name: 'expense-tracker', description: 'Personal expense tracker with categories and budgets', complexity: 'intermediate', models: ['User', 'Category', 'Expense', 'Budget'] },
  { name: 'booking-app', description: 'Booking and reservation system with time slots', complexity: 'intermediate', models: ['User', 'Service', 'TimeSlot', 'Booking'] },
  { name: 'crm', description: 'CRM with contacts, companies, deals, tags, and notes', complexity: 'advanced', models: ['User', 'Contact', 'Company', 'Tag', 'ContactTag', 'Note', 'Deal'] },
  { name: 'inventory', description: 'Inventory management with products, categories, and stock tracking', complexity: 'intermediate', models: ['User', 'Category', 'Product', 'StockMovement'] },
  { name: 'feedback-form', description: 'Feedback and survey collection system', complexity: 'intermediate', models: ['User', 'Form', 'Question', 'Response', 'Answer'] },
  { name: 'form-builder', description: 'Dynamic form builder with drag-and-drop', complexity: 'advanced', models: ['User', 'Form', 'Field', 'Submission', 'FieldValue'] },
  { name: 'ai-chat', description: 'Full-featured AI chat interface with conversations, artifacts, and documents', complexity: 'advanced', models: ['User', 'Chat', 'Message', 'Vote', 'Document'] },
  { name: 'agent-dashboard', description: 'Agent monitoring dashboard with status, chat, canvas, and file browser', complexity: 'beginner', models: ['User'] },
  { name: 'approval-workflow', description: 'Human-in-the-loop approval workflow with review queue and agent chat', complexity: 'intermediate', models: ['User', 'ApprovalRequest', 'ApprovalStep', 'Comment'] },
  { name: 'data-explorer', description: 'Data exploration tool with tables, metrics, and agent-driven data collection', complexity: 'intermediate', models: ['User', 'Dataset', 'SavedQuery'] },
]

function createTemplateListTool(): AgentTool {
  return {
    name: 'template_list',
    description:
      'List available app starter templates. Every new app MUST start from a template. ' +
      'Choose the closest match, or use "_template" (blank) if nothing fits. ' +
      'Call this BEFORE writing any code if no template has been selected yet.',
    label: 'List App Templates',
    parameters: Type.Object({}),
    execute: async () => {
      return textResult({
        templates: APP_TEMPLATE_METADATA,
        instructions: 'Pick the best match and call template_copy. Use "_template" for blank. NEVER scaffold from scratch.',
      })
    },
  }
}

function createTemplateCopyTool(ctx: ToolContext): AgentTool {
  return {
    name: 'template_copy',
    description:
      'Scaffold a project from a starter template. Extracts the template into project/, ' +
      'sets up the database, installs dependencies, and restarts the preview server. ' +
      'After this, customize the scaffolded code — do NOT create files from scratch.',
    label: 'Copy App Template',
    parameters: Type.Object({
      template: Type.String({ description: 'Template name from template_list (e.g. "todo-app", "_template" for blank)' }),
      name: Type.Optional(Type.String({ description: 'App name (default: "my-app")' })),
    }),
    execute: async (_toolCallId, params) => {
      const { template, name = 'my-app' } = params as { template: string; name?: string }
      const port = process.env.PORT || '8080'
      try {
        const res = await fetch(`http://localhost:${port}/templates/copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template, name }),
        })
        const data = await res.json() as Record<string, any>
        if (!res.ok) {
          const errMsg = data.error || `Template copy failed (${res.status})`
          return textResult({
            error: errMsg,
            hint: 'Call template_list to see available templates. Use "_template" for a blank starter.',
          })
        }
        return textResult({
          ok: true,
          template,
          name,
          message: data.message || 'Template extracted and preview restarted.',
          nextSteps: 'Read project/src/ to understand the scaffolded code, then make customizations.',
        })
      } catch (err: any) {
        return textResult({
          error: `template_copy failed: ${err.message}`,
          hint: 'Call template_list to see available templates. Use "_template" for a blank starter.',
        })
      }
    },
  }
}

END APP_MODE_DISABLED */

// ---------------------------------------------------------------------------
// TodoWrite Tool (session task checklist)
// ---------------------------------------------------------------------------

const todoStores = new Map<string, Array<{ id: string; content: string; status: string }>>()

function createTodoWriteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'todo_write',
    description:
      'Manage a session task checklist. Each call replaces the full todo list. ' +
      'Use to track progress on multi-step tasks.',
    label: 'Todo Write',
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        id: Type.String({ description: 'Unique task identifier' }),
        content: Type.String({ description: 'Task description' }),
        status: Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
        ], { description: 'Task status' }),
      })),
    }),
    execute: async (_toolCallId, params) => {
      const { todos } = params as {
        todos: Array<{ id: string; content: string; status: string }>
      }
      const key = ctx.sessionId || ctx.projectId
      todoStores.set(key, todos)
      return textResult({ ok: true, todos, count: todos.length })
    },
  }
}

// ---------------------------------------------------------------------------
// AskUser Tool (structured multiple-choice questions)
// ---------------------------------------------------------------------------

function createAskUserTool(_ctx: ToolContext): AgentTool {
  return {
    name: 'ask_user',
    description:
      'Ask the user structured multiple-choice questions to gather requirements or clarify ambiguity. ' +
      'The UI will render interactive option selectors. Do not call any other tools after this — wait for the user\'s response.',
    label: 'Ask User',
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        header: Type.String({ description: 'Short label/title for the question (e.g. "Deployment Region")' }),
        question: Type.String({ description: 'The full question text to display to the user' }),
        options: Type.Array(Type.Object({
          label: Type.String({ description: 'Display text for this option' }),
          description: Type.String({ description: 'Brief explanation of what this option means' }),
        })),
        multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options (default: false)' })),
      })),
    }),
    // execute returns a minimal acknowledgment. The gateway suppresses tool-output-available
    // for ask_user so the UI keeps the widget in interactive (input-available) state until
    // the user submits their answer as a new user message.
    execute: async () => textResult({ acknowledged: true }),
  }
}

// ---------------------------------------------------------------------------
// NotifyUserError Tool (prominent error toast in chat UI)
// ---------------------------------------------------------------------------

function createNotifyUserErrorTool(): AgentTool {
  return {
    name: 'notify_user_error',
    description:
      'Show a prominent error notification to the user when a tool fails, an integration is broken, ' +
      'or you cannot complete the requested task. Call this BEFORE explaining the error in chat text. ' +
      'The UI renders an unmissable banner with the title and remediation steps.',
    label: 'Error Notification',
    parameters: Type.Object({
      title: Type.String({ description: 'Short error title, e.g. "GitHub Access Error", "Slack Auth Expired"' }),
      message: Type.String({ description: 'What went wrong AND how to fix it — shown in the notification body' }),
    }),
    execute: async () => textResult({ acknowledged: true }),
  }
}

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WEB_FETCH_TIMEOUT_MS = 30_000

function cleanPlainText(text: string): string {
  return text
    .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function stripHtmlRegex(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return cleanPlainText(text)
}

async function stripHtmlToText(html: string): Promise<string> {
  try {
    const { Readability } = await import('@mozilla/readability')
    const { parseHTML } = await import('linkedom')
    const { document } = parseHTML(html)
    const reader = new Readability(document as any)
    const article = reader.parse()
    if (article?.textContent) {
      return cleanPlainText(article.textContent)
    }
  } catch {}
  return stripHtmlRegex(html)
}

// ---------------------------------------------------------------------------
// Wikipedia: Parsoid HTML → Markdown via Turndown
// ---------------------------------------------------------------------------

const WIKIPEDIA_URL_RE = /^https?:\/\/([a-z]{2,})\.wikipedia\.org\/wiki\/(.+)/i

function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  const m = url.match(WIKIPEDIA_URL_RE)
  if (!m) return null
  const rawTitle = m[2].split('#')[0].split('?')[0]
  return { lang: m[1], title: decodeURIComponent(rawTitle) }
}

async function fetchWikipediaAsMarkdown(lang: string, title: string, maxChars: number): Promise<string> {
  const TurndownService = (await import('turndown')).default
  const { gfm } = await import('turndown-plugin-gfm') as { gfm: (s: any) => void }

  const apiTitle = encodeURIComponent(title.replace(/ /g, '_'))
  const apiUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${apiTitle}`

  const resp = await fetch(apiUrl, {
    headers: {
      'Accept': 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"',
      'User-Agent': 'ShogoAgent/1.0 (https://shogo.dev; russell@shogo.dev)',
    },
    signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    redirect: 'follow',
  })

  if (!resp.ok) return ''

  const html = await resp.text()

  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML(html)

  const removeSelectors = [
    'style', 'link[rel="stylesheet"]',
    '.mw-ref', 'sup.reference',
    '.navbox', '.sisternav', '.portal',
    '.mw-editsection',
    '.mw-empty-elt',
    '.noprint',
    '.mw-authority-control',
    '.ambox', '.tmbox', '.ombox', '.cmbox', '.fmbox',   // maintenance/warning boxes
    '.hatnote',                                          // disambiguation notes
    '.mw-indicators',                                    // page status indicators
    '.catlinks',                                         // category links footer
    'figure[typeof*="mw:File"]',                         // images (drop entirely for text focus)
    'img',                                               // stray images
  ]
  for (const sel of removeSelectors) {
    document.querySelectorAll(sel).forEach((el: any) => el.remove())
  }

  // Convert internal wiki links to plain text (remove href noise)
  document.querySelectorAll('a[rel="mw:WikiLink"]').forEach((el: any) => {
    const span = document.createElement('span')
    span.textContent = el.textContent
    el.replaceWith(span)
  })

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  turndown.use(gfm)
  turndown.remove('style')
  turndown.remove('img')

  let markdown = turndown.turndown(document.toString())

  // Clean up excessive whitespace
  markdown = markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+$/gm, '')
    .trim()

  if (markdown.length > maxChars) {
    markdown = markdown.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
  }

  return markdown
}

// ---------------------------------------------------------------------------
// Serper.dev Web Search
// ---------------------------------------------------------------------------

const SERPER_ENDPOINTS: Record<string, string> = {
  search: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
  places: 'https://google.serper.dev/places',
  maps: 'https://google.serper.dev/maps',
  shopping: 'https://google.serper.dev/shopping',
}

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
  position?: number
  date?: string
  sitelinks?: Array<{ title: string; link: string }>
}

interface SerperResponse {
  searchParameters?: Record<string, unknown>
  knowledgeGraph?: { title?: string; description?: string; type?: string; website?: string; attributes?: Record<string, string> }
  answerBox?: { answer?: string; snippet?: string; snippetHighlighted?: string[] }
  organic?: SerperOrganicResult[]
  peopleAlsoAsk?: Array<{ question: string; snippet?: string; link?: string }>
  relatedSearches?: Array<{ query: string }>
  news?: Array<{ title?: string; link?: string; snippet?: string; date?: string; source?: string }>
  places?: Array<{ title?: string; address?: string; rating?: number; ratingCount?: number }>
  images?: Array<{ title?: string; imageUrl?: string; link?: string }>
  shopping?: Array<{ title?: string; price?: string; link?: string; source?: string }>
  credits?: number
}

function formatSerperResults(raw: SerperResponse, searchType: string): string {
  const parts: string[] = []

  if (raw.answerBox) {
    const ab = raw.answerBox
    const answer = [ab.answer, ab.snippet].filter(Boolean).join(' — ')
    if (answer) parts.push(`**Answer:** ${answer}`)
  }

  if (raw.knowledgeGraph) {
    const kg = raw.knowledgeGraph
    const kgParts = [`**${kg.title || 'Knowledge Graph'}**`]
    if (kg.type) kgParts.push(`Type: ${kg.type}`)
    if (kg.description) kgParts.push(kg.description)
    if (kg.website) kgParts.push(`Website: ${kg.website}`)
    if (kg.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        kgParts.push(`${k}: ${v}`)
      }
    }
    parts.push(kgParts.join('\n'))
  }

  if ((searchType === 'search' || searchType === 'maps') && raw.organic?.length) {
    parts.push('**Search Results:**')
    for (const r of raw.organic.slice(0, 10)) {
      const entry = [`${r.position ?? ''}. **${r.title}**`, r.link, r.snippet].filter(Boolean).join('\n   ')
      parts.push(entry)
    }
  }

  if (searchType === 'news' && raw.news?.length) {
    parts.push('**News Results:**')
    for (const n of raw.news.slice(0, 10)) {
      parts.push([`- **${n.title}**`, n.source ? `(${n.source})` : '', n.date || '', n.link, n.snippet].filter(Boolean).join(' '))
    }
  }

  if ((searchType === 'places' || searchType === 'maps') && raw.places?.length) {
    parts.push('**Places:**')
    for (const p of raw.places.slice(0, 10)) {
      parts.push(`- **${p.title}** — ${p.address || 'N/A'} (${p.rating ?? '?'}/5, ${p.ratingCount ?? 0} reviews)`)
    }
  }

  if (searchType === 'shopping' && raw.shopping?.length) {
    parts.push('**Shopping Results:**')
    for (const s of raw.shopping.slice(0, 10)) {
      parts.push(`- **${s.title}** — ${s.price || 'N/A'} (${s.source || ''}) ${s.link || ''}`)
    }
  }

  if (raw.peopleAlsoAsk?.length) {
    parts.push('**People Also Ask:**')
    for (const q of raw.peopleAlsoAsk.slice(0, 5)) {
      parts.push(`- ${q.question}${q.snippet ? ` — ${q.snippet}` : ''}`)
    }
  }

  if (raw.relatedSearches?.length) {
    parts.push('**Related Searches:** ' + raw.relatedSearches.map(r => r.query).join(', '))
  }

  return parts.join('\n\n') || 'No results found.'
}

// ---------------------------------------------------------------------------
// Google URL → Serper routing
// ---------------------------------------------------------------------------

interface GoogleUrlRoute {
  query: string
  searchType: string
}

/**
 * Detects Google property URLs that won't return useful content via raw HTTP
 * fetch (Maps, Flights, Shopping) and converts them into Serper API queries.
 */
function detectGoogleUrl(url: string): GoogleUrlRoute | null {
  let u: URL
  try { u = new URL(url) } catch { return null }

  const host = u.hostname.replace('www.', '')
  if (host !== 'google.com' && !host.endsWith('.google.com')) return null

  const path = u.pathname

  // Maps directions: /maps/dir/ORIGIN/DESTINATION
  const dirMatch = path.match(/^\/maps\/dir\/([^/]+)\/([^/]+)/)
  if (dirMatch) {
    const origin = decodeURIComponent(dirMatch[1]).replace(/\+/g, ' ')
    const dest = decodeURIComponent(dirMatch[2]).replace(/\+/g, ' ')
    return { query: `directions from ${origin} to ${dest}`, searchType: 'search' }
  }

  // Maps place: /maps/place/PLACE
  const placeMatch = path.match(/^\/maps\/place\/([^/@]+)/)
  if (placeMatch) {
    return { query: decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '), searchType: 'places' }
  }

  // Maps search: /maps/search/QUERY
  const mapSearchMatch = path.match(/^\/maps\/search\/([^/@]+)/)
  if (mapSearchMatch) {
    return { query: decodeURIComponent(mapSearchMatch[1]).replace(/\+/g, ' '), searchType: 'places' }
  }

  // Maps with ?q= parameter
  if (path.startsWith('/maps') && u.searchParams.get('q')) {
    return { query: u.searchParams.get('q')!, searchType: 'places' }
  }

  // Flights: /travel/flights
  if (path.startsWith('/travel/flights')) {
    const q = u.searchParams.get('q')
    if (q) return { query: q, searchType: 'search' }
    const tfs = u.searchParams.get('tfs')
    return { query: tfs ? `flights ${tfs}` : 'flights', searchType: 'search' }
  }

  // Shopping: /shopping
  if (path.startsWith('/shopping')) {
    const q = u.searchParams.get('q') || 'shopping'
    return { query: q, searchType: 'shopping' }
  }

  return null
}

const MIN_USEFUL_CONTENT_LENGTH = 200

// ---------------------------------------------------------------------------
// Web response cache (Redis-backed, enabled by WEB_CACHE_REDIS_URL env var)
// ---------------------------------------------------------------------------

type Redis = import('ioredis').default

const WEB_CACHE_REDIS_URL = process.env.WEB_CACHE_REDIS_URL
const WEB_CACHE_TTL = 60 * 60 * 24 * 30 // 30 days

let _webCacheRedis: Redis | null = null
let _webCacheRedisFailed = false
function getWebCacheRedis(): Redis | null {
  if (!WEB_CACHE_REDIS_URL || _webCacheRedisFailed) return null
  if (!_webCacheRedis) {
    const Redis = require('ioredis').default as new (...args: any[]) => Redis
    _webCacheRedis = new Redis(WEB_CACHE_REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy(times: number) {
        if (times > 3) return null // stop retrying after 3 attempts
        return Math.min(times * 500, 2000)
      },
    })
    _webCacheRedis.on('error', () => {})
    _webCacheRedis.on('end', () => {
      _webCacheRedisFailed = true
      _webCacheRedis = null
    })
    _webCacheRedis.connect().catch(() => {
      _webCacheRedisFailed = true
      _webCacheRedis = null
    })
  }
  return _webCacheRedis
}

function webCacheKey(prefix: string, input: string): string | null {
  if (!WEB_CACHE_REDIS_URL) return null
  const hash = Bun.hash(input).toString(36)
  return `web-cache:${prefix}:${hash}`
}

async function webCacheGet<T>(key: string | null): Promise<T | null> {
  if (!key) return null
  try {
    const redis = getWebCacheRedis()
    if (!redis) return null
    const raw = await redis.get(key)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

async function webCachePut(key: string | null, value: unknown): Promise<void> {
  if (!key) return
  try {
    const redis = getWebCacheRedis()
    if (!redis) return
    await redis.set(key, JSON.stringify(value), 'EX', WEB_CACHE_TTL)
  } catch {}
}

// ---------------------------------------------------------------------------
// Unified Web Tool (fetch + search + smart Google routing)
// ---------------------------------------------------------------------------

async function serperSearch(
  query: string,
  searchType: string,
  opts: { num?: number; gl?: string; hl?: string } = {},
): Promise<AgentToolResult<any>> {
  const { num = 10, gl = 'us', hl = 'en' } = opts

  const cacheKey = webCacheKey('search', JSON.stringify({ query, searchType, num, gl, hl }))
  const cached = await webCacheGet<AgentToolResult<any>>(cacheKey)
  if (cached) return cached

  const directKey = process.env.SERPER_API_KEY
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const apiKey = directKey || proxyToken
  if (!apiKey) {
    return textResult({
      error: 'SERPER_API_KEY not configured and no proxy available. Web search is unavailable.',
      suggestion: 'Set SERPER_API_KEY or configure TOOLS_PROXY_URL + AI_PROXY_TOKEN.',
    })
  }

  const endpoint = directKey
    ? (SERPER_ENDPOINTS[searchType] || SERPER_ENDPOINTS.search)
    : `${proxyUrl}/serper/${searchType || 'search'}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num, gl, hl }),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return textResult({ error: `Serper API error: HTTP ${response.status}`, details: errorText, query })
    }

    const data = (await response.json()) as SerperResponse
    const formatted = formatSerperResults(data, searchType)

    const result = textResult({
      results: formatted,
      raw: data,
      query,
      searchType,
      creditsUsed: data.credits,
    })
    await webCachePut(cacheKey, result)
    return result
  } catch (err: any) {
    return textResult({ error: `Web search failed: ${err.message}`, query })
  }
}

async function rawFetch(url: string, maxChars: number): Promise<AgentToolResult<any>> {
  const cacheKey = webCacheKey('fetch', JSON.stringify({ url, maxChars }))
  const cached = await webCacheGet<AgentToolResult<any>>(cacheKey)
  if (cached) return cached

  // Wikipedia: use Parsoid REST API → Markdown for much better structured content
  const wiki = parseWikipediaUrl(url)
  if (wiki) {
    try {
      const markdown = await fetchWikipediaAsMarkdown(wiki.lang, wiki.title, maxChars)
      if (markdown.length > 100) {
        const result = textResult({ content: markdown, status: 200, bytes: markdown.length, url, type: 'wikipedia-markdown' })
        await webCachePut(cacheKey, result)
        return result
      }
    } catch {}
    // Fall through to normal fetch if Wikipedia API fails
  }

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })

      if (response.status === 403 || response.status === 429) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        return textResult({
          error: `HTTP ${response.status}: Access denied or rate limited. The site may block automated requests.`,
          url,
          suggestion: 'Try again with a query instead of a URL, or try a different source.',
        })
      }

      if (!response.ok) {
        return textResult({ error: `HTTP ${response.status}: ${response.statusText}`, url })
      }

      const contentType = response.headers.get('content-type') || ''

      if (contentType.includes('application/pdf') || url.endsWith('.pdf')) {
        try {
          const { extractText, getDocumentProxy } = await import('unpdf')
          const arrayBuf = await response.arrayBuffer()
          const pdf = await getDocumentProxy(new Uint8Array(arrayBuf))
          const { text: pdfText } = await extractText(pdf, { mergePages: true })
          const cleaned = cleanPlainText(pdfText)
          const truncated = cleaned.length > maxChars
            ? cleaned.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
            : cleaned
          const result = textResult({ content: truncated, status: response.status, bytes: truncated.length, url, type: 'pdf' })
          await webCachePut(cacheKey, result)
          return result
        } catch (pdfErr: any) {
          return textResult({ error: `Failed to extract text from PDF: ${pdfErr.message}`, url })
        }
      }

      let text = await response.text()

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        text = await stripHtmlToText(text)
      }

      if (text.length > maxChars) {
        text = text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
      }

      const result = textResult({ content: text, status: response.status, bytes: text.length, url })
      await webCachePut(cacheKey, result)
      return result
    } catch (err: any) {
      if (attempt < MAX_ATTEMPTS && (err.name === 'TimeoutError' || err.code === 'ECONNRESET')) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      return textResult({ error: err.message, url })
    }
  }

  return textResult({ error: 'All fetch attempts failed', url })
}

function createWebTool(): AgentTool {
  return {
    name: 'web',
    description:
      'Unified web tool: fetch a URL or search the web via Google (Serper API). ' +
      'Provide `url` to fetch a page, or `query` to search. Google property URLs (Maps, Flights, Shopping) ' +
      'are automatically routed through the search API for rich results. ' +
      'Search types: "search" (default), "news", "images", "places", "maps", "shopping".',
    label: 'Web',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'URL to fetch. Google URLs (Maps, Flights, Shopping) are auto-routed to search API.' })),
      query: Type.Optional(Type.String({ description: 'Search query (e.g., "best restaurants in Bali", "directions from LAX to SFO")' })),
      searchType: Type.Optional(Type.String({ description: 'Type of search: "search" (default), "news", "images", "places", "maps", "shopping"' })),
      num: Type.Optional(Type.Number({ description: 'Number of search results (default: 10, max: 100)' })),
      gl: Type.Optional(Type.String({ description: 'Country code for localized results (e.g., "us", "uk", "id")' })),
      hl: Type.Optional(Type.String({ description: 'Language code (e.g., "en", "id", "fr")' })),
      maxChars: Type.Optional(Type.Number({ description: 'Maximum characters for URL fetch (default: 50000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        url,
        query,
        searchType = 'search',
        num = 10,
        gl = 'us',
        hl = 'en',
        maxChars = 50000,
      } = params as {
        url?: string; query?: string; searchType?: string
        num?: number; gl?: string; hl?: string; maxChars?: number
      }

      if (!url && !query) {
        return textResult({ error: 'Provide either `url` (to fetch a page) or `query` (to search the web).' })
      }

      // If a URL is provided, check for Google property routing first
      if (url) {
        const googleRoute = detectGoogleUrl(url)
        if (googleRoute) {
          return serperSearch(googleRoute.query, googleRoute.searchType, { num, gl, hl })
        }

        // Raw fetch for non-Google URLs
        const result = await rawFetch(url, maxChars)
        const details = result.details

        // If the page returned very little useful content, fallback to Serper
        if (
          !details?.error &&
          typeof details?.content === 'string' &&
          details.content.trim().length < MIN_USEFUL_CONTENT_LENGTH &&
          (process.env.SERPER_API_KEY || (process.env.TOOLS_PROXY_URL && process.env.AI_PROXY_TOKEN))
        ) {
          const fallbackQuery = query || url
          const fallback = await serperSearch(fallbackQuery, searchType, { num, gl, hl })
          fallback.details._note = `Raw fetch returned minimal content (${details.content.trim().length} chars); fell back to search.`
          fallback.details._originalUrl = url
          return fallback
        }

        return result
      }

      // Pure search path
      return serperSearch(query!, searchType, { num, gl, hl })
    },
  }
}

function createMemoryReadTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_read',
    description: 'Read agent memory. Use "MEMORY.md" for long-lived facts or a date like "2026-02-18" for daily logs.',
    label: 'Read Memory',
    parameters: Type.Object({
      file: Type.String({ description: '"MEMORY.md" or a date string (YYYY-MM-DD)' }),
    }),
    execute: async (_toolCallId, params) => {
      const { file } = params as { file: string }
      const filePath =
        file === 'MEMORY.md'
          ? join(ctx.workspaceDir, 'MEMORY.md')
          : join(ctx.workspaceDir, 'memory', `${file}.md`)

      if (!existsSync(filePath)) {
        return textResult({ content: '', exists: false })
      }
      return textResult({ content: readFileSync(filePath, 'utf-8'), exists: true })
    },
  }
}

function createMemorySearchTool(ctx: ToolContext): AgentTool {
  let engine: MemorySearchEngine | null = null

  function getEngine(): MemorySearchEngine {
    if (!engine) {
      engine = new MemorySearchEngine(ctx.workspaceDir)
    }
    return engine
  }

  return {
    name: 'memory_search',
    description:
      'Search across all agent memory (MEMORY.md and daily logs) using hybrid keyword + semantic matching. Returns the most relevant memory chunks ranked by relevance.',
    label: 'Search Memory',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural language search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 8)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit = 8 } = params as { query: string; limit?: number }

      try {
        const results = getEngine().search(query, limit)
        return textResult({
          query,
          results: results.map((r) => ({
            file: r.file,
            lines: `${r.lineStart}-${r.lineEnd}`,
            score: Math.round(r.score * 100) / 100,
            matchType: r.matchType,
            content: r.chunk,
          })),
          totalMatches: results.length,
        })
      } catch (err: any) {
        return textResult({ error: `Memory search failed: ${err.message}`, query })
      }
    },
  }
}

function spawnCDPRelay(token: string): Promise<{ cdpEndpoint: string; kill: () => void }> {
  const { spawn } = require('child_process') as typeof import('child_process')
  const srcDir = dirname(new URL(import.meta.url).pathname)
  const relayScript = existsSync(join(srcDir, 'browser-relay.cjs'))
    ? join(srcDir, 'browser-relay.cjs')
    : join(srcDir, '..', 'src', 'browser-relay.cjs')
  const channel = process.env.BROWSER_CHANNEL || 'chrome'
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ''
  const timeout = '90000'

  return new Promise((resolve, reject) => {
    const child = spawn('node', [relayScript, channel, execPath, timeout], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token },
    })

    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('error', (err: Error) => reject(new Error(`Failed to start relay: ${err.message}`)))
    child.on('exit', (code: number | null) => {
      if (code !== null && code !== 0) reject(new Error(`Relay exited with code ${code}: ${stderr}`))
    })

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'error') {
            child.kill()
            reject(new Error(msg.message))
          } else if (msg.type === 'connected' && (child as any).__cdpEndpoint) {
            resolve({ cdpEndpoint: (child as any).__cdpEndpoint, kill: () => child.kill() })
          } else if (msg.type === 'ready') {
            (child as any).__cdpEndpoint = msg.cdpEndpoint
          }
        } catch {}
      }
    })

    setTimeout(() => {
      child.kill()
      reject(new Error('Relay connection timed out (90s). Make sure the Playwright MCP Bridge extension is installed and the token is correct.'))
    }, 95000)
  })
}

function createBrowserTool(ctx: ToolContext): AgentTool {
  let browser: any = null
  let page: any = null
  let isExtensionMode = false
  let killRelay: (() => void) | null = null

  async function ensureBrowser() {
    if (browser && page) return page
    try {
      const pw = await import('playwright-core')

      const extensionToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (extensionToken) {
        const directCdpEndpoint = process.env.BROWSER_CDP_ENDPOINT
        if (directCdpEndpoint) {
          browser = await pw.chromium.connectOverCDP(directCdpEndpoint)
        } else {
          const relay = await spawnCDPRelay(extensionToken)
          killRelay = relay.kill
          browser = await pw.chromium.connectOverCDP(relay.cdpEndpoint, { isLocal: true })
        }

        const browserCtx = browser.contexts()[0]
        page = browserCtx?.pages()[0] || await browser.newPage()
        isExtensionMode = true
      } else {
        browser = await pw.chromium.launch({
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        })
        page = await browser.newPage()
      }
      return page
    } catch (err: any) {
      cleanupRelay()
      if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
        throw new Error(
          `Failed to connect to browser via extension: ${err.message}. ` +
          'Make sure Chrome is running with the "Playwright MCP Bridge" extension installed, ' +
          'and the extension token matches.',
        )
      }
      throw new Error('Playwright is not installed. Run: bunx playwright install chromium')
    }
  }

  function cleanupRelay() {
    if (killRelay) {
      try { killRelay() } catch {}
      killRelay = null
    }
  }

  async function cleanup() {
    if (isExtensionMode) {
      try { if (browser) await browser.close() } catch {}
    } else {
      try { if (page) await page.close() } catch {}
      try { if (browser) await browser.close() } catch {}
    }
    cleanupRelay()
    page = null
    browser = null
    isExtensionMode = false
  }

  function resolveLocator(p: any, ref?: number, selector?: string): any {
    if (ref !== undefined) return p.locator(`[data-shogo-ref="${ref}"]`)
    if (selector) return p.locator(selector)
    return null
  }

  return {
    name: 'browser',
    description:
      'Control a browser. IMPORTANT: You MUST call snapshot before ANY interaction to get element refs — never guess selectors.\n\n' +
      'Actions: navigate (go to URL), snapshot (get accessibility tree with element refs — ALWAYS call this before interacting), ' +
      'click (by ref or CSS selector), fill (clear and replace input text), select (dropdown option), ' +
      'extract (get elements by CSS selector), text (full page text), screenshot (capture visible page as image — you will SEE the image), ' +
      'evaluate (run JS), scroll (scroll page), wait_for (wait for element), close.\n\n' +
      'Workflow: navigate → snapshot → read refs → interact using ref numbers → snapshot again after page changes. ' +
      'Use short incremental waits with snapshot checks rather than long single waits. ' +
      'CSS selectors work as fallback via the selector parameter, but prefer ref from snapshot.',
    label: 'Browser',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('navigate'),
        Type.Literal('snapshot'),
        Type.Literal('click'),
        Type.Literal('fill'),
        Type.Literal('extract'),
        Type.Literal('text'),
        Type.Literal('screenshot'),
        Type.Literal('evaluate'),
        Type.Literal('select'),
        Type.Literal('scroll'),
        Type.Literal('wait_for'),
        Type.Literal('close'),
      ], { description: 'Browser action to perform' }),
      url: Type.Optional(Type.String({ description: 'URL to navigate to (for navigate action)' })),
      ref: Type.Optional(Type.Number({ description: 'Element ref number from snapshot (for click/fill/select — preferred over selector)' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector (fallback for click/fill/extract/select/scroll/wait_for)' })),
      value: Type.Optional(Type.String({ description: 'Text to type (fill), JS to run (evaluate), option value (select), or scroll distance in px (scroll)' })),
      waitMs: Type.Optional(Type.Number({ description: 'Wait time in ms after action (default: 1000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, url, ref, selector, value, waitMs = 1000 } = params as {
        action: string
        url?: string
        ref?: number
        selector?: string
        value?: string
        waitMs?: number
      }

      try {
        if (action === 'close') {
          await cleanup()
          return textResult({ ok: true, action: 'close' })
        }

        const p = await ensureBrowser()

        switch (action) {
          case 'navigate': {
            if (!url) return textResult({ error: 'url is required for navigate' })
            await p.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 5000))
            const title = await p.title()
            const pageUrl = p.url()
            return textResult({ ok: true, title, url: pageUrl })
          }
          case 'snapshot': {
            const snapshot = await p.evaluate(() => {
              const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])
              const INTERACTIVE_ROLES = new Set([
                'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
                'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
                'switch', 'tab', 'slider', 'spinbutton', 'searchbox', 'treeitem',
              ])

              document.querySelectorAll('[data-shogo-ref]').forEach(el => el.removeAttribute('data-shogo-ref'))
              let nextRef = 1

              function getRole(el: Element): string {
                const explicit = el.getAttribute('role')
                if (explicit) return explicit
                const tag = el.tagName
                if (tag === 'A' && el.hasAttribute('href')) return 'link'
                if (tag === 'BUTTON' || (tag === 'INPUT' && ((el as HTMLInputElement).type === 'submit' || (el as HTMLInputElement).type === 'button'))) return 'button'
                if (tag === 'INPUT') {
                  const t = (el as HTMLInputElement).type
                  if (t === 'checkbox') return 'checkbox'
                  if (t === 'radio') return 'radio'
                  if (t === 'range') return 'slider'
                  if (t === 'number') return 'spinbutton'
                  if (t === 'search') return 'searchbox'
                  return 'textbox'
                }
                if (tag === 'SELECT') return 'combobox'
                if (tag === 'TEXTAREA') return 'textbox'
                if (tag === 'IMG') return 'img'
                if (/^H[1-6]$/.test(tag)) return 'heading'
                if (tag === 'NAV') return 'navigation'
                if (tag === 'MAIN') return 'main'
                if (tag === 'HEADER') return 'banner'
                if (tag === 'FOOTER') return 'contentinfo'
                if (tag === 'ASIDE') return 'complementary'
                if (tag === 'FORM') return 'form'
                if (tag === 'TABLE') return 'table'
                if (tag === 'UL' || tag === 'OL') return 'list'
                if (tag === 'LI') return 'listitem'
                if (tag === 'SECTION' && el.getAttribute('aria-label')) return 'region'
                return ''
              }

              function getName(el: Element): string {
                const ariaLabel = el.getAttribute('aria-label')
                if (ariaLabel) return ariaLabel
                const title = el.getAttribute('title')
                if (title) return title
                const alt = el.getAttribute('alt')
                if (alt) return alt
                const placeholder = el.getAttribute('placeholder')
                if (placeholder) return placeholder
                if (el.id) {
                  const label = document.querySelector(`label[for="${el.id}"]`)
                  if (label?.textContent?.trim()) return label.textContent.trim()
                }
                const directText = Array.from(el.childNodes)
                  .filter(n => n.nodeType === Node.TEXT_NODE)
                  .map(n => n.textContent?.trim())
                  .filter(Boolean)
                  .join(' ')
                if (directText) return directText.substring(0, 80)
                if (el.children.length <= 2) {
                  const inner = el.textContent?.trim()
                  if (inner && inner.length <= 80) return inner
                }
                return ''
              }

              function isVisible(el: Element): boolean {
                if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false
                const s = window.getComputedStyle(el)
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
              }

              function walk(el: Element, depth: number): string[] {
                if (!isVisible(el)) return []
                const role = getRole(el)
                const name = getName(el)
                const lines: string[] = []
                let childDepth = depth

                if (role) {
                  const indent = '  '.repeat(depth)
                  let line = `${indent}${role}`
                  if (name) line += ` "${name}"`

                  const v = (el as HTMLInputElement).value
                  if (v && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
                    line += ` value="${v.substring(0, 80)}"`
                  }

                  const attrs: string[] = []
                  if ((el as HTMLInputElement).disabled) attrs.push('disabled')
                  if ((el as HTMLInputElement).checked) attrs.push('checked')
                  const expanded = el.getAttribute('aria-expanded')
                  if (expanded !== null) attrs.push(`expanded=${expanded}`)
                  if (el.getAttribute('aria-selected') === 'true') attrs.push('selected')
                  if (el.getAttribute('aria-required') === 'true') attrs.push('required')
                  if (attrs.length) line += ` [${attrs.join(', ')}]`

                  const isInteractive = INTERACTIVE_TAGS.has(el.tagName) || INTERACTIVE_ROLES.has(role)
                  if (isInteractive && !(el as HTMLInputElement).disabled) {
                    const r = nextRef++
                    el.setAttribute('data-shogo-ref', String(r))
                    line += ` <ref=${r}>`
                  }

                  lines.push(line)
                  childDepth = depth + 1
                }

                for (const child of el.children) {
                  lines.push(...walk(child, childDepth))
                }
                return lines
              }

              const lines = walk(document.body, 0)
              return { text: lines.join('\n') || '(empty page)', refCount: nextRef - 1 }
            })
            return textResult({ snapshot: snapshot.text, url: p.url(), title: await p.title(), refCount: snapshot.refCount })
          }
          case 'click': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator) return textResult({ error: 'ref or selector is required for click' })
            await locator.click({ timeout: 5000 })
            if (waitMs > 0) await p.waitForTimeout(Math.min(waitMs, 3000))
            return textResult({ ok: true, action: 'click', ref, selector })
          }
          case 'fill': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator) return textResult({ error: 'ref or selector is required for fill' })
            if (value === undefined) return textResult({ error: 'value is required for fill' })
            await locator.fill(value, { timeout: 5000 })
            return textResult({ ok: true, action: 'fill', ref, selector })
          }
          case 'extract': {
            if (!selector) return textResult({ error: 'selector is required for extract' })
            const elements = await p.$$eval(selector, (els: Element[]) =>
              els.map(el => ({ text: el.textContent?.trim(), html: el.outerHTML.substring(0, 500) }))
            )
            return textResult({ elements: elements.slice(0, 50), count: elements.length, url: p.url() })
          }
          case 'text': {
            const rawText = await p.evaluate(() => document.body.innerText)
            const cleaned = typeof rawText === 'string' ? cleanPlainText(rawText) : rawText
            const truncated = typeof cleaned === 'string' && cleaned.length > 50000
              ? cleaned.substring(0, 50000) + '\n[Truncated]'
              : cleaned
            return textResult({ content: truncated, url: p.url(), title: await p.title() })
          }
          case 'screenshot': {
            const filename = `screenshot-${Date.now()}.png`
            const screenshotPath = join(ctx.workspaceDir, filename)
            const buffer = await p.screenshot({ path: screenshotPath, fullPage: false })
            const base64 = Buffer.from(buffer).toString('base64')
            return {
              content: [
                { type: 'image' as const, data: base64, mimeType: 'image/png' },
                { type: 'text' as const, text: JSON.stringify({ ok: true, path: filename, url: p.url() }) },
              ],
              details: { ok: true, path: filename, url: p.url() },
            }
          }
          case 'evaluate': {
            if (!value) return textResult({ error: 'value (JS code) is required for evaluate' })
            const result = await p.evaluate(value)
            return textResult({ result, url: p.url() })
          }
          case 'select': {
            const locator = resolveLocator(p, ref, selector)
            if (!locator) return textResult({ error: 'ref or selector is required for select' })
            if (value === undefined) return textResult({ error: 'value is required for select' })
            await locator.selectOption(value, { timeout: 5000 })
            return textResult({ ok: true, action: 'select', ref, selector, value })
          }
          case 'scroll': {
            if (ref !== undefined || selector) {
              const locator = resolveLocator(p, ref, selector)
              if (locator) await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
            } else {
              const distance = parseInt(value || '500', 10)
              await p.evaluate((d: number) => window.scrollBy(0, d), distance)
            }
            return textResult({ ok: true, action: 'scroll' })
          }
          case 'wait_for': {
            if (!selector) return textResult({ error: 'selector is required for wait_for' })
            await p.waitForSelector(selector, { timeout: waitMs || 10000 })
            return textResult({ ok: true, action: 'wait_for', selector })
          }
          default:
            return textResult({ error: `Unknown browser action: ${action}` })
        }
      } catch (err: any) {
        return textResult({ error: `Browser error: ${err.message}`, action })
      }
    },
  }
}

function createSendMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_message',
    description:
      'Send a message through a connected messaging channel (telegram, discord, slack, whatsapp, email).',
    label: 'Send Message',
    parameters: Type.Object({
      channel: Type.String({ description: 'Channel type (e.g. "telegram", "discord")' }),
      channelId: Type.String({ description: 'Target chat/channel ID' }),
      message: Type.String({ description: 'Message text to send' }),
    }),
    execute: async (_toolCallId, params) => {
      const { channel: channelType, channelId, message } = params as {
        channel: string
        channelId: string
        message: string
      }

      const adapter = ctx.channels.get(channelType)
      if (!adapter) {
        return textResult({ error: `Channel not connected: ${channelType}` })
      }

      const status = adapter.getStatus()
      if (!status.connected) {
        return textResult({ error: `Channel ${channelType} is not connected` })
      }

      try {
        await adapter.sendMessage(channelId, message)
        return textResult({ ok: true, channel: channelType, channelId })
      } catch (err: any) {
        return textResult({ error: `Failed to send: ${err.message}` })
      }
    },
  }
}

function createChannelDisconnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_disconnect',
    description: 'Disconnect a messaging channel and remove it from config.',
    label: 'Disconnect Channel',
    parameters: Type.Object({
      type: Type.String({ description: 'Channel type to disconnect (e.g. "discord")' }),
    }),
    execute: async (_toolCallId, params) => {
      const { type } = params as { type: string }

      if (!ctx.disconnectChannel) {
        return textResult({ error: 'Channel disconnect not available in this context' })
      }

      try {
        await ctx.disconnectChannel(type)

        const configPath = join(ctx.workspaceDir, 'config.json')
        if (existsSync(configPath)) {
          try {
            const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
            fileConfig.channels = (fileConfig.channels || []).filter((ch: any) => ch.type !== type)
            writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
          } catch { /* config corrupted, skip */ }
        }

        return textResult({ ok: true, type, message: `${type} channel disconnected` })
      } catch (err: any) {
        return textResult({ error: `Failed to disconnect ${type}: ${err.message}` })
      }
    },
  }
}

function createChannelListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_list',
    description: 'List all configured messaging channels and their connection status.',
    label: 'List Channels',
    parameters: Type.Object({}),
    execute: async () => {
      const configPath = join(ctx.workspaceDir, 'config.json')
      let channelConfigs: Array<{ type: string; model?: string }> = []
      let configured: string[] = []
      if (existsSync(configPath)) {
        try {
          const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          channelConfigs = fileConfig.channels || []
          configured = channelConfigs.map((ch: any) => ch.type)
        } catch { /* ignore */ }
      }

      const statuses = []
      for (const [type, adapter] of ctx.channels) {
        const status = adapter.getStatus()
        const chConf = channelConfigs.find(c => c.type === type)
        if (chConf?.model) {
          status.model = chConf.model
        }
        statuses.push(status)
      }

      return textResult({
        connected: statuses,
        configured,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// MCP Discovery Tools
// ---------------------------------------------------------------------------

function createToolSearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'tool_search',
    description: 'Search for available tools, integrations, and skills by capability or keyword. Searches managed OAuth integrations (Google Calendar, Slack, GitHub, and hundreds more), and bundled/installed agent skills. For MCP protocol servers (databases, file systems, custom tools), use mcp_search instead.',
    label: 'Search Tools & Skills',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query describing the capability you need (e.g. "google calendar", "seo audit", "github ops", "slack mentions")' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 5)' })),
    }),
    execute: async (_id: string, params: any) => {
      const query = params.query as string
      const limit = Math.min(params.limit || 5, 10)

      const results: Array<Record<string, any>> = []

      // 1. Search Composio toolkit catalog (managed OAuth)
      if (isComposioEnabled()) {
        try {
          const composioToolkits = await searchComposioToolkits(query)
          for (const tk of composioToolkits.slice(0, limit)) {
            results.push({
              name: tk.name,
              id: tk.slug,
              description: `${tk.name} — managed OAuth integration. No API keys or credentials needed.`,
              installCommand: `tool_install({ name: "${tk.slug}" })`,
              source: 'managed',
              logo: tk.logo,
            })
          }
        } catch { /* Composio API unavailable */ }
      }

      // 2. Search skills (bundled + installed)
      try {
        const installed = loadAllSkills(ctx.workspaceDir)
        const bundled = loadBundledSkills(new Set(installed.map(s => s.name)))
        const skillResults = searchSkills(query, installed, bundled, limit)
        for (const skill of skillResults) {
          results.push({
            name: skill.name,
            id: `skill:${skill.name}`,
            description: skill.description || `Skill: ${skill.name}`,
            source: 'skill',
            installed: skill.installed,
            installCommand: skill.installed
              ? `Already installed. Read with: read_file({ path: "skills/${skill.name}.md" })`
              : `tool_install({ name: "skill:${skill.name}" })`,
            trigger: skill.trigger,
          })
        }
      } catch { /* skill search failed, continue */ }

      if (results.length === 0) {
        return textResult({ query, results: [], message: 'No integrations or skills found. Try mcp_search for MCP protocol servers, or a different search term.' })
      }

      const managedCount = results.filter(r => r.source === 'managed').length
      const skillCount = results.filter(r => r.source === 'skill').length
      let message = `Found ${results.length} result(s).`
      if (managedCount > 0) message += ` ${managedCount} managed integration(s) (no credentials needed).`
      if (skillCount > 0) message += ` ${skillCount} skill(s) — install with tool_install or read with read_file.`

      return textResult({ query, results, message })
    },
  }
}

function createMcpSearchTool(): AgentTool {
  return {
    name: 'mcp_search',
    description: 'Search for MCP (Model Context Protocol) servers — standalone tool servers for databases, file systems, APIs, browser automation, and more. These are protocol servers that provide tool functions and may require configuration (env vars, API keys). For managed OAuth integrations (Google Calendar, Slack, GitHub), use tool_search instead.',
    label: 'Search MCP Servers',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query describing the capability you need (e.g. "postgres database", "filesystem", "brave search")' }),
      limit: Type.Optional(Type.Number({ description: 'Max results to return (default: 5)' })),
    }),
    execute: async (_id: string, params: any) => {
      const query = params.query as string
      const limit = Math.min(params.limit || 5, 10)

      const queryLower = query.toLowerCase()
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2)
      const scored: Array<{ entry: typeof MCP_CATALOG[0]; score: number }> = []
      for (const entry of MCP_CATALOG) {
        const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category} ${entry.providedTools.join(' ')}`.toLowerCase()
        const idName = `${entry.id} ${entry.name}`.toLowerCase()
        let score = 0
        if (haystack.includes(queryLower)) score += 10
        if (idName.includes(queryLower)) score += 20
        for (const w of queryWords) {
          if (idName.includes(w)) score += 5
          else if (haystack.includes(w)) score += 1
        }
        if (score > 0) scored.push({ entry, score })
      }
      scored.sort((a, b) => b.score - a.score)

      const results: Array<Record<string, any>> = []
      for (const { entry } of scored.slice(0, limit)) {
        results.push({
          name: entry.name,
          id: entry.id,
          description: entry.description,
          category: entry.category,
          installCommand: `mcp_install({ name: "${entry.id}" })`,
          source: 'catalog',
        })
      }

      if (results.length === 0) {
        return textResult({ query, results: [], message: 'No MCP servers found. Try a different search term, or use tool_search for managed OAuth integrations.' })
      }

      return textResult({
        query,
        results,
        message: `Found ${results.length} MCP server(s). Use mcp_install to add one.`,
      })
    },
  }
}

function formatToolInstallMessage(
  toolkitName: string,
  toolCount: number,
  auth: { status: string; authUrl?: string },
): string {
  const base = `"${toolkitName}" installed with ${toolCount} tool(s).`
  if (auth.status !== 'needs_auth') {
    return `${base} Auth is active. No manual credentials needed.`
  }
  if (auth.authUrl) {
    return `${base} User needs to authorize — a Connect button is displayed in the chat for them to click. Do NOT include the auth URL in your response; the UI button handles the OAuth popup flow automatically. Tell the user to click the Connect button below.`
  }
  return `${base} Auth status: needs_auth. The user may need to authorize via the Tools panel.`
}

function createToolInstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'tool_install',
    description: `Install a managed OAuth integration or a bundled skill, making it available immediately.

For integrations (Google Calendar, Slack, GitHub, Linear, Notion, and hundreds more) — just provide the name. No API keys needed; authentication is handled automatically.

For skills — use the "skill:" prefix (e.g. tool_install({ name: "skill:github-ops" })). This copies the bundled skill into your skills/ directory where it activates automatically on matching messages.

For MCP protocol servers (databases, file systems, custom tool servers), use mcp_install instead.`,
    label: 'Install Integration or Skill',
    parameters: Type.Object({
      name: Type.String({ description: 'Integration name (e.g. "googlecalendar", "slack") or skill with prefix (e.g. "skill:github-ops", "skill:mktg-seo-audit"). Use tool_search to find available options.' }),
    }),
    execute: async (_id: string, params: any) => {
      const { name } = params as { name: string }

      // Skill install path: "skill:<name>" copies a bundled skill into the workspace
      if (name.startsWith('skill:')) {
        const skillName = name.slice(6)
        const installed = loadAllSkills(ctx.workspaceDir)
        const bundled = loadBundledSkills(new Set(installed.map(s => s.name)))
        const bundledSkill = bundled.find(s => s.name === skillName)
        if (!bundledSkill) {
          const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skillName)
          if (existsSync(destDir)) {
            return textResult({ error: `Skill "${skillName}" is already installed`, path: `.shogo/skills/${skillName}/SKILL.md` })
          }
          return textResult({ error: `Bundled skill "${skillName}" not found. Use tool_search to find available skills.` })
        }
        const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skillName)
        mkdirSync(destDir, { recursive: true })
        // Copy the entire bundled skill directory
        const srcDir = bundledSkill.skillDir
        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
          const srcPath = join(srcDir, entry.name)
          const destPath = join(destDir, entry.name)
          if (entry.isDirectory()) {
            const { cpSync } = require('fs')
            cpSync(srcPath, destPath, { recursive: true })
          } else {
            writeFileSync(destPath, readFileSync(srcPath))
          }
        }
        return textResult({
          ok: true,
          type: 'skill',
          name: skillName,
          path: `.shogo/skills/${skillName}/SKILL.md`,
          message: `Skill "${skillName}" installed. It will be active on the next message. Read it with read_file({ path: ".shogo/skills/${skillName}/SKILL.md" }) to see its instructions.`,
        })
      }

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      try {
      // Check if Composio session is already initialized
      if (isComposioInitialized() && isComposioEnabled()) {
        const composioToolkit = await findComposioToolkit(name)
        if (composioToolkit) {
          const proxy = await registerToolkitProxyTools(ctx.mcpClientManager, composioToolkit.slug)
          const auth = await checkComposioAuth(composioToolkit.slug)
          return textResult({
            ok: true,
            server: 'composio',
            integration: composioToolkit.slug,
            toolCount: proxy.toolCount,
            tools: proxy.toolNames,
            authStatus: auth.status,
            ...(auth.authUrl ? { authUrl: auth.authUrl } : {}),
            message: formatToolInstallMessage(composioToolkit.name, proxy.toolCount, auth),
          })
        }
      }

      // Dynamically check if this matches a Composio toolkit
      if (isComposioEnabled()) {
        const composioToolkit = await findComposioToolkit(name)
        if (composioToolkit) {
          const userId = ctx.userId || process.env.USER_ID || 'default'
          const workspaceId = process.env.WORKSPACE_ID || 'default'
          const initialized = await initComposioSession(userId, workspaceId, ctx.projectId)
          if (initialized) {
            const proxy = await registerToolkitProxyTools(ctx.mcpClientManager, composioToolkit.slug)
            const auth = await checkComposioAuth(composioToolkit.slug)
            return textResult({
              ok: true,
              server: 'composio',
              integration: composioToolkit.slug,
              toolCount: proxy.toolCount,
              tools: proxy.toolNames,
              authStatus: auth.status,
              ...(auth.authUrl ? { authUrl: auth.authUrl } : {}),
              message: formatToolInstallMessage(composioToolkit.name, proxy.toolCount, auth),
            })
          }
          return textResult({ error: `Failed to connect "${composioToolkit.name}" via Composio. The integration may not be available.` })
        }
      }

      return textResult({ error: `"${name}" is not a managed integration. Use tool_search to find available integrations, or use mcp_install to install an MCP server.` })
      } catch (err: any) {
        console.error(`[tool_install] Unhandled error installing "${params?.name}":`, err)
        return textResult({ error: `Failed to install integration "${params?.name}": ${err.message}` })
      }
    },
  }
}

function createMcpInstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'mcp_install',
    description: `Install and start an MCP (Model Context Protocol) server, making its tools available immediately. MCP servers are standalone tool servers for databases, file systems, APIs, and more.

For catalog servers (${MCP_CATALOG.map(e => e.id).join(', ')}), just provide the name. For remote servers, provide a name and URL.

MCP servers are different from managed integrations — they may require environment variables or API keys. For managed OAuth integrations (Google Calendar, Slack, GitHub), use tool_install instead.`,
    label: 'Install MCP Server',
    parameters: Type.Object({
      name: Type.String({ description: 'MCP server name from the catalog (e.g. "postgres", "filesystem", "github") or a custom name when providing a URL.' }),
      env: Type.Optional(Type.Any({ description: 'Environment variables for the server process (e.g. API keys, connection strings)' })),
      url: Type.Optional(Type.String({ description: 'Remote MCP server URL (for HTTP/StreamableHTTP servers). When provided, connects to the remote server instead of installing an npm package.' })),
      headers: Type.Optional(Type.Any({ description: 'HTTP headers for remote MCP server authentication' })),
    }),
    execute: async (_id: string, params: any) => {
      const { name, env, url, headers } = params as {
        name: string; env?: Record<string, string>
        url?: string; headers?: Record<string, string>
      }

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      try {
      // Handle remote MCP server URL
      if (url) {
        if (ctx.mcpClientManager.isRunning(name)) {
          const info = ctx.mcpClientManager.getServerInfo().find(s => s.name === name)
          return textResult({ error: `Server "${name}" is already running with ${info?.toolCount || 0} tools`, tools: info?.toolNames })
        }
        const tools = await ctx.mcpClientManager.hotAddRemoteServer(name, { url, headers })
        return textResult({
          ok: true,
          server: name,
          type: 'remote',
          toolCount: tools.length,
          tools: tools.map(t => ({ name: t.name, description: t.description })),
          message: `Connected to remote MCP server "${name}" at ${url} with ${tools.length} tool(s).`,
        })
      }

      if (ctx.mcpClientManager.isRunning(name)) {
        const info = ctx.mcpClientManager.getServerInfo().find(s => s.name === name)
        return textResult({ error: `Server "${name}" is already running with ${info?.toolCount || 0} tools`, tools: info?.toolNames })
      }

      const catalogEntry = MCP_CATALOG.find(e => e.id === name)
      if (!isMcpServerAllowed(name) || !catalogEntry) {
        const catalogIds = MCP_CATALOG.map(e => e.id).join(', ')
        return textResult({ error: `"${name}" is not in the MCP catalog. Available servers: ${catalogIds}. For remote servers, provide a "url" parameter. For managed OAuth integrations, use tool_install instead.` })
      }

      let config: { command: string; args?: string[]; env?: Record<string, string> }
      if (isPreinstalledMcpId(name)) {
        config = {
          command: 'npx',
          args: [catalogEntry.package, ...catalogEntry.defaultArgs],
          env,
        }
      } else {
        config = await ctx.mcpClientManager.installPackageLocally(
          catalogEntry.package,
          catalogEntry.defaultArgs,
          env,
        )
        if (env) config.env = { ...config.env, ...env }
      }

      const tools = await ctx.mcpClientManager.hotAddServer(name, config)
      return textResult({
        ok: true,
        server: name,
        toolCount: tools.length,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
        message: `Installed MCP server "${name}" with ${tools.length} tool(s). They are now available for use.`,
      })
      } catch (err: any) {
        console.error(`[mcp_install] Unhandled error installing "${name}":`, err)
        return textResult({ error: `Failed to install MCP server "${name}": ${err.message}` })
      }
    },
  }
}

function createToolUninstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'tool_uninstall',
    description: 'Stop and remove a managed integration. Its tools will no longer be available. For MCP servers, use mcp_uninstall instead.',
    label: 'Uninstall Integration',
    parameters: Type.Object({
      name: Type.String({ description: 'Integration name to remove (use tool_search to find names)' }),
    }),
    execute: async (_id: string, params: any) => {
      const name = params.name as string

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      try {
        if (!ctx.mcpClientManager.isRunning(name)) {
          return textResult({ error: `Integration "${name}" is not running`, installed: ctx.mcpClientManager.getServerNames() })
        }

        await ctx.mcpClientManager.hotRemoveServer(name)
        return textResult({ ok: true, removed: name, message: `Removed integration "${name}" and all its tools.` })
      } catch (err: any) {
        console.error(`[tool_uninstall] Unhandled error removing "${name}":`, err)
        return textResult({ error: `Failed to remove "${name}": ${err.message}` })
      }
    },
  }
}

function createMcpUninstallTool(ctx: ToolContext): AgentTool {
  return {
    name: 'mcp_uninstall',
    description: 'Stop and remove a running MCP server. Its tools will no longer be available. For managed integrations, use tool_uninstall instead.',
    label: 'Uninstall MCP Server',
    parameters: Type.Object({
      name: Type.String({ description: 'MCP server name to remove (use mcp_search to find names)' }),
    }),
    execute: async (_id: string, params: any) => {
      const name = params.name as string

      if (!ctx.mcpClientManager) {
        return textResult({ error: 'MCP client manager not available' })
      }

      try {
        if (!ctx.mcpClientManager.isRunning(name)) {
          return textResult({ error: `MCP server "${name}" is not running`, installed: ctx.mcpClientManager.getServerNames() })
        }

        const info = ctx.mcpClientManager.getServerInfo().find(s => s.name === name)
        if (info?.config.command === 'remote') {
          await ctx.mcpClientManager.hotRemoveRemoteServer(name)
        } else {
          await ctx.mcpClientManager.hotRemoveServer(name)
        }
        return textResult({ ok: true, removed: name, message: `Removed MCP server "${name}" and all its tools.` })
      } catch (err: any) {
        console.error(`[mcp_uninstall] Unhandled error removing "${name}":`, err)
        return textResult({ error: `Failed to remove MCP server "${name}": ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Agent Orchestration Tools (agent_create, agent_spawn, agent_status, etc.)
// ---------------------------------------------------------------------------

import { AgentManager } from './agent-manager'
import type { ModelTierName, ForkContext } from './subagent'
import { isInForkChild, buildForkDirective } from './subagent-prompts'

function createAgentCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_create',
    description:
      'Register a new sub-agent type at runtime. Define its system prompt, allowed tools, and model tier. ' +
      'Use the same name to update an existing type. Set persist: true to save across sessions.',
    label: 'Create Agent',
    parameters: Type.Object({
      name: Type.String({ description: 'Unique agent type name (e.g. "test-writer", "pr-reviewer")' }),
      description: Type.String({ description: 'Short description of what this agent does' }),
      system_prompt: Type.String({ description: 'System prompt for the agent (max 4000 chars)' }),
      tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool names this agent can use. Omit for all tools.' })),
      model_tier: Type.Optional(Type.String({ description: 'Model tier: fast, default, or capable' })),
      max_turns: Type.Optional(Type.Number({ description: 'Max agentic turns (default: 10)' })),
      readonly: Type.Optional(Type.Boolean({ description: 'If true, only read-only tools are available' })),
      persist: Type.Optional(Type.Boolean({ description: 'If true, save to .shogo/agents/ for future sessions' })),
    }),
    execute: async (_id, params) => {
      const { name, description, system_prompt, tools, model_tier, max_turns, readonly: ro, persist } = params as {
        name: string; description: string; system_prompt: string;
        tools?: string[]; model_tier?: string; max_turns?: number; readonly?: boolean; persist?: boolean
      }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const config: SubagentConfig = {
        name,
        description,
        systemPrompt: system_prompt,
        toolNames: tools,
        modelTier: (model_tier as ModelTierName) || 'default',
        maxTurns: max_turns || 10,
        readonly: ro,
      }

      const result = am.register(config, persist)
      if (!result.ok) return textResult({ error: result.error })

      const types = am.listTypes()
      ctx.uiWriter?.write({ type: 'data-agent-types', data: { types } })

      return textResult({ ok: true, name, description, persisted: !!persist })
    },
  }
}

function createAgentSpawnTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'agent_spawn',
    description:
      'Launch an instance of a registered or built-in agent type. Returns an instance_id. ' +
      'Use background: true for async execution, then check with agent_status/agent_result. ' +
      'Built-in types: explore, general-purpose, code-reviewer. ' +
      'Omit type to use fork mode (inherits your full context — ideal for context-heavy tasks).',
    label: 'Spawn Agent',
    parameters: Type.Object({
      type: Type.Optional(Type.String({
        description: 'Agent type name (built-in or created with agent_create). Omit for fork mode (inherits full context).',
      })),
      prompt: Type.String({ description: 'Task prompt for the agent' }),
      model_tier: Type.Optional(Type.String({ description: 'Model tier: fast (cheap), default (parent), capable (best)' })),
      max_turns: Type.Optional(Type.Number({ description: 'Max agentic turns (default: 10, fork: 200)' })),
      readonly: Type.Optional(Type.Boolean({ description: 'If true, only read-only tools are available' })),
      background: Type.Optional(Type.Boolean({ description: 'If true, run asynchronously (default: false — blocks until done)' })),
      resume: Type.Optional(Type.String({ description: 'Instance ID to resume (sends follow-up to existing agent)' })),
    }),
    execute: async (toolCallId, params) => {
      const {
        type,
        prompt,
        model_tier,
        max_turns,
        readonly: readonlyMode,
        background,
        resume,
      } = params as {
        type?: string; prompt: string; model_tier?: string; max_turns?: number;
        readonly?: boolean; background?: boolean; resume?: string
      }

      // --- Fork mode: type is omitted ---
      if (!type) {
        if (!ctx.renderedSystemPrompt || !ctx.sessionMessages) {
          return textResult({ error: 'Fork mode requires parent context (renderedSystemPrompt + sessionMessages). Not available in this context.' })
        }

        // Recursive fork guard
        if (isInForkChild(ctx.sessionMessages)) {
          return textResult({ error: 'Cannot fork from within a fork. Execute the task directly instead.' })
        }

        const forkConfig: SubagentConfig = {
          name: 'fork',
          description: 'Context-aware forked worker',
          systemPrompt: '', // overridden by forkContext
          maxTurns: max_turns || 200,
        }
        if (model_tier && (model_tier === 'fast' || model_tier === 'default' || model_tier === 'capable')) {
          forkConfig.modelTier = model_tier as ModelTierName
        }

        const forkContext: import('./subagent').ForkContext = {
          systemPrompt: ctx.renderedSystemPrompt,
          parentMessages: ctx.sessionMessages,
          parentTools: allToolsGetter(),
          thinkingLevel: 'medium',
        }

        const w = ctx.uiWriter
        const spawn = buildSpawnCallbacks(w, toolCallId)
        const forkDirective = buildForkDirective(prompt)
        const result = await runSubagent(forkConfig, forkDirective, ctx, allToolsGetter(), spawn?.callbacks, { forkContext })

        if (w && (result.inputTokens > 0 || result.outputTokens > 0)) {
          w.write({
            type: 'data-usage',
            data: {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens,
              cacheWriteTokens: result.cacheWriteTokens,
              iterations: result.iterations,
              toolCallCount: result.toolCalls,
              subagent: 'fork',
            },
          })
        }

        const accumulated = spawn?.getAccumulatedOutput()
        return textResult({
          mode: 'fork',
          agent_id: result.agentId,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
          tokens: { input: result.inputTokens, output: result.outputTokens },
          parts: accumulated?.parts,
        })
      }

      // --- Normal mode: type is specified ---
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const history = resume ? am.getInstanceMessages(resume) ?? undefined : undefined

      // Apply optional overrides before spawn
      if (model_tier || max_turns || readonlyMode) {
        const config = am.getConfig(type) || getBuiltinSubagentConfig(type, ctx, allToolsGetter())
        if (config) {
          if (model_tier && (model_tier === 'fast' || model_tier === 'default' || model_tier === 'capable')) {
            config.modelTier = model_tier as ModelTierName
          }
          if (max_turns) config.maxTurns = max_turns
          if (readonlyMode) config.readonly = true
        }
      }

      const w = ctx.uiWriter
      const spawn = buildSpawnCallbacks(w, toolCallId)

      const spawnResult = am.spawn(type, prompt, ctx, allToolsGetter(), spawn?.callbacks, { history })
      if (!spawnResult.ok) return textResult({ error: spawnResult.error })

      const instanceId = spawnResult.instanceId

      if (background) {
        return textResult({ instance_id: instanceId, status: 'running', hint: 'Use agent_status or agent_result to check progress' })
      }

      // Synchronous: wait for completion
      const inst = am.getInstance(instanceId)
      if (!inst) return textResult({ error: 'Instance lost' })
      const result = await inst.promise

      if (w && (result.inputTokens > 0 || result.outputTokens > 0)) {
        w.write({
          type: 'data-usage',
          data: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
            iterations: result.iterations,
            toolCallCount: result.toolCalls,
            subagent: type,
          },
        })
      }

      const accumulated = spawn?.getAccumulatedOutput()
      return textResult({
        instance_id: instanceId,
        agent_id: result.agentId,
        status: inst.status,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        tokens: { input: result.inputTokens, output: result.outputTokens },
        parts: accumulated?.parts,
      })
    },
  }
}

/**
 * Build sub-agent stream callbacks that accumulate content into an internal
 * parts[] array and periodically emit it as a preliminary tool output.
 *
 * Uses the AI SDK's preliminary tool results pattern: the sub-agent's content
 * lives INSIDE the agent_spawn tool's output (tool-output-available with
 * preliminary: true), keeping it completely separate from the parent's
 * text/tool events. Each sub-agent is scoped to its own spawnToolCallId,
 * so multiple concurrent sub-agents work correctly.
 */
export function buildSpawnCallbacks(w: any, spawnToolCallId: string): { callbacks: SubagentStreamCallbacks; getAccumulatedOutput: () => { agentId: string | null; parts: any[] } } | undefined {
  if (!w) return undefined

  const parts: any[] = []
  let agentId: string | null = null
  let lastEmitTime = 0
  let pendingEmit: ReturnType<typeof setTimeout> | null = null
  const THROTTLE_MS = 150

  function emitPreliminary(force?: boolean) {
    const now = Date.now()
    if (!force && now - lastEmitTime < THROTTLE_MS) {
      if (!pendingEmit) {
        pendingEmit = setTimeout(() => {
          pendingEmit = null
          emitPreliminary(true)
        }, THROTTLE_MS - (now - lastEmitTime))
      }
      return
    }
    if (pendingEmit) { clearTimeout(pendingEmit); pendingEmit = null }
    lastEmitTime = now
    w.write({
      type: 'tool-output-available',
      toolCallId: spawnToolCallId,
      output: { agentId, parts: [...parts] },
      dynamic: true,
      preliminary: true,
    })
  }

  const callbacks: SubagentStreamCallbacks = {
    onStart: (_name: string, _desc: string, id: string) => {
      agentId = id
    },
    onEnd: (_name: string) => {
      // Flush any pending throttled emit so the last snapshot arrives
      if (pendingEmit) { clearTimeout(pendingEmit); pendingEmit = null }
      emitPreliminary(true)
    },
    onTextDelta: (delta: string) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'text') { last.text += delta }
      else { parts.push({ type: 'text', text: delta, id: `sa-text-${parts.length}` }) }
      emitPreliminary()
    },
    onThinkingStart: () => {
      parts.push({ type: 'reasoning', text: '', isStreaming: true, id: `sa-reason-${parts.length}` })
      emitPreliminary()
    },
    onThinkingDelta: (delta: string) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'reasoning') last.text += delta
    },
    onThinkingEnd: () => {
      const last = parts[parts.length - 1]
      if (last?.type === 'reasoning') last.isStreaming = false
      emitPreliminary(true)
    },
    onToolCallStart: (toolName: string, toolCallId: string) => {
      parts.push({ type: 'tool', id: toolCallId, tool: { id: toolCallId, toolName, state: 'streaming', args: undefined, result: undefined } })
      emitPreliminary()
    },
    onToolCallDelta: (_toolName: string, _delta: string, _toolCallId: string) => {
      // streaming args — we'll set final args in onBeforeToolCall
    },
    onToolCallEnd: (_toolName: string, _toolCallId: string) => {},
    onBeforeToolCall: async (toolName: string, args: any, toolCallId: string) => {
      let p = parts.find((p: any) => p.type === 'tool' && p.id === toolCallId)
      if (!p) {
        p = { type: 'tool', id: toolCallId, tool: { id: toolCallId, toolName, state: 'streaming', args, result: undefined } }
        parts.push(p)
      } else {
        p.tool.args = args
      }
      emitPreliminary(true)
    },
    onAfterToolCall: async (_toolName: string, _args: any, result: any, isError: boolean, toolCallId: string) => {
      const parsed = typeof result === 'string' ? (() => { try { return JSON.parse(result) } catch { return result } })() : result
      const p = parts.find((p: any) => p.type === 'tool' && p.id === toolCallId)
      if (p) {
        p.tool.result = isError
          ? { error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) }
          : (parsed ?? { success: true })
        p.tool.state = isError ? 'error' : 'success'
      }
      emitPreliminary(true)
    },
  }

  return {
    callbacks,
    getAccumulatedOutput: () => ({ agentId, parts: [...parts] }),
  }
}

function createAgentStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_status',
    description: 'Check the status of agent instances. Omit instance_id to see all.',
    label: 'Agent Status',
    parameters: Type.Object({
      instance_id: Type.Optional(Type.String({ description: 'Specific instance ID to check' })),
    }),
    execute: async (_id, params) => {
      const { instance_id } = params as { instance_id?: string }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      if (instance_id) {
        const inst = am.getInstance(instance_id)
        if (!inst) return textResult({ error: `Unknown instance: ${instance_id}` })
        return textResult({
          id: inst.id,
          type: inst.type,
          status: inst.status,
          elapsed_ms: Date.now() - inst.startedAt,
          ...(inst.result ? { toolCalls: inst.result.toolCalls, iterations: inst.result.iterations } : {}),
        })
      }

      return textResult({ instances: am.listInstances() })
    },
  }
}

function createAgentCancelTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_cancel',
    description: 'Cancel a running agent instance.',
    label: 'Cancel Agent',
    parameters: Type.Object({
      instance_id: Type.String({ description: 'Instance ID to cancel' }),
    }),
    execute: async (_id, params) => {
      const { instance_id } = params as { instance_id: string }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const cancelled = am.cancel(instance_id)
      return textResult({ ok: cancelled, instance_id })
    },
  }
}

function createAgentResultTool(ctx: ToolContext): AgentTool {
  return {
    name: 'agent_result',
    description:
      'Wait for and retrieve the result of an agent instance. Blocks until the agent completes ' +
      'by default (up to 2 min). Set timeout_ms to 0 for an immediate non-blocking check.',
    label: 'Agent Result',
    parameters: Type.Object({
      instance_id: Type.String({ description: 'Instance ID to retrieve result for' }),
      timeout_ms: Type.Optional(Type.Number({
        description: 'Max milliseconds to wait for completion. Defaults to 120000 (2 min). Set to 0 for immediate (non-blocking) check.',
        default: 120_000,
      })),
    }),
    execute: async (_id, params) => {
      const { instance_id, timeout_ms = 120_000 } = params as { instance_id: string; timeout_ms?: number }
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const inst = am.getInstance(instance_id)
      if (!inst) return textResult({ error: `Unknown instance: ${instance_id}` })

      if (inst.status === 'running' && timeout_ms > 0) {
        const timeout = new Promise<null>(r => setTimeout(() => r(null), timeout_ms))
        const winner = await Promise.race([inst.promise.then(r => r), timeout])
        if (!winner) {
          const elapsed = Date.now() - inst.startedAt
          return textResult({
            status: 'running',
            elapsed_ms: elapsed,
            recent_activity: inst.recentActivity.slice(-5).map(a => `${a.tool}: ${a.summary}`),
            hint: `Agent still running after ${Math.round(elapsed / 1000)}s. Call again to keep waiting.`,
          })
        }
      } else if (inst.status === 'running') {
        return textResult({
          status: 'running',
          recent_activity: inst.recentActivity.slice(-5).map(a => `${a.tool}: ${a.summary}`),
          hint: 'Agent is still running. Call again with timeout_ms > 0 to wait.',
        })
      }

      const r = inst.result

      const w = ctx.uiWriter
      if (w && r && (r.inputTokens > 0 || r.outputTokens > 0)) {
        w.write({
          type: 'data-usage',
          data: {
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheWriteTokens: r.cacheWriteTokens,
            iterations: r.iterations,
            toolCallCount: r.toolCalls,
            subagent: inst.type,
          },
        })
      }

      const responseText = r?.responseText || '(Subagent completed but returned no output.)'
      return textResult({
        instance_id: inst.id,
        type: inst.type,
        status: inst.status,
        response: responseText,
        toolCalls: r?.toolCalls ?? 0,
        iterations: r?.iterations ?? 0,
        tokens: r ? { input: r.inputTokens, output: r.outputTokens } : undefined,
      })
    },
  }
}

function createAgentListTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'agent_list',
    description: 'List all registered agent types (built-in and custom) with performance metrics.',
    label: 'List Agents',
    parameters: Type.Object({}),
    execute: async () => {
      const am = ctx.agentManager
      if (!am) return textResult({ error: 'AgentManager not available' })

      const types = am.listTypes(ctx, allToolsGetter())
      const instances = am.listInstances()

      ctx.uiWriter?.write({ type: 'data-agent-types', data: { types } })

      return textResult({ types, active_instances: instances.filter(i => i.status === 'running').length, total_instances: instances.length })
    },
  }
}

function ensureTeamContext(ctx: ToolContext): { teamId: string; agentId: string; isLeader: boolean } | null {
  if (ctx.teamContext) return ctx.teamContext
  const tm = ctx.teamManager
  if (!tm || !ctx.sessionId) return null
  const teams = tm.listTeams(ctx.sessionId)
  if (teams.length === 0) return null
  const team = teams[0]!
  ctx.teamContext = { teamId: team.id, agentId: team.leaderAgentId, isLeader: true }
  if (!ctx.teammateHandles) ctx.teammateHandles = new Map()
  return ctx.teamContext
}

function createTeamCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_create',
    description: 'Create a team of long-lived agent teammates for complex multi-step projects. Teammates persist across turns, communicate via messages, and claim tasks from a shared queue.',
    label: 'Create Team',
    parameters: Type.Object({
      team_name: Type.String({ description: 'Slug name for the team (e.g. "frontend-refactor")' }),
      description: Type.Optional(Type.String({ description: 'Brief description of the team\'s purpose' })),
    }),
    execute: async (_id, params) => {
      const { team_name, description } = params as { team_name: string; description?: string }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })
      if (!ctx.sessionId) return textResult({ error: 'Session ID required for team creation' })

      const existing = tm.getTeam(team_name)
      if (existing) return textResult({ error: `Team "${team_name}" already exists` })

      const leaderAgentId = `team-lead@${team_name}`
      const team = tm.createTeam(team_name, ctx.sessionId, leaderAgentId, { description })

      ctx.teamContext = { teamId: team_name, agentId: leaderAgentId, isLeader: true }
      if (!ctx.teammateHandles) ctx.teammateHandles = new Map()

      ctx.uiWriter?.write({
        type: 'data-team-created',
        data: { teamId: team.id, name: team.name, description, leaderId: leaderAgentId },
      })

      return textResult({
        ok: true,
        team_id: team.id,
        name: team.name,
        leader: leaderAgentId,
        hint: 'Use agent_spawn to add teammates, task_create to define work, send_team_message to communicate.',
      })
    },
  }
}

function createTeamDeleteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'team_delete',
    description: 'Delete a team and kill all running teammates. Cascading delete removes all tasks and messages.',
    label: 'Delete Team',
    parameters: Type.Object({
      team_id: Type.String({ description: 'Team ID to delete' }),
    }),
    execute: async (_id, params) => {
      const { team_id } = params as { team_id: string }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })

      if (ctx.teammateHandles) {
        for (const [id, handle] of ctx.teammateHandles) {
          if (handle.teamId === team_id) {
            handle.kill()
            ctx.teammateHandles.delete(id)
          }
        }
      }

      tm.deleteTeam(team_id)
      if (ctx.teamContext?.teamId === team_id) ctx.teamContext = undefined

      ctx.uiWriter?.write({ type: 'data-team-deleted', data: { teamId: team_id } })

      return textResult({ ok: true, deleted: team_id })
    },
  }
}

function createTaskCreateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_create',
    description: 'Create a task in the team\'s shared task queue. Teammates will automatically claim available tasks when idle.',
    label: 'Create Task',
    parameters: Type.Object({
      subject: Type.String({ description: 'Brief title of the task' }),
      description: Type.String({ description: 'Detailed description of what needs to be done' }),
      blocked_by: Type.Optional(Type.Array(Type.Number(), { description: 'Task IDs that must complete before this task can start' })),
    }),
    execute: async (_id, params) => {
      const { subject, description, blocked_by } = params as { subject: string; description: string; blocked_by?: number[] }
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc) return textResult({ error: 'Not in a team context. Use team_create first.' })

      const task = tm.createTask(tc.teamId, { subject, description })

      if (blocked_by?.length) {
        for (const depId of blocked_by) {
          tm.blockTask(depId, task.id)
        }
      }

      const finalTask = blocked_by?.length ? tm.getTask(task.id) ?? task : task
      ctx.uiWriter?.write({
        type: 'data-team-task',
        data: { teamId: tc.teamId, task: { id: finalTask.id, subject: finalTask.subject, description: finalTask.description, status: finalTask.status, owner: finalTask.owner, blockedBy: finalTask.blockedBy } },
      })

      return textResult({ ok: true, task_id: task.id, subject: task.subject, status: task.status })
    },
  }
}

function createTaskGetTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_get',
    description: 'Get detailed information about a specific task including its dependencies.',
    label: 'Get Task',
    parameters: Type.Object({
      task_id: Type.Number({ description: 'Task ID to retrieve' }),
    }),
    execute: async (_id, params) => {
      const { task_id } = params as { task_id: number }
      const tm = ctx.teamManager
      if (!tm) return textResult({ error: 'Team coordination not available' })
      const task = tm.getTask(task_id)
      if (!task) return textResult({ error: `Task ${task_id} not found` })
      return textResult(task)
    },
  }
}

function createTaskListTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_list',
    description: 'List all tasks in the team\'s queue with their status, owner, and dependencies.',
    label: 'List Tasks',
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc) return textResult({ error: 'Not in a team context.' })
      const tasks = tm.listTasks(tc.teamId)
      return textResult({ tasks: tasks.map(t => ({ id: t.id, subject: t.subject, status: t.status, owner: t.owner, blockedBy: t.blockedBy })) })
    },
  }
}

function createTaskUpdateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'task_update',
    description: 'Update a task\'s status, description, owner, or dependencies. Use to mark tasks in_progress or completed.',
    label: 'Update Task',
    parameters: Type.Object({
      task_id: Type.Number({ description: 'Task ID to update' }),
      status: Type.Optional(Type.String({ description: 'New status: pending, in_progress, completed, deleted' })),
      subject: Type.Optional(Type.String({ description: 'Updated subject' })),
      description: Type.Optional(Type.String({ description: 'Updated description' })),
      owner: Type.Optional(Type.String({ description: 'Agent ID to assign as owner' })),
      add_blocks: Type.Optional(Type.Array(Type.Number(), { description: 'Task IDs that this task blocks' })),
      add_blocked_by: Type.Optional(Type.Array(Type.Number(), { description: 'Task IDs that block this task' })),
    }),
    execute: async (_id, params) => {
      const { task_id, ...updates } = params as any
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm) return textResult({ error: 'Team coordination not available' })

      if (updates.status === 'in_progress' && !updates.owner && tc) {
        updates.owner = tc.agentId
      }

      const task = tm.updateTask(task_id, {
        status: updates.status,
        subject: updates.subject,
        description: updates.description,
        owner: updates.owner,
        addBlocks: updates.add_blocks,
        addBlockedBy: updates.add_blocked_by,
      })

      if (!task) return textResult({ error: `Task ${task_id} not found` })

      if (updates.owner && tc) {
        tm.writeMessage(tc.teamId, updates.owner, tc.agentId, {
          type: 'task_assignment',
          message: JSON.stringify({ taskId: task.id, subject: task.subject, description: task.description }),
          summary: `Assigned: ${task.subject}`,
        })
      }

      ctx.uiWriter?.write({
        type: 'data-team-task',
        data: { teamId: task.teamId, task: { id: task.id, subject: task.subject, description: task.description, status: task.status, owner: task.owner, blockedBy: task.blockedBy } },
      })

      return textResult({ ok: true, task_id: task.id, status: task.status, owner: task.owner })
    },
  }
}

function createSendTeamMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_team_message',
    description: 'Send a message to a teammate, the team lead, or broadcast to all team members. Use structured message types for shutdown negotiation.',
    label: 'Send Team Message',
    parameters: Type.Object({
      to: Type.String({ description: 'Recipient: teammate name, "team-lead", or "*" for broadcast' }),
      message: Type.String({ description: 'Message text or JSON for structured messages' }),
      summary: Type.Optional(Type.String({ description: 'Brief summary of the message' })),
      message_type: Type.Optional(Type.String({ description: 'Message type: text, shutdown_request, shutdown_response (default: text)' })),
    }),
    execute: async (_id, params) => {
      const { to, message, summary, message_type } = params as { to: string; message: string; summary?: string; message_type?: string }
      const tm = ctx.teamManager
      const tc = ensureTeamContext(ctx)
      if (!tm || !tc) return textResult({ error: 'Not in a team context.' })

      let toAgent = to
      if (to === 'team-lead') {
        toAgent = `team-lead@${tc.teamId}`
      } else if (to !== '*' && !to.includes('@')) {
        toAgent = `${to}@${tc.teamId}`
      }

      const msgType = (message_type || 'text') as any

      tm.writeMessage(tc.teamId, toAgent, tc.agentId, {
        type: msgType,
        message,
        summary,
      })

      ctx.uiWriter?.write({
        type: 'data-team-message',
        data: { teamId: tc.teamId, from: tc.agentId, to: toAgent, messageType: msgType, message, summary },
      })

      // Handle shutdown response (approved) — kill the teammate
      if (msgType === 'shutdown_response') {
        try {
          const parsed = JSON.parse(message)
          if (parsed.approve && ctx.teammateHandles) {
            const handle = ctx.teammateHandles.get(tc.agentId)
            if (handle) {
              handle.kill()
              ctx.teammateHandles.delete(tc.agentId)
            }
          }
        } catch { /* not JSON, ignore */ }
      }

      return textResult({ ok: true, sent_to: toAgent, type: msgType })
    },
  }
}

/** All gateway tools (unified set). Includes base tools + agent_* orchestration tools. */
export function createTools(ctx: ToolContext, extraTools?: AgentTool[]): AgentTool[] {
  const pe = ctx.permissionEngine
  const g = (tool: AgentTool, cat: import('./types').PermissionCategory) => applyPermissionGate(tool, cat, pe)

  const tools: AgentTool[] = [
    g(createExecTool(ctx), 'shell'),
    g(createReadFileTool(ctx), 'file_read'),
    g(createWriteFileTool(ctx), 'file_write'),
    g(createEditFileTool(ctx), 'file_write'),
    g(createGlobTool(ctx), 'file_read'),
    g(createGrepTool(ctx), 'file_read'),
    g(createLsTool(ctx), 'file_read'),
    g(createListFilesTool(ctx), 'file_read'),
    g(createDeleteFileTool(ctx), 'file_delete'),
    g(createSearchTool(ctx), 'file_read'),
    g(createImpactRadiusTool(ctx), 'file_read'),
    g(createDetectChangesTool(ctx), 'file_read'),
    g(createReviewContextTool(ctx), 'file_read'),
    g(createWebTool(), 'network'),
    g(createBrowserTool(ctx), 'network'),
    createMemoryReadTool(ctx),
    createMemorySearchTool(ctx),
    createTodoWriteTool(ctx),
    createAskUserTool(ctx),
    createNotifyUserErrorTool(),
    createSendMessageTool(ctx),
    createChannelConnectTool(ctx),
    createChannelDisconnectTool(ctx),
    createChannelListTool(ctx),
    createReadLintsTool(ctx),
    createSkillServerSyncTool(ctx),
    createToolSearchTool(ctx),
    createToolInstallTool(ctx),
    createToolUninstallTool(ctx),
    createMcpSearchTool(),
    createMcpInstallTool(ctx),
    createMcpUninstallTool(ctx),
    g(createGenerateImageTool(ctx), 'network'),
    g(createTranscribeAudioTool(ctx), 'network'),
    createHeartbeatConfigureTool(ctx),
    createHeartbeatStatusTool(ctx),
    createCreatePlanTool(ctx),
  ]

  const allToolsGetter = () => tools
  tools.push(createSkillTool(ctx, allToolsGetter))

  // Agent orchestration tools
  tools.push(createAgentCreateTool(ctx))
  tools.push(createAgentSpawnTool(ctx, allToolsGetter))
  tools.push(createAgentStatusTool(ctx))
  tools.push(createAgentCancelTool(ctx))
  tools.push(createAgentResultTool(ctx))
  tools.push(createAgentListTool(ctx, allToolsGetter))

  // Team coordination tools
  tools.push(createTeamCreateTool(ctx))
  tools.push(createTeamDeleteTool(ctx))
  tools.push(createTaskCreateTool(ctx))
  tools.push(createTaskGetTool(ctx))
  tools.push(createTaskListTool(ctx))
  tools.push(createTaskUpdateTool(ctx))
  tools.push(createSendTeamMessageTool(ctx))

  if (extraTools) {
    tools.push(...extraTools)
  }

  return tools
}

// ---------------------------------------------------------------------------
// Skill Tool (unified .shogo/skills/ format)
// ---------------------------------------------------------------------------

import type { Skill } from './skills'

let loadedSkillsList: Skill[] | null = null

export function setLoadedSkills(skills: Skill[]): void {
  loadedSkillsList = skills
}

export function getLoadedSkills(): Skill[] {
  return loadedSkillsList || []
}

/** @deprecated Use setLoadedSkills instead */
export function setLoadedClaudeSkills(skills: Skill[]): void {
  setLoadedSkills(skills)
}

/** @deprecated Use getLoadedSkills instead */
export function getLoadedClaudeSkills(): Skill[] {
  return getLoadedSkills()
}

/** @deprecated Use Skill from ./skills instead */
export type LoadedSkillEntry = Skill

function inferRuntime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = { py: 'python3', js: 'node', ts: 'bun', mjs: 'node', cjs: 'node', sh: 'bash' }
  return map[ext || ''] || 'bash'
}

function createSkillTool(ctx: ToolContext, allToolsGetter: () => AgentTool[]): AgentTool {
  return {
    name: 'skill',
    description:
      'Manage and invoke skills. Default action is "invoke" — runs a skill by name. ' +
      'Use action "search" to find skills in the registry (CRO, SEO, copywriting, automation, dev tools, and 800+ more). ' +
      'Use action "install" to install a registry skill into the workspace. ' +
      'Use action "run_script" to execute a script from a skill\'s scripts/ directory.',
    label: 'Skill',
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: 'Action: "invoke" (default), "search", "install", or "run_script"' })),
      skill: Type.Optional(Type.String({ description: 'Skill name (for invoke/run_script action)' })),
      args: Type.Optional(Type.String({ description: 'Arguments to pass to the skill or script' })),
      script: Type.Optional(Type.String({ description: 'Script filename to execute (for run_script action, e.g. "score.py")' })),
      query: Type.Optional(Type.String({ description: 'Search query (for search action)' })),
      source: Type.Optional(Type.String({ description: 'Source id (for install action, from search results)' })),
      dir_name: Type.Optional(Type.String({ description: 'Directory name (for install action, from search results)' })),
    }),
    execute: async (_toolCallId, params, context) => {
      const { action = 'invoke', skill: skillName, args, script, query, source, dir_name: dirName } = params as {
        action?: string; skill?: string; args?: string; script?: string; query?: string; source?: string; dir_name?: string
      }

      // --- Search: find skills in the registry ---
      if (action === 'search') {
        const { loadSkillRegistryManifest } = require('./skills') as typeof import('./skills')
        const manifest = loadSkillRegistryManifest()
        if (manifest.length === 0) {
          return textResult({ results: [], message: 'No external skills available in the registry.' })
        }

        if (!query) {
          return textResult({
            total: manifest.length,
            results: manifest.slice(0, 20),
            message: `${manifest.length} skills available. Provide a query to filter.`,
          })
        }

        const q = query.toLowerCase()
        const matches = manifest.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.source.toLowerCase().includes(q) ||
          s.sourceDescription.toLowerCase().includes(q)
        )
        return textResult({
          query,
          total: matches.length,
          results: matches.slice(0, 20),
          message: matches.length > 20 ? `Showing 20 of ${matches.length} matches. Refine your query.` : undefined,
        })
      }

      // --- Install: install a registry skill into the workspace ---
      if (action === 'install') {
        if (!source || !dirName) {
          return textResult({ error: 'source and dir_name are required (from search results).' })
        }

        const { loadBundledClaudeCodeSkill } = require('./skills') as typeof import('./skills')
        const skill = loadBundledClaudeCodeSkill(source, dirName)
        if (!skill) {
          return textResult({ error: `Skill "${dirName}" not found in source "${source}".` })
        }

        const destDir = join(ctx.workspaceDir, '.shogo', 'skills', skill.name)
        mkdirSync(destDir, { recursive: true })
        const srcDir = skill.skillDir
        for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
          const srcPath = join(srcDir, entry.name)
          const destPath = join(destDir, entry.name)
          if (entry.isDirectory()) {
            const { cpSync } = require('fs')
            cpSync(srcPath, destPath, { recursive: true })
          } else {
            writeFileSync(destPath, readFileSync(srcPath))
          }
        }

        return textResult({
          installed: skill.name,
          source,
          description: skill.description,
          message: `Skill "${skill.name}" installed. Use skill({ skill: "${skill.name}" }) to invoke it.`,
        })
      }

      // --- Run Script: execute a script from a skill's scripts/ directory ---
      if (action === 'run_script') {
        if (!skillName || !script) {
          return textResult({ error: 'skill and script parameters are required for run_script action.' })
        }

        if (script.includes('..') || script.includes('/')) {
          return textResult({ error: 'Invalid script filename.' })
        }

        const skills = getLoadedSkills()
        const found = skills.find(s => s.name === skillName)
        if (!found) {
          return textResult({ error: `Skill not found: ${skillName}` })
        }

        const scriptPath = join(found.skillDir, 'scripts', script)
        if (!existsSync(scriptPath)) {
          return textResult({
            error: `Script "${script}" not found in skill "${skillName}".`,
            available: found.scripts || [],
          })
        }

        const runtime = found.runtime || inferRuntime(script)
        const command = args ? `${runtime} ${scriptPath} ${args}` : `${runtime} ${scriptPath}`

        try {
          const { sandboxExec } = require('./sandbox-exec') as typeof import('./sandbox-exec')
          const result = sandboxExec({
            command,
            workspaceDir: ctx.workspaceDir,
            timeout: 30000,
            sandboxConfig: ctx.sandbox,
            sessionId: ctx.sessionId,
            mainSessionIds: ctx.mainSessionIds,
          })

          return textResult({
            skill: skillName,
            script,
            runtime,
            exitCode: result.exitCode,
            stdout: result.stdout?.substring(0, 8000) || '',
            stderr: result.stderr?.substring(0, 4000) || '',
          })
        } catch (err: any) {
          return textResult({ error: `Script execution failed: ${err.message}` })
        }
      }

      // --- Invoke (default): run a skill by name ---
      if (!skillName) {
        return textResult({ error: 'skill name is required for invoke action.' })
      }

      const skills = getLoadedSkills()
      const found = skills.find(s => s.name === skillName)
      if (!found) {
        return textResult({
          error: `Skill not found: ${skillName}. Available: ${skills.map(s => s.name).join(', ')}`,
          hint: 'Use skill({ action: "search", query: "..." }) to find and install new skills.',
        })
      }

      // Run setup on first invoke if configured
      if (found.setup && !existsSync(join(found.skillDir, '.setup-done'))) {
        try {
          const { sandboxExec } = require('./sandbox-exec') as typeof import('./sandbox-exec')
          const setupResult = sandboxExec({
            command: found.setup,
            workspaceDir: found.skillDir,
            timeout: 60000,
            sandboxConfig: ctx.sandbox,
            sessionId: ctx.sessionId,
            mainSessionIds: ctx.mainSessionIds,
          })
          if (setupResult.exitCode === 0) {
            writeFileSync(join(found.skillDir, '.setup-done'), new Date().toISOString(), 'utf-8')
          }
        } catch { /* setup is best-effort */ }
      }

      let content = found.content

      // $ARGUMENTS substitution
      if (args) {
        const argParts = args.split(/\s+/)
        content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => argParts[parseInt(idx)] || '')
        content = content.replace(/\$(\d+)/g, (_, idx) => argParts[parseInt(idx)] || '')
        content = content.replace(/\$ARGUMENTS/g, args)
      } else {
        content = content.replace(/\$ARGUMENTS\[\d+\]/g, '')
        content = content.replace(/\$\d+/g, '')
        content = content.replace(/\$ARGUMENTS/g, '')
      }

      // ${CLAUDE_SKILL_DIR} and ${SKILL_DIR} substitution
      content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, found.skillDir)
      content = content.replace(/\$\{SKILL_DIR\}/g, found.skillDir)

      // If context: fork, run in a subagent
      if (found.context === 'fork') {
        const agentType = found.agent || 'general-purpose'
        const subConfig: SubagentConfig = {
          name: `skill-${skillName}`,
          description: `Executing skill: ${found.description}`,
          systemPrompt: content,
          model: undefined,
          disallowedTools: ['task'],
        }

        const builtIn = getBuiltinSubagentConfig(agentType, ctx, allToolsGetter())
        if (builtIn) {
          subConfig.toolNames = builtIn.toolNames
          subConfig.model = builtIn.model
        }

        const result = await runSubagent(subConfig, content, ctx, allToolsGetter())
        return textResult({
          skill: skillName,
          mode: 'fork',
          agent: agentType,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
        })
      }

      // Inline mode: return content for the agent to use as context
      return textResult({
        skill: skillName,
        mode: 'inline',
        content,
        instruction: 'Follow the skill instructions above to complete the task.',
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Tool Group Mapping
// ---------------------------------------------------------------------------

/**
 * Maps group names (used in skill frontmatter) to individual gateway tool names.
 * Skills can reference either group names or individual tool names.
 */
export const TOOL_GROUP_MAP: Record<string, string[]> = {
  shell: ['exec'],
  filesystem: ['read_file', 'write_file', 'edit_file', 'read_lints'],
  files: ['list_files', 'delete_file', 'search', 'read_file', 'write_file', 'edit_file', 'read_lints'],
  search: ['glob', 'grep', 'search', 'impact_radius'],
  code_analysis: ['impact_radius'],
  planning: ['todo_write'],
  web: ['web'],
  web_fetch: ['web'],
  web_search: ['web'],
  browser: ['browser', 'web'],
  memory: ['memory_read', 'memory_search'],
  messaging: ['send_message', 'channel_connect', 'channel_disconnect', 'channel_list'],
  heartbeat: ['heartbeat_configure', 'heartbeat_status'],
  tool_discovery: ['tool_search', 'tool_install', 'tool_uninstall'],
  mcp_discovery: ['mcp_search', 'mcp_install', 'mcp_uninstall'],
  audio: ['transcribe_audio'],
}

export const ALL_TOOL_NAMES = [
  'exec', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'ls', 'web', 'browser',
  'list_files', 'delete_file', 'search', 'impact_radius', 'detect_changes', 'review_context',
  'todo_write', 'ask_user', 'notify_user_error', 'skill',
  'memory_read', 'memory_search', 'send_message', 'channel_connect', 'channel_disconnect', 'channel_list',
  'heartbeat_configure', 'heartbeat_status',
  'read_lints', 'skill_server_sync',
  'tool_search', 'tool_install', 'tool_uninstall',
  'mcp_search', 'mcp_install', 'mcp_uninstall',
  'transcribe_audio',
] as const

/**
 * Resolve a list of tool references (group names or individual names)
 * to a deduplicated list of individual gateway tool names.
 */
export function resolveToolNames(refs: string[]): string[] {
  const resolved = new Set<string>()
  for (const ref of refs) {
    const group = TOOL_GROUP_MAP[ref]
    if (group) {
      for (const name of group) resolved.add(name)
    } else if ((ALL_TOOL_NAMES as readonly string[]).includes(ref)) {
      resolved.add(ref)
    } else if (ref.startsWith('mcp_')) {
      resolved.add(ref)
    }
  }
  return [...resolved]
}

// ---------------------------------------------------------------------------
// File Management Tools (files/ directory with RAG search)
// ---------------------------------------------------------------------------

function getOrCreateIndex(ctx: ToolContext): IndexEngine {
  if (!ctx.indexEngine) {
    ctx.indexEngine = new IndexEngine(createDefaultConfig(ctx.workspaceDir))
  }
  return ctx.indexEngine
}

function createListFilesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'list_files',
    description:
      'List files and directories in the workspace files/ directory. ' +
      'Supports recursive listing and returns file metadata.',
    label: 'List Files',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Subdirectory path within files/ (default: root)' })),
      recursive: Type.Optional(Type.Boolean({ description: 'List recursively (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: subPath = '', recursive = false } = params as { path?: string; recursive?: boolean }
      const filesDir = join(ctx.workspaceDir, 'files')
      mkdirSync(filesDir, { recursive: true })

      const targetDir = subPath ? join(filesDir, subPath) : filesDir
      const resolved = resolve(targetDir)
      if (!resolved.startsWith(resolve(filesDir))) {
        return textResult({ error: 'Path outside files directory' })
      }
      if (!existsSync(resolved)) {
        return textResult({ error: `Directory not found: ${subPath || '/'}` })
      }

      const entries = listDirEntries(resolved, resolve(filesDir), recursive)
      return textResult({ path: subPath || '/', entries, count: entries.length })
    },
  }
}

function listDirEntries(dir: string, rootDir: string, recursive: boolean): any[] {
  const results: any[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const absPath = join(dir, entry.name)
    const relPath = absPath.slice(rootDir.length + 1)
    const stat = statSync(absPath)

    if (entry.isDirectory()) {
      results.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        modified: stat.mtimeMs,
      })
      if (recursive) {
        results.push(...listDirEntries(absPath, rootDir, true))
      }
    } else {
      results.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modified: stat.mtimeMs,
      })
    }
  }
  return results
}

function createDeleteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'delete_file',
    description: 'Delete a file from the workspace files/ directory.',
    label: 'Delete File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to files/' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      const filesDir = join(ctx.workspaceDir, 'files')
      const resolved = resolve(filesDir, filePath)

      if (!resolved.startsWith(resolve(filesDir))) {
        return textResult({ error: 'Path outside files directory' })
      }
      if (!existsSync(resolved)) {
        return textResult({ error: `File not found: ${filePath}` })
      }

      unlinkSync(resolved)
      ctx.fileStateCache?.invalidate(filePath)
      ctx.fileStateCache?.invalidate(`files/${filePath}`)
      ctx.canvasFileWatcher?.onFileDeleted(filePath)
      return textResult({ ok: true, deleted: filePath })
    },
  }
}

function createSearchTool(ctx: ToolContext): AgentTool {
  return {
    name: 'search',
    description:
      'Semantic search across the workspace. Searches code AND uploaded files by default. ' +
      'Finds content by meaning, not just exact text. ' +
      'Use for questions like "where is X implemented?", "find tests for Y", "what module handles Z?", ' +
      'or "find revenue numbers in my data". ' +
      'Returns ranked chunks with file paths and line numbers. ' +
      'Prefer this over grep when exploring unfamiliar code or searching by concept rather than exact string. ' +
      'Use source="code" to search only code, source="files" to search only uploaded files in files/.',
    label: 'Search',
    parameters: Type.Object({
      query: Type.String({ description: 'Natural language search query' }),
      source: Type.Optional(Type.Union([
        Type.Literal('all'),
        Type.Literal('code'),
        Type.Literal('files'),
      ], { description: 'Which index to search: "all" (default), "code", or "files"' })),
      limit: Type.Optional(Type.Number({ description: 'Max results (default: 10)' })),
      path_filter: Type.Optional(Type.String({ description: 'Restrict to files matching this substring (e.g. "test", "src/rules", "files/")' })),
      file_extensions: Type.Optional(Type.Array(Type.String(), { description: 'Restrict to these extensions (e.g. [".py", ".ts", ".csv"])' })),
    }),
    execute: async (_toolCallId, params) => {
      const { query, source, limit = 10, path_filter, file_extensions } = params as {
        query: string; source?: 'all' | 'code' | 'files'; limit?: number; path_filter?: string; file_extensions?: string[]
      }
      const engine = getOrCreateIndex(ctx)
      const searchSource = source === 'all' || !source ? undefined : source
      const results = await engine.search(query, { source: searchSource, limit, pathFilter: path_filter, extensions: file_extensions })
      return textResult({
        query,
        source: source ?? 'all',
        results: results.map(r => ({
          path: r.path,
          chunk: r.chunk,
          score: Math.round(r.score * 1000) / 1000,
          lines: `${r.lineStart}-${r.lineEnd}`,
          matchType: r.matchType,
        })),
        count: results.length,
        stats: engine.getStats(searchSource),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Impact Radius Tool (knowledge graph blast-radius analysis)
// ---------------------------------------------------------------------------

function getOrCreateGraph(ctx: ToolContext): import('./workspace-graph').WorkspaceGraph | null {
  if (ctx.workspaceGraph) return ctx.workspaceGraph

  try {
    const engine = getOrCreateIndex(ctx)
    const { WorkspaceGraph } = require('./workspace-graph')
    const { createDefaultExtractors } = require('./graph-extractors')
    const graph = new WorkspaceGraph(engine)
    for (const ext of createDefaultExtractors()) graph.registerExtractor(ext)
    graph.buildGraph()
    engine.setGraph(graph)
    ctx.workspaceGraph = graph
    return graph
  } catch {
    return null
  }
}

function createImpactRadiusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'impact_radius',
    description:
      'Find all files and symbols affected by changes to given files. ' +
      'Shows blast radius: callers, dependents, importers, and related documents. ' +
      'Useful before making changes to understand what else might break or need updating.',
    label: 'Impact Radius',
    parameters: Type.Object({
      files: Type.Array(Type.String(), { description: 'File paths to check (relative to workspace root)' }),
      max_depth: Type.Optional(Type.Number({ description: 'BFS traversal depth (default: 2)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { files, max_depth = 2 } = params as { files: string[]; max_depth?: number }

      const graph = getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({ error: 'Knowledge graph not available. The workspace graph could not be initialized.' })
      }

      const result = graph.getImpactRadius(files, max_depth)

      return textResult({
        analyzed_files: files,
        depth: max_depth,
        changed_nodes: result.changedNodes.map(n => ({
          kind: n.kind, name: n.name, file: n.filePath,
        })),
        impacted_files: result.impactedFiles,
        impacted_nodes: result.impactedNodes.slice(0, 50).map(n => ({
          kind: n.kind, name: n.name, file: n.filePath,
        })),
        edges: result.edges.slice(0, 100).map(e => ({
          kind: e.kind,
          from: e.sourceQualified.split('::').pop(),
          to: e.targetQualified.split('::').pop(),
        })),
        total_impacted: result.totalImpacted,
        truncated: result.truncated,
        graph_stats: graph.getStats(),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Detect Changes Tool
// ---------------------------------------------------------------------------

function createDetectChangesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'detect_changes',
    description:
      'Analyze git changes and map them to code graph nodes. Shows which functions/classes changed, ' +
      'their risk scores, affected execution flows, and test gaps. ' +
      'Use before code review to understand change impact.',
    label: 'Detect Changes',
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: 'Git ref to diff against (default: "HEAD~1")' })),
      changed_files: Type.Optional(Type.Array(Type.String(), { description: 'Explicit file list (skips git diff if provided)' })),
      include_source: Type.Optional(Type.Boolean({ description: 'Include source snippets for changed nodes (default: false)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { base = 'HEAD~1', changed_files, include_source = false } = params as {
        base?: string; changed_files?: string[]; include_source?: boolean
      }

      const graph = getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({ error: 'Knowledge graph not available.' })
      }

      const { execSync } = require('child_process')
      const { readFileSync } = require('fs')
      const cwd = ctx.workspaceDir

      let changedFilePaths: string[]
      if (changed_files && changed_files.length > 0) {
        changedFilePaths = changed_files
      } else {
        try {
          const out = execSync(`git diff --name-only ${base}`, { cwd, encoding: 'utf-8' }).trim()
          changedFilePaths = out ? out.split('\n').filter(Boolean) : []
        } catch {
          return textResult({ error: `Failed to run git diff against ${base}. Is this a git repo?` })
        }
      }

      if (changedFilePaths.length === 0) {
        return textResult({ summary: 'No changes detected', changed_files: [], risk_score: 0 })
      }

      // Parse line ranges from unified diff
      let lineRanges: Map<string, Array<{ start: number; end: number }>> = new Map()
      try {
        const diffOut = execSync(`git diff --unified=0 ${base}`, { cwd, encoding: 'utf-8' })
        let currentFile = ''
        for (const line of diffOut.split('\n')) {
          if (line.startsWith('+++ b/')) {
            currentFile = line.slice(6)
          } else if (line.startsWith('@@')) {
            const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
            if (match && currentFile) {
              const start = parseInt(match[1], 10)
              const count = parseInt(match[2] || '1', 10)
              if (!lineRanges.has(currentFile)) lineRanges.set(currentFile, [])
              lineRanges.get(currentFile)!.push({ start, end: start + count - 1 })
            }
          }
        }
      } catch { /* non-fatal */ }

      // Map line ranges to graph nodes
      const changedFunctions: any[] = []
      const { computeRiskScore } = require('./risk-scorer')
      const { getAffectedFlows } = require('./flow-detector')

      for (const fp of changedFilePaths) {
        const fileNodes = graph.getNodesByFile(fp)
        const ranges = lineRanges.get(fp) || []

        for (const node of fileNodes) {
          if (node.kind === 'File') continue

          const overlaps = ranges.length === 0 || ranges.some(r =>
            node.lineStart != null && node.lineEnd != null &&
            node.lineStart <= r.end && node.lineEnd >= r.start
          )

          if (overlaps) {
            const risk = computeRiskScore(graph, node)
            const testedBy = graph.getEdgesBySource(node.qualifiedName, 'TESTED_BY')
            const entry: any = {
              kind: node.kind, name: node.name, file: node.filePath,
              lines: node.lineStart && node.lineEnd ? `${node.lineStart}-${node.lineEnd}` : null,
              risk: Math.round(risk * 1000) / 1000,
              tested: testedBy.length > 0,
              test_count: testedBy.length,
            }
            if (include_source && node.lineStart && node.lineEnd) {
              try {
                const { join } = require('path')
                const absPath = join(cwd, fp)
                const lines = readFileSync(absPath, 'utf-8').split('\n')
                const start = Math.max(0, node.lineStart - 1)
                const end = Math.min(lines.length, node.lineEnd)
                entry.source = lines.slice(start, end).join('\n').substring(0, 2000)
              } catch { /* non-fatal */ }
            }
            changedFunctions.push(entry)
          }
        }
      }

      // Aggregate risk
      const { computeFileSetRisk } = require('./risk-scorer')
      const riskInfo = computeFileSetRisk(graph, changedFilePaths)

      // Affected flows
      const affectedFlows = getAffectedFlows(graph, changedFilePaths)

      // Test gaps: changed non-test nodes without TESTED_BY
      const testGaps = changedFunctions.filter(f => !f.tested && f.kind !== 'Test')

      return textResult({
        summary: `${changedFilePaths.length} files changed, ${changedFunctions.length} functions affected`,
        risk_score: riskInfo.maxRisk,
        avg_risk: riskInfo.avgRisk,
        changed_files: changedFilePaths,
        changed_functions: changedFunctions.slice(0, 100),
        affected_flows: affectedFlows.slice(0, 20).map((f: any) => ({
          name: f.name, criticality: f.criticality, node_count: f.node_count,
        })),
        test_gaps: testGaps.slice(0, 50).map((f: any) => ({
          name: f.name, file: f.file, risk: f.risk,
        })),
        review_priorities: changedFunctions
          .sort((a: any, b: any) => b.risk - a.risk)
          .slice(0, 10)
          .map((f: any) => ({ name: f.name, file: f.file, risk: f.risk, tested: f.tested })),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Review Context Tool
// ---------------------------------------------------------------------------

function createReviewContextTool(ctx: ToolContext): AgentTool {
  return {
    name: 'review_context',
    description:
      'Get a comprehensive, token-optimized review bundle for changed files. ' +
      'Includes structural subgraph, risk scores, affected flows, test gaps, ' +
      'truncated source hunks around affected nodes, and review guidance. ' +
      'Use this when reviewing a PR or set of changes.',
    label: 'Review Context',
    parameters: Type.Object({
      changed_files: Type.Optional(Type.Array(Type.String(), { description: 'Explicit file list (skips git diff if provided)' })),
      base: Type.Optional(Type.String({ description: 'Git ref to diff against (default: "HEAD~1")' })),
      max_depth: Type.Optional(Type.Number({ description: 'Impact radius BFS depth (default: 2)' })),
      include_source: Type.Optional(Type.Boolean({ description: 'Include source hunks (default: true)' })),
      max_lines_per_file: Type.Optional(Type.Number({ description: 'Max source lines per file (default: 200)' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        changed_files, base = 'HEAD~1', max_depth = 2,
        include_source = true, max_lines_per_file = 200,
      } = params as {
        changed_files?: string[]; base?: string; max_depth?: number;
        include_source?: boolean; max_lines_per_file?: number
      }

      const graph = getOrCreateGraph(ctx)
      if (!graph) {
        return textResult({ error: 'Knowledge graph not available.' })
      }

      const { execSync } = require('child_process')
      const { readFileSync, existsSync } = require('fs')
      const { join } = require('path')
      const cwd = ctx.workspaceDir

      // Step 1: Get changed files
      let filePaths: string[]
      if (changed_files && changed_files.length > 0) {
        filePaths = changed_files
      } else {
        try {
          const out = execSync(`git diff --name-only ${base}`, { cwd, encoding: 'utf-8' }).trim()
          filePaths = out ? out.split('\n').filter(Boolean) : []
        } catch {
          return textResult({ error: `Failed to run git diff against ${base}.` })
        }
      }

      if (filePaths.length === 0) {
        return textResult({ summary: 'No changes detected' })
      }

      // Step 2: Impact radius
      const impact = graph.getImpactRadius(filePaths, max_depth)

      // Step 3: Risk + flows + test gaps
      const { computeRiskScore, computeFileSetRisk } = require('./risk-scorer')
      const { getAffectedFlows } = require('./flow-detector')

      const riskInfo = computeFileSetRisk(graph, filePaths)
      const affectedFlows = getAffectedFlows(graph, filePaths)

      // Build per-node risk + test info for changed nodes
      const changedNodeDetails: any[] = []
      for (const node of impact.changedNodes) {
        if (node.kind === 'File') continue
        const risk = computeRiskScore(graph, node)
        const testedBy = graph.getEdgesBySource(node.qualifiedName, 'TESTED_BY')
        changedNodeDetails.push({
          kind: node.kind, name: node.name, file: node.filePath,
          lines: node.lineStart && node.lineEnd ? `${node.lineStart}-${node.lineEnd}` : null,
          risk: Math.round(risk * 1000) / 1000,
          tested: testedBy.length > 0,
        })
      }

      // Step 4: Source hunks
      const sourceHunks: any[] = []
      if (include_source) {
        for (const fp of filePaths) {
          const absPath = join(cwd, fp)
          if (!existsSync(absPath)) continue
          try {
            const content = readFileSync(absPath, 'utf-8')
            const lines = content.split('\n')
            const fileNodes = graph.getNodesByFile(fp).filter((n: any) => n.kind !== 'File')

            if (fileNodes.length === 0) {
              const truncated = lines.slice(0, max_lines_per_file).join('\n')
              sourceHunks.push({ file: fp, lines: `1-${Math.min(lines.length, max_lines_per_file)}`, content: truncated })
              continue
            }

            // Build merged ranges around affected nodes (+-2 lines context)
            const ranges: Array<{ start: number; end: number }> = []
            for (const node of fileNodes) {
              if (node.lineStart == null || node.lineEnd == null) continue
              ranges.push({
                start: Math.max(1, node.lineStart - 2),
                end: Math.min(lines.length, node.lineEnd + 2),
              })
            }
            ranges.sort((a, b) => a.start - b.start)

            // Merge overlapping ranges
            const merged: typeof ranges = []
            for (const r of ranges) {
              if (merged.length > 0 && r.start <= merged[merged.length - 1].end + 1) {
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end)
              } else {
                merged.push({ ...r })
              }
            }

            let totalLines = 0
            for (const r of merged) {
              if (totalLines >= max_lines_per_file) break
              const chunk = lines.slice(r.start - 1, r.end).join('\n')
              sourceHunks.push({ file: fp, lines: `${r.start}-${r.end}`, content: chunk })
              totalLines += r.end - r.start + 1
            }
          } catch { /* non-fatal */ }
        }
      }

      // Step 5: Review guidance
      const guidance: string[] = []
      const untestedFns = changedNodeDetails.filter(n => !n.tested && n.kind === 'Function')
      if (untestedFns.length > 0) {
        guidance.push(`${untestedFns.length} changed function(s) have no test coverage: ${untestedFns.map(n => n.name).join(', ')}`)
      }
      if (impact.impactedFiles.length > 5) {
        guidance.push(`Wide blast radius: ${impact.impactedFiles.length} files impacted — consider incremental deployment`)
      }
      const inheritanceEdges = impact.edges.filter(e => e.kind === 'INHERITS')
      if (inheritanceEdges.length > 0) {
        guidance.push(`Inheritance chain affected — verify subclass contract compatibility`)
      }
      if (riskInfo.maxRisk > 0.7) {
        guidance.push(`High risk score (${riskInfo.maxRisk}) — pay extra attention to security-sensitive functions`)
      }
      if (affectedFlows.length > 3) {
        guidance.push(`${affectedFlows.length} execution flows affected — consider integration testing`)
      }

      return textResult({
        changed_files: filePaths,
        risk_score: riskInfo.maxRisk,
        avg_risk: riskInfo.avgRisk,
        changed_nodes: changedNodeDetails.slice(0, 50),
        impacted_files: impact.impactedFiles.slice(0, 30),
        impacted_nodes: impact.impactedNodes.slice(0, 30).map(n => ({
          kind: n.kind, name: n.name, file: n.filePath,
        })),
        edges: impact.edges.slice(0, 60).map(e => ({
          kind: e.kind,
          from: e.sourceQualified.split('::').pop(),
          to: e.targetQualified.split('::').pop(),
        })),
        source_hunks: sourceHunks.slice(0, 30),
        affected_flows: affectedFlows.slice(0, 15).map((f: any) => ({
          name: f.name, criticality: f.criticality, node_count: f.node_count, file_count: f.file_count,
        })),
        test_gaps: changedNodeDetails.filter(n => !n.tested && n.kind !== 'Test').slice(0, 30).map(n => ({
          name: n.name, file: n.file, risk: n.risk,
        })),
        review_guidance: guidance,
        total_impacted: impact.totalImpacted,
        truncated: impact.truncated,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Channel Connect Tool
// ---------------------------------------------------------------------------

const CHANNEL_SETUP_GUIDES: Record<string, { requiredKeys: string[]; guide: string }> = {
  telegram: {
    requiredKeys: ['botToken'],
    guide: [
      '## Telegram Setup',
      '1. Open Telegram and message @BotFather',
      '2. Send /newbot and follow the prompts to create a bot',
      '3. Copy the bot token (looks like 123456:ABC-DEF...)',
      '4. Connect: channel_connect({ type: "telegram", config: { botToken: "YOUR_TOKEN" } })',
    ].join('\n'),
  },
  discord: {
    requiredKeys: ['botToken', 'guildId'],
    guide: [
      '## Discord Setup',
      '1. Go to https://discord.com/developers/applications and create a New Application',
      '2. Go to Bot tab → click "Add Bot" → copy the bot token',
      '3. Go to Bot tab → enable "Message Content Intent" under Privileged Gateway Intents',
      '4. Go to OAuth2 → URL Generator → select "bot" scope + "Send Messages" + "Read Messages" permissions',
      '5. Open the generated URL to invite the bot to your server',
      '6. Get the guild (server) ID: enable Developer Mode in Discord settings, right-click the server → Copy Server ID',
      '7. Connect: channel_connect({ type: "discord", config: { botToken: "YOUR_TOKEN", guildId: "SERVER_ID" } })',
    ].join('\n'),
  },
  slack: {
    requiredKeys: ['botToken', 'appToken'],
    guide: [
      '## Slack Setup',
      '1. Go to https://api.slack.com/apps and click "Create New App" → "From scratch"',
      '2. Under OAuth & Permissions, add these Bot Token Scopes: chat:write, channels:history, channels:read, groups:history, im:history, mpim:history',
      '3. Install the app to your workspace → copy the Bot User OAuth Token (xoxb-...)',
      '4. Under Basic Information → App-Level Tokens → "Generate Token" with connections:write scope → copy the token (xapp-...)',
      '5. Under Socket Mode → enable Socket Mode',
      '6. Under Event Subscriptions → enable events → subscribe to: message.channels, message.groups, message.im, message.mpim',
      '7. Connect: channel_connect({ type: "slack", config: { botToken: "xoxb-...", appToken: "xapp-..." } })',
    ].join('\n'),
  },
  email: {
    requiredKeys: ['imapHost', 'smtpHost', 'username', 'password'],
    guide: [
      '## Email Setup',
      '1. Get IMAP and SMTP credentials from your email provider',
      '   - Gmail: use imap.gmail.com / smtp.gmail.com, enable "App Passwords" in Google Account settings',
      '   - Outlook: use outlook.office365.com for both IMAP and SMTP',
      '   - Custom: check your provider\'s IMAP/SMTP settings',
      '2. Connect: channel_connect({ type: "email", config: { imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", username: "you@gmail.com", password: "YOUR_APP_PASSWORD" } })',
    ].join('\n'),
  },
  whatsapp: {
    requiredKeys: ['accessToken', 'phoneNumberId', 'verifyToken'],
    guide: [
      '## WhatsApp Setup',
      '1. Go to https://developers.facebook.com and create or select an app',
      '2. Add the WhatsApp product to your app',
      '3. Under WhatsApp → API Setup → copy the Temporary Access Token and Phone Number ID',
      '4. Choose a verify token (any string you make up) — you\'ll use it to verify the webhook',
      '5. Connect: channel_connect({ type: "whatsapp", config: { accessToken: "YOUR_TOKEN", phoneNumberId: "YOUR_PHONE_ID", verifyToken: "YOUR_VERIFY_TOKEN" } })',
      '6. After connecting, configure the webhook URL in Meta Developer Portal → WhatsApp → Configuration → Callback URL',
    ].join('\n'),
  },
  webhook: {
    requiredKeys: [],
    guide: [
      '## Webhook / HTTP Setup',
      'No external accounts needed. Optionally provide a shared secret for authentication.',
      '',
      'Connect: channel_connect({ type: "webhook", config: { secret: "your-shared-secret" } })',
      '',
      'Once connected, external services can POST to /agent/channels/webhook/incoming with:',
      '  - Header: Authorization: Bearer your-shared-secret',
      '  - Body: { "message": "...", "channelId": "default", "mode": "sync" }',
      '',
      'Works with Zapier, Make, n8n, or any HTTP-capable service.',
    ].join('\n'),
  },
  teams: {
    requiredKeys: ['appId', 'appPassword'],
    guide: [
      '## Microsoft Teams Setup',
      '1. Go to Azure Portal → Azure Bot Service → create a new Bot resource',
      '2. Note the Microsoft App ID and create a client secret (App Password)',
      '3. Set the messaging endpoint to: <agent-url>/agent/channels/teams/messages',
      '4. Connect: channel_connect({ type: "teams", config: { appId: "YOUR_APP_ID", appPassword: "YOUR_SECRET", botName: "My Agent" } })',
      '5. Install the bot in Teams via the Teams Admin Center or a Teams App manifest',
    ].join('\n'),
  },
  webchat: {
    requiredKeys: [],
    guide: [
      '## WebChat Widget Setup',
      'No external accounts needed. All config fields are optional.',
      '',
      'Connect: channel_connect({ type: "webchat", config: { title: "Chat with us", welcomeMessage: "Hi! How can I help?", primaryColor: "#6366f1", position: "bottom-right" } })',
      'Or with no config: channel_connect({ type: "webchat", config: {} })',
      '',
      'After connecting, give the user the embed snippet to paste on their website.',
      'The widget appears as a chat bubble — visitors can chat with the agent directly.',
      'Optional config: title, subtitle, welcomeMessage, primaryColor (hex), position ("bottom-right" or "bottom-left"), avatarUrl, allowedOrigins.',
    ].join('\n'),
  },
}

function createChannelConnectTool(ctx: ToolContext): AgentTool {
  return {
    name: 'channel_connect',
    description:
      'Connect a messaging channel (telegram, discord, email, slack, whatsapp, webhook, teams, or webchat). ' +
      'Saves the config and hot-connects the channel immediately. ' +
      'For webchat: creates an embeddable chat widget for any website — no external accounts needed.',
    label: 'Connect Channel',
    parameters: Type.Object({
      type: Type.String({
        description: 'Channel type: telegram, discord, email, slack, whatsapp, webhook, teams, or webchat',
      }),
      config: Type.Record(Type.String(), Type.String(), {
        description:
          'Channel configuration. For webhook: { secret?: "shared-secret" }. ' +
          'For telegram: { botToken: "..." }. For discord: { botToken: "...", guildId: "..." }. ' +
          'For email: { imapHost, smtpHost, username, password }. ' +
          'For slack: { botToken: "xoxb-...", appToken: "xapp-..." }. ' +
          'For whatsapp: { accessToken, phoneNumberId, verifyToken }. ' +
          'For teams: { appId, appPassword, botName? }. ' +
          'For webchat: { title?, subtitle?, primaryColor?, position?, welcomeMessage?, avatarUrl?, allowedOrigins? } — all fields optional.',
      }),
      model: Type.Optional(Type.String({
        description: 'AI model tier for this channel: "basic" (economy, works on all plans) or "advanced" (requires Pro plan). Defaults to "basic".',
      })),
    }),
    execute: async (_toolCallId, params) => {
      const { type, config: channelConfig, model } = params as {
        type: string
        config: Record<string, string>
        model?: string
      }

      const channelModel = model || 'basic'
      if (channelModel !== 'basic' && channelModel !== 'advanced') {
        return textResult({ error: `Invalid model: "${channelModel}". Must be "basic" or "advanced".` })
      }

      if (channelModel === 'advanced') {
        const proxyUrl = ctx.aiProxyUrl || process.env.AI_PROXY_URL
        const proxyToken = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
        if (proxyUrl && proxyToken) {
          try {
            const accessRes = await fetch(`${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`, {
              headers: { 'Authorization': `Bearer ${proxyToken}` },
              signal: AbortSignal.timeout(5000),
            })
            if (accessRes.ok) {
              const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
              if (!access.hasAdvancedModelAccess) {
                return textResult({
                  error: 'Advanced model requires a Pro or higher subscription. Please use model: "basic" or upgrade your plan.',
                })
              }
            }
          } catch { /* If check fails, allow and let proxy enforce at runtime */ }
        }
      }

      const validTypes = ['telegram', 'discord', 'email', 'slack', 'whatsapp', 'webhook', 'teams', 'webchat']
      if (!validTypes.includes(type)) {
        return textResult({ error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}` })
      }

      const channelGuide = CHANNEL_SETUP_GUIDES[type]
      if (channelGuide) {
        const missingKeys = channelGuide.requiredKeys.filter(k => !channelConfig[k])
        if (missingKeys.length > 0) {
          return textResult({
            error: `Missing required config: ${missingKeys.join(', ')}`,
            setup_guide: channelGuide.guide,
          })
        }
      }

      if (type === 'webchat' && !channelConfig.widgetSecret) {
        const { randomUUID } = await import('crypto')
        channelConfig.widgetSecret = randomUUID()
      }

      try {
        const { existsSync, readFileSync, writeFileSync } = await import('fs')
        const { join } = await import('path')
        const configPath = join(ctx.workspaceDir, 'config.json')
        let savedConfig: Record<string, any> = {}
        if (existsSync(configPath)) {
          savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        }
        savedConfig.channels = savedConfig.channels || []
        const existing = savedConfig.channels.findIndex((c: any) => c.type === type)
        const channelEntry = { type, config: channelConfig, model: channelModel }
        if (existing >= 0) {
          savedConfig.channels[existing] = channelEntry
        } else {
          savedConfig.channels.push(channelEntry)
        }
        writeFileSync(configPath, JSON.stringify(savedConfig, null, 2), 'utf-8')
      } catch (err: any) {
        return textResult({ error: `Failed to save config: ${err.message}` })
      }

      if (ctx.connectChannel) {
        try {
          await ctx.connectChannel(type, channelConfig)

          if (type === 'webchat') {
            const widgetKey = encodeURIComponent(channelConfig.widgetSecret || '')
            const widgetPath = `/agent/channels/webchat/widget.js?widgetKey=${widgetKey}`
            let widgetUrl: string
            if (process.env.KUBERNETES_SERVICE_HOST) {
              const apiUrl = derivePublicApiUrl()
              widgetUrl = `${apiUrl}/api/projects/${ctx.projectId}/agent-proxy${widgetPath}`
            } else {
              widgetUrl = `http://localhost:${process.env.PORT || '8080'}${widgetPath}`
            }
            return textResult({
              ok: true,
              message: [
                'WebChat channel connected and live!',
                '',
                'Tell the user to add this single script tag before the closing </body> tag on their website:',
                '',
                `<script src="${widgetUrl}"></script>`,
                '',
                'A chat bubble will appear on their page. Visitors can click it to chat with the agent. No other setup needed.',
                'The user can also find the embed snippet in the Channels panel.',
              ].join('\n'),
              embedSnippet: `<script src="${widgetUrl}"></script>`,
            })
          }

          return textResult({
            ok: true,
            message: `${type} channel connected and live. ` +
              (type === 'webhook'
                ? 'External services can now POST to /agent/channels/webhook/incoming'
                : `The ${type} adapter is now receiving messages.`),
          })
        } catch (err: any) {
          return textResult({
            ok: true,
            message: `${type} channel saved to config but failed to hot-connect: ${err.message}. Restart the agent to connect.`,
            setup_guide: channelGuide?.guide,
          })
        }
      }

      return textResult({
        ok: true,
        message: `${type} channel configured. Restart the agent to connect.`,
        setup_guide: channelGuide?.guide,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Audio Transcription Tool (OpenAI Whisper)
// ---------------------------------------------------------------------------

function createTranscribeAudioTool(ctx: ToolContext): AgentTool {
  return {
    name: 'transcribe_audio',
    description:
      'Transcribe an audio file to text using OpenAI Whisper. ' +
      'Supports mp3, mp4, mpeg, mpga, m4a, wav, and webm formats. ' +
      'Provide a path to an audio file in the workspace.',
    label: 'Transcribe Audio',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the audio file in the workspace (e.g. "recording.mp3")' }),
      language: Type.Optional(Type.String({ description: 'ISO-639-1 language code (e.g. "en", "es", "fr"). Auto-detected if omitted.' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, language } = params as { path: string; language?: string }

      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      if (!existsSync(resolved)) {
        return textResult({ error: `Audio file not found: ${filePath}` })
      }

      const proxyUrl = ctx.aiProxyUrl || process.env.AI_PROXY_URL
      const proxyToken = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
      const directKey = process.env.OPENAI_API_KEY

      const apiBase = proxyUrl ? proxyUrl.replace(/\/v1$/, '') : 'https://api.openai.com'
      const apiKey = proxyToken || directKey
      if (!apiKey) {
        return textResult({ error: 'Audio transcription not available: no OpenAI API key configured.' })
      }

      try {
        const audioBuffer = readFileSync(resolved)
        const ext = extname(resolved).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.mpeg': 'audio/mpeg',
          '.mpga': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
          '.webm': 'audio/webm', '.ogg': 'audio/ogg',
        }
        const mimeType = mimeMap[ext] || 'audio/mpeg'

        const formData = new FormData()
        formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio${ext || '.mp3'}`)
        formData.append('model', 'whisper-1')
        formData.append('response_format', 'verbose_json')
        if (language) formData.append('language', language)

        const response = await fetch(`${apiBase}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formData,
          signal: AbortSignal.timeout(120_000),
        })

        if (!response.ok) {
          const errBody = await response.text().catch(() => '')
          return textResult({ error: `Whisper API error (${response.status}): ${errBody.slice(0, 500)}` })
        }

        const result = await response.json() as {
          text: string; language?: string; duration?: number;
          segments?: Array<{ start: number; end: number; text: string }>
        }

        return textResult({
          text: result.text,
          language: result.language,
          duration_seconds: result.duration,
          segments: result.segments?.map(s => ({ start: s.start, end: s.end, text: s.text })),
        })
      } catch (err: any) {
        return textResult({ error: `Audio transcription failed: ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Image Generation Tool
// ---------------------------------------------------------------------------

function createGenerateImageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using AI (DALL-E, GPT Image, Imagen, etc). ' +
      'The image is saved to the agent workspace. Optionally provide a reference_image path ' +
      'to edit/modify an existing workspace image instead of generating from scratch.',
    label: 'Generate Image',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the image to generate, or edit instruction when using reference_image' }),
      filename: Type.Optional(Type.String({ description: 'Destination filename (default: auto-generated). Saved under images/ directory.' })),
      size: Type.Optional(Type.String({ description: 'Image size: "1024x1024", "1024x1792", "1792x1024" (default: "1024x1024")' })),
      model: Type.Optional(Type.String({ description: 'Image model: "dall-e-3", "gpt-image-1", "imagen-4", etc. (default: "dall-e-3")' })),
      quality: Type.Optional(Type.String({ description: 'Image quality: "standard" or "hd" (default: "standard")' })),
      reference_image: Type.Optional(Type.String({ description: 'Path to a workspace image to use as reference for editing (e.g. "images/logo.png")' })),
    }),
    execute: async (_toolCallId, params) => {
      const {
        prompt,
        filename,
        size = '1024x1024',
        model = 'dall-e-3',
        quality = 'standard',
        reference_image,
      } = params as {
        prompt: string
        filename?: string
        size?: string
        model?: string
        quality?: string
        reference_image?: string
      }

      const proxyUrl = ctx.aiProxyUrl || process.env.AI_PROXY_URL
      const proxyToken = ctx.aiProxyToken || process.env.AI_PROXY_TOKEN
      if (!proxyUrl || !proxyToken) {
        return textResult({ error: 'Image generation is not available: AI proxy not configured.' })
      }

      const imagesDir = join(ctx.workspaceDir, 'images')
      mkdirSync(imagesDir, { recursive: true })

      const outputFilename = filename || `generated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`
      const safeFilename = outputFilename.replace(/[^a-zA-Z0-9._-]/g, '_')
      const outputPath = join(imagesDir, safeFilename)

      // Prevent path traversal
      const resolvedOutput = resolve(outputPath)
      const resolvedImagesDir = resolve(imagesDir)
      if (!resolvedOutput.startsWith(resolvedImagesDir)) {
        return textResult({ error: 'Invalid filename: path traversal detected.' })
      }

      try {
        let responseData: any

        if (reference_image) {
          const refPath = assertWithinWorkspace(ctx.workspaceDir, reference_image)
          if (!existsSync(refPath)) {
            return textResult({ error: `Reference image not found: ${reference_image}` })
          }

          const imageBuffer = readFileSync(refPath)
          const refExt = extname(refPath).toLowerCase()
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
          const mimeType = mimeMap[refExt] || 'image/png'

          const formData = new FormData()
          formData.append('image', new Blob([imageBuffer], { type: mimeType }), `reference${refExt || '.png'}`)
          formData.append('prompt', prompt)
          formData.append('model', 'dall-e-2')
          formData.append('size', size)
          formData.append('n', '1')

          const editUrl = proxyUrl.replace(/\/v1$/, '/v1/images/edits')
          const response = await fetch(editUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${proxyToken}` },
            body: formData,
          })

          if (!response.ok) {
            const errText = await response.text()
            return textResult({ error: `Image edit failed (${response.status}): ${errText}` })
          }

          responseData = await response.json()
        } else {
          const genUrl = proxyUrl.replace(/\/v1$/, '/v1/images/generations')
          const response = await fetch(genUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${proxyToken}`,
            },
            body: JSON.stringify({
              prompt,
              model,
              size,
              quality,
              n: 1,
              response_format: 'b64_json',
            }),
          })

          if (!response.ok) {
            const errText = await response.text()
            return textResult({ error: `Image generation failed (${response.status}): ${errText}` })
          }

          responseData = await response.json()
        }

        if (responseData.error) {
          return textResult({ error: responseData.error.message || 'Image generation failed' })
        }

        const imageData = responseData.data?.[0]
        if (!imageData?.b64_json) {
          return textResult({ error: 'No image data received from provider' })
        }

        const imageBuffer = Buffer.from(imageData.b64_json, 'base64')
        writeFileSync(outputPath, imageBuffer)

        const relativePath = `images/${safeFilename}`
        return textResult({
          path: relativePath,
          size,
          model,
          quality,
          bytes: imageBuffer.length,
          revised_prompt: imageData.revised_prompt || prompt,
          reference_image: reference_image || undefined,
        })
      } catch (err: any) {
        return textResult({ error: `Image generation error: ${err.message}` })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Heartbeat Tools
// ---------------------------------------------------------------------------

function createHeartbeatConfigureTool(ctx: ToolContext): AgentTool {
  return {
    name: 'heartbeat_configure',
    description:
      'Configure the heartbeat system: enable/disable, set interval, and quiet hours. ' +
      'Changes are persisted to config.json and synced to the central scheduler database.',
    label: 'Configure Heartbeat',
    parameters: Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable heartbeat' })),
      interval: Type.Optional(Type.Number({ description: 'Heartbeat interval in seconds (minimum 60, default 1800)' })),
      quietHoursStart: Type.Optional(Type.String({ description: 'Quiet hours start time (HH:MM, e.g. "23:00")' })),
      quietHoursEnd: Type.Optional(Type.String({ description: 'Quiet hours end time (HH:MM, e.g. "07:00")' })),
      timezone: Type.Optional(Type.String({ description: 'IANA timezone for quiet hours (e.g. "America/Los_Angeles")' })),
    }),
    execute: async (_toolCallId, params) => {
      const { enabled, interval, quietHoursStart, quietHoursEnd, timezone } = params as {
        enabled?: boolean
        interval?: number
        quietHoursStart?: string
        quietHoursEnd?: string
        timezone?: string
      }

      if (interval !== undefined && interval < 60) {
        return textResult({ error: 'Interval must be at least 60 seconds' })
      }

      try {
        const { existsSync, readFileSync, writeFileSync } = await import('fs')
        const { join } = await import('path')
        const configPath = join(ctx.workspaceDir, 'config.json')
        let config: Record<string, any> = {}
        if (existsSync(configPath)) {
          config = JSON.parse(readFileSync(configPath, 'utf-8'))
        }

        if (enabled !== undefined) config.heartbeatEnabled = enabled
        if (interval !== undefined) config.heartbeatInterval = interval
        if (quietHoursStart || quietHoursEnd || timezone) {
          config.quietHours = config.quietHours || {}
          if (quietHoursStart) config.quietHours.start = quietHoursStart
          if (quietHoursEnd) config.quietHours.end = quietHoursEnd
          if (timezone) config.quietHours.timezone = timezone
        }

        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

        if (ctx.updateHeartbeatConfig) {
          await ctx.updateHeartbeatConfig({
            heartbeatEnabled: enabled,
            heartbeatInterval: interval,
            quietHoursStart: quietHoursStart ?? undefined,
            quietHoursEnd: quietHoursEnd ?? undefined,
            quietHoursTimezone: timezone ?? undefined,
          })
        }

        return textResult({
          ok: true,
          enabled: config.heartbeatEnabled ?? false,
          interval: config.heartbeatInterval ?? 1800,
          quietHours: config.quietHours ?? null,
        })
      } catch (err: any) {
        return textResult({ error: `Failed to configure heartbeat: ${err.message}` })
      }
    },
  }
}

function createHeartbeatStatusTool(ctx: ToolContext): AgentTool {
  return {
    name: 'heartbeat_status',
    description: 'Get current heartbeat configuration and HEARTBEAT.md checklist preview',
    label: 'Heartbeat Status',
    parameters: Type.Object({}),
    execute: async () => {
      const { existsSync, readFileSync } = await import('fs')
      const { join } = await import('path')

      const configPath = join(ctx.workspaceDir, 'config.json')
      let config: Record<string, any> = {}
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, 'utf-8'))
        } catch { /* corrupt config */ }
      }

      const heartbeatPath = join(ctx.workspaceDir, 'HEARTBEAT.md')
      const heartbeatContent = existsSync(heartbeatPath)
        ? readFileSync(heartbeatPath, 'utf-8')
        : ''

      return textResult({
        enabled: config.heartbeatEnabled ?? false,
        interval: config.heartbeatInterval ?? 1800,
        quietHours: config.quietHours ?? null,
        checklistLength: heartbeatContent.trim().length,
        checklistPreview: heartbeatContent.substring(0, 500),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plan Mode: create_plan tool
// ---------------------------------------------------------------------------

function createCreatePlanTool(ctx: ToolContext): AgentTool {
  return {
    name: 'create_plan',
    description: 'Create a structured plan for the user to review and confirm before execution. The plan is saved to .shogo/plans/ as a markdown file and presented to the user for approval.',
    label: 'Create Plan',
    parameters: Type.Object({
      name: Type.String({ description: 'Short 3-5 word name for the plan' }),
      overview: Type.String({ description: '1-2 sentence summary of what the plan accomplishes' }),
      plan: Type.String({ description: 'Detailed plan in markdown format. Include specific file paths, code snippets, and implementation steps.' }),
      todos: Type.Array(
        Type.Object({
          id: Type.String({ description: 'Unique task identifier (kebab-case)' }),
          content: Type.String({ description: 'Task description' }),
        }),
        { description: 'Implementation tasks in execution order' }
      ),
    }),
    execute: async (_id: string, params: { name: string; overview: string; plan: string; todos: Array<{ id: string; content: string }> }) => {
      const slug = params.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').substring(0, 50)
      const hash = Math.random().toString(36).substring(2, 10)
      const filename = `${slug}_${hash}.plan.md`

      const todosYaml = params.todos.map(t =>
        `  - id: ${t.id}\n    content: ${JSON.stringify(t.content)}\n    status: pending`
      ).join('\n')

      const content = [
        '---',
        `name: ${JSON.stringify(params.name)}`,
        `overview: ${JSON.stringify(params.overview)}`,
        `createdAt: ${JSON.stringify(new Date().toISOString())}`,
        'status: pending',
        'todos:',
        todosYaml,
        '---',
        '',
        `# ${params.name}`,
        '',
        params.plan,
      ].join('\n')

      const plansDir = join(ctx.workspaceDir, '.shogo', 'plans')
      mkdirSync(plansDir, { recursive: true })
      const filepath = join(plansDir, filename)
      writeFileSync(filepath, content, 'utf-8')

      if (ctx.uiWriter) {
        ctx.uiWriter.write({
          type: 'data-plan',
          data: {
            name: params.name,
            overview: params.overview,
            plan: params.plan,
            todos: params.todos,
            filepath: `.shogo/plans/${filename}`,
          },
        })
      }

      return textResult(`Plan "${params.name}" created and saved to .shogo/plans/${filename}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Read Lints Tool (LSP-backed diagnostics for any TypeScript file)
// ---------------------------------------------------------------------------

function createReadLintsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_lints',
    description:
      'Check files for errors (TypeScript type errors, Python type errors, undefined references, syntax issues) ' +
      'and canvas runtime errors (compile/render failures from the live preview). ' +
      'Returns diagnostics from language servers plus any recent canvas runtime errors. ' +
      'Supports .ts, .tsx, .js, .jsx, and .py files. ' +
      'Use after writing or editing code files to catch mistakes. ' +
      'Omit path to check all open files.',
    label: 'Read Lints',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'File to check (e.g. src/App.tsx or scripts/main.py). Omit to check all tracked files.' })),
    }),
    execute: async (_toolCallId, params) => {
      const lsp = ctx.lspManager
      if (!lsp || !lsp.isRunning()) {
        const runtimeErrors = getCanvasRuntimeErrors()
        if (runtimeErrors.length > 0) {
          const errors = runtimeErrors.map(e => `[${e.phase}] ${e.surfaceId}: ${e.error}`)
          clearCanvasRuntimeErrors()
          return textResult({ ok: false, error: 'Language server not available.', runtimeErrors: errors })
        }
        return textResult({ ok: false, error: 'Language server not available. Try again shortly.' })
      }

      const { path: filePath } = params as { path?: string }

      const targetUri = filePath
        ? `file://${assertWithinWorkspace(ctx.workspaceDir, filePath)}`
        : undefined

      await new Promise(resolve => setTimeout(resolve, 1500))
      const allDiags = await lsp.getDiagnosticsAsync(targetUri)

      // Collect canvas runtime errors (compile/render failures from the live preview)
      const runtimeErrorEntries = getCanvasRuntimeErrors()
      const runtimeErrors = runtimeErrorEntries.length > 0
        ? runtimeErrorEntries.map(e => `[${e.phase}] ${e.surfaceId}: ${e.error}`)
        : undefined
      if (runtimeErrorEntries.length > 0) clearCanvasRuntimeErrors()

      if (allDiags.size === 0) {
        if (runtimeErrors) {
          return textResult({ ok: false, runtimeErrors, hint: 'Canvas runtime errors detected. Check your canvas code for the issues above.' })
        }
        return textResult({ ok: true, message: filePath ? `No errors in ${filePath}` : 'No errors found.' })
      }

      const TS_RETURN_OUTSIDE_FN = 1108
      const workspacePrefix = `file://${ctx.workspaceDir}/`
      let totalErrors = 0
      const files: Array<{ path: string; ok: boolean; errors: string[] }> = []

      for (const [uri, diags] of allDiags) {
        const relPath = uri.startsWith(workspacePrefix) ? uri.slice(workspacePrefix.length) : uri
        if (relPath.endsWith('.d.ts') || relPath.endsWith('.pyi')) continue

        const errors = diags
          .filter(d => (d.severity ?? 1) === 1)
          .filter(d => d.code !== TS_RETURN_OUTSIDE_FN)
          .map(d => `Line ${d.range.start.line + 1}: ${d.message}`)

        if (errors.length > 0) {
          totalErrors += errors.length
          files.push({ path: relPath, ok: false, errors })
        } else {
          files.push({ path: relPath, ok: true, errors: [] })
        }
      }

      if (files.length === 0) {
        if (runtimeErrors) {
          return textResult({ ok: false, runtimeErrors, hint: 'Canvas runtime errors detected. Check your canvas code for the issues above.' })
        }
        return textResult({ ok: true, message: filePath ? `No errors in ${filePath}` : 'No errors found.' })
      }

      const allOk = totalErrors === 0 && !runtimeErrors
      return textResult({
        ok: allOk,
        files,
        ...(runtimeErrors ? { runtimeErrors } : {}),
        ...(allOk ? {} : { hint: 'Fix the errors above using edit_file, then run read_lints again to verify.' }),
      })
    },
  }
}

/** Reduced tool set for heartbeat ticks (no exec, no send_message, no planning tools) */
export function createHeartbeatTools(ctx: ToolContext): AgentTool[] {
  const pe = ctx.permissionEngine
  const g = (tool: AgentTool, cat: import('./types').PermissionCategory) => applyPermissionGate(tool, cat, pe)

  return [
    g(createReadFileTool(ctx), 'file_read'),
    g(createWriteFileTool(ctx), 'file_write'),
    g(createEditFileTool(ctx), 'file_write'),
    g(createGlobTool(ctx), 'file_read'),
    g(createGrepTool(ctx), 'file_read'),
    g(createLsTool(ctx), 'file_read'),
    g(createWebTool(), 'network'),
    g(createBrowserTool(ctx), 'network'),
    createMemoryReadTool(ctx),
    createMemorySearchTool(ctx),
    createHeartbeatConfigureTool(ctx),
    createHeartbeatStatusTool(ctx),
  ]
}
