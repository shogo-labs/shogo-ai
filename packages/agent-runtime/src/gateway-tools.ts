/**
 * Gateway Tools
 *
 * Tool definitions available to the live gateway agent during agent turns.
 * Uses Pi Agent Core's AgentTool format with TypeBox parameter schemas.
 *
 * Tools are created via createGatewayTools(ctx) which closes over the
 * ToolContext, since Pi's execute() signature doesn't accept external context.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { Type, type Static } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { sandboxExec } from './sandbox-exec'

export interface ToolContext {
  workspaceDir: string
  channels: Map<string, import('./types').ChannelAdapter>
  config: import('./gateway').GatewayConfig
  projectId: string
  cronManager?: import('./cron-manager').CronManager
  sessionId?: string
  sandbox?: Partial<import('./types').SandboxConfig>
  mainSessionIds?: string[]
}

const BLOCKED_COMMANDS = [
  'rm -rf /',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
  'chmod 777',
  'curl.*|.*bash',
  'wget.*|.*bash',
]

function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase()
  return BLOCKED_COMMANDS.some((pattern) => {
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
  const resolved = resolve(workspaceDir, filePath)
  if (!resolved.startsWith(workspaceDir) && !resolved.startsWith('/tmp')) {
    throw new Error(`Path outside workspace: ${filePath}`)
  }
  return resolved
}

function textResult(data: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    details: data,
  }
}

// ---------------------------------------------------------------------------
// Tool Definitions (created via factory)
// ---------------------------------------------------------------------------

function createExecTool(ctx: ToolContext): AgentTool {
  return {
    name: 'exec',
    description:
      'Run a shell command in the agent workspace. Commands are executed synchronously with a 30s timeout. Destructive commands are blocked.',
    label: 'Execute Command',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 30000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { command, timeout = 30000 } = params as { command: string; timeout?: number }

      if (isBlockedCommand(command)) {
        return textResult({ error: `Blocked command: ${command}` })
      }

      const result = sandboxExec({
        command,
        workspaceDir: ctx.workspaceDir,
        timeout,
        sandboxConfig: ctx.sandbox,
        sessionId: ctx.sessionId,
        mainSessionIds: ctx.mainSessionIds,
      })

      return textResult({
        stdout: result.stdout,
        stderr: result.stderr || undefined,
        exitCode: result.exitCode,
        sandboxed: result.sandboxed || undefined,
      })
    },
  }
}

function createReadFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'read_file',
    description: 'Read a file from the agent workspace.',
    label: 'Read File',
    parameters: Type.Object({
      path: Type.String({ description: 'File path relative to workspace' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      const resolved = assertWithinWorkspace(ctx.workspaceDir, filePath)
      if (!existsSync(resolved)) {
        return textResult({ error: `File not found: ${filePath}` })
      }
      const content = readFileSync(resolved, 'utf-8')
      return textResult({ content, bytes: content.length })
    },
  }
}

function createWriteFileTool(ctx: ToolContext): AgentTool {
  return {
    name: 'write_file',
    description: 'Write content to a file in the agent workspace. Creates parent directories as needed.',
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
      const dir = resolved.substring(0, resolved.lastIndexOf('/'))
      if (dir) mkdirSync(dir, { recursive: true })

      if (append) {
        const existing = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : ''
        writeFileSync(resolved, existing + content, 'utf-8')
      } else {
        writeFileSync(resolved, content, 'utf-8')
      }
      return textResult({ ok: true, path: filePath, bytes: content.length })
    },
  }
}

function createWebFetchTool(): AgentTool {
  return {
    name: 'web_fetch',
    description: 'Fetch content from a URL and return it as text. Useful for checking APIs, web pages, or downloading data.',
    label: 'Web Fetch',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch' }),
      maxChars: Type.Optional(Type.Number({ description: 'Maximum characters to return (default: 50000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { url, maxChars = 50000 } = params as { url: string; maxChars?: number }

      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Shogo-Agent/1.0' },
          signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) {
          return textResult({ error: `HTTP ${response.status}: ${response.statusText}`, url })
        }

        let text = await response.text()
        if (text.length > maxChars) {
          text = text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`
        }

        return textResult({ content: text, status: response.status, bytes: text.length, url })
      } catch (err: any) {
        return textResult({ error: err.message, url })
      }
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

function createMemoryWriteTool(ctx: ToolContext): AgentTool {
  return {
    name: 'memory_write',
    description: 'Write to agent memory. Appends a timestamped entry to MEMORY.md or a daily log.',
    label: 'Write Memory',
    parameters: Type.Object({
      file: Type.String({ description: '"MEMORY.md" or a date string (YYYY-MM-DD)' }),
      content: Type.String({ description: 'Content to write' }),
      append: Type.Optional(Type.Boolean({ description: 'Append instead of overwrite (default: true)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { file, content, append } = params as { file: string; content: string; append?: boolean }
      let filePath: string

      if (file === 'MEMORY.md') {
        filePath = join(ctx.workspaceDir, 'MEMORY.md')
      } else {
        const memDir = join(ctx.workspaceDir, 'memory')
        mkdirSync(memDir, { recursive: true })
        filePath = join(memDir, `${file}.md`)
      }

      const shouldAppend = append !== false
      if (shouldAppend && existsSync(filePath)) {
        const existing = readFileSync(filePath, 'utf-8')
        writeFileSync(filePath, existing + '\n' + content, 'utf-8')
      } else {
        writeFileSync(filePath, content, 'utf-8')
      }

      return textResult({ ok: true, file, bytes: content.length })
    },
  }
}

function createSendMessageTool(ctx: ToolContext): AgentTool {
  return {
    name: 'send_message',
    description:
      'Send a message through a connected messaging channel (telegram, discord).',
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

function createCronTool(ctx: ToolContext): AgentTool {
  return {
    name: 'cron',
    description:
      'Manage scheduled jobs. Actions: "add" (create/update), "remove", "list", "enable", "disable", "trigger".',
    label: 'Manage Cron Jobs',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('add'),
        Type.Literal('remove'),
        Type.Literal('list'),
        Type.Literal('enable'),
        Type.Literal('disable'),
        Type.Literal('trigger'),
      ], { description: 'Action to perform' }),
      name: Type.Optional(Type.String({ description: 'Job name (required for add/remove/enable/disable/trigger)' })),
      intervalSeconds: Type.Optional(Type.Number({ description: 'Run interval in seconds (required for add)' })),
      prompt: Type.Optional(Type.String({ description: 'Prompt to execute when job fires (required for add)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { action, name, intervalSeconds, prompt } = params as {
        action: string
        name?: string
        intervalSeconds?: number
        prompt?: string
      }

      const cm = ctx.cronManager
      if (!cm) {
        return textResult({ error: 'Cron manager not available' })
      }

      try {
        switch (action) {
          case 'list':
            return textResult({ jobs: cm.listJobs() })

          case 'add': {
            if (!name || !intervalSeconds || !prompt) {
              return textResult({ error: 'add requires name, intervalSeconds, and prompt' })
            }
            const job = cm.addJob({ name, intervalSeconds, prompt })
            return textResult({ ok: true, job })
          }

          case 'remove':
            if (!name) return textResult({ error: 'remove requires name' })
            return textResult({ ok: cm.removeJob(name), name })

          case 'enable':
            if (!name) return textResult({ error: 'enable requires name' })
            return textResult({ ok: cm.enableJob(name), name })

          case 'disable':
            if (!name) return textResult({ error: 'disable requires name' })
            return textResult({ ok: cm.disableJob(name), name })

          case 'trigger': {
            if (!name) return textResult({ error: 'trigger requires name' })
            const result = await cm.triggerJob(name)
            return textResult({ ok: result.success, result })
          }

          default:
            return textResult({ error: `Unknown action: ${action}` })
        }
      } catch (err: any) {
        return textResult({ error: err.message })
      }
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
  filesystem: ['read_file', 'write_file'],
  web_fetch: ['web_fetch'],
  web_search: ['web_fetch'],
  browser: ['web_fetch'],
  memory: ['memory_read', 'memory_write'],
  messaging: ['send_message'],
  cron: ['cron'],
}

export const ALL_TOOL_NAMES = [
  'exec', 'read_file', 'write_file', 'web_fetch',
  'memory_read', 'memory_write', 'send_message', 'cron',
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
    }
  }
  return [...resolved]
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/** All gateway tools (full set for channel messages) */
export function createAllTools(ctx: ToolContext): AgentTool[] {
  return [
    createExecTool(ctx),
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createWebFetchTool(),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createSendMessageTool(ctx),
    createCronTool(ctx),
  ]
}

/** Reduced tool set for heartbeat ticks (no exec, no send_message) */
export function createHeartbeatTools(ctx: ToolContext): AgentTool[] {
  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createWebFetchTool(),
    createMemoryReadTool(ctx),
    createMemoryWriteTool(ctx),
    createCronTool(ctx),
  ]
}
