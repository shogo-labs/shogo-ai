/**
 * Slash Commands
 *
 * Parses and executes user-facing slash commands sent through messaging channels.
 * Commands are intercepted before the agent turn, so they are fast and deterministic.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Message } from '@mariozechner/pi-ai'
import type { AgentStatus } from './types'

export interface SlashCommandContext {
  sessionKey: string
  workspaceDir: string
  /** Clear the session's message history */
  clearHistory: () => void
  /** Get current session messages (for hook context) */
  getMessages: () => Message[]
  /** Reload config and reconnect channels */
  reloadConfig: () => void
  /** Override model for this session */
  setModelOverride: (model: string) => void
  /** Get agent status */
  getStatus: () => AgentStatus
}

export interface SlashCommandResult {
  handled: boolean
  response?: string
  /** Event to emit via hooks (type:action) */
  hookEvent?: { type: 'command'; action: string; context: Record<string, any> }
}

interface CommandDef {
  name: string
  description: string
  handler: (args: string, ctx: SlashCommandContext) => SlashCommandResult
}

const commands: CommandDef[] = [
  {
    name: '/new',
    description: 'Start a fresh conversation (clears session history)',
    handler: (_args, ctx) => {
      const messages = ctx.getMessages()
      ctx.clearHistory()
      return {
        handled: true,
        response: 'Session cleared. Starting fresh.',
        hookEvent: {
          type: 'command',
          action: 'new',
          context: {
            workspaceDir: ctx.workspaceDir,
            sessionMessages: messages,
          },
        },
      }
    },
  },
  {
    name: '/reset',
    description: 'Reload configuration and reconnect channels',
    handler: (_args, ctx) => {
      ctx.reloadConfig()
      return {
        handled: true,
        response: 'Configuration reloaded.',
        hookEvent: {
          type: 'command',
          action: 'reset',
          context: { workspaceDir: ctx.workspaceDir },
        },
      }
    },
  },
  {
    name: '/stop',
    description: 'Stop processing the current message queue',
    handler: () => ({
      handled: true,
      response: 'Queue processing stopped.',
      hookEvent: {
        type: 'command',
        action: 'stop',
        context: {},
      },
    }),
  },
  {
    name: '/model',
    description: 'Switch the model for this session',
    handler: (args, ctx) => {
      const modelName = args.trim()
      if (!modelName) {
        return { handled: true, response: 'Usage: /model <model-name>' }
      }
      ctx.setModelOverride(modelName)
      return {
        handled: true,
        response: `Model switched to: ${modelName}`,
        hookEvent: {
          type: 'command',
          action: 'model',
          context: { model: modelName },
        },
      }
    },
  },
  {
    name: '/status',
    description: 'Show agent status',
    handler: (_args, ctx) => {
      const status = ctx.getStatus()
      const lines = [
        `Running: ${status.running}`,
        `Heartbeat: ${status.heartbeat.enabled ? `every ${status.heartbeat.intervalSeconds}s` : 'disabled'}`,
        `Channels: ${status.channels.length} (${status.channels.filter((c) => c.connected).length} connected)`,
        `Skills: ${status.skills.length}`,
        `Model: ${status.model.name}`,
      ]
      if (status.heartbeat.lastTick) {
        lines.push(`Last heartbeat: ${status.heartbeat.lastTick}`)
      }
      return { handled: true, response: lines.join('\n') }
    },
  },
  {
    name: '/memory',
    description: 'Show recent memory entries',
    handler: (_args, ctx) => {
      const memoryDir = join(ctx.workspaceDir, 'memory')
      if (!existsSync(memoryDir)) {
        return { handled: true, response: 'No memory entries yet.' }
      }

      const files = readdirSync(memoryDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 5)

      if (files.length === 0) {
        return { handled: true, response: 'No memory entries yet.' }
      }

      const entries = files.map((f) => {
        const content = readFileSync(join(memoryDir, f), 'utf-8')
        const preview = content.substring(0, 150).replace(/\n/g, ' ')
        return `**${f}**: ${preview}...`
      })

      return { handled: true, response: entries.join('\n\n') }
    },
  },
  {
    name: '/help',
    description: 'Show available commands',
    handler: () => {
      const lines = commands.map((c) => `\`${c.name}\` — ${c.description}`)
      return { handled: true, response: lines.join('\n') }
    },
  },
]

/**
 * Parse and execute a slash command from a message.
 * Returns { handled: false } if the message is not a slash command.
 */
export function parseSlashCommand(
  text: string,
  ctx: SlashCommandContext
): SlashCommandResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return { handled: false }

  const spaceIdx = trimmed.indexOf(' ')
  const cmdName = spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx)
  const args = spaceIdx === -1 ? '' : trimmed.substring(spaceIdx + 1)

  const cmd = commands.find((c) => c.name === cmdName.toLowerCase())
  if (!cmd) return { handled: false }

  return cmd.handler(args, ctx)
}

/**
 * Check if a message text looks like a slash command (for fast path).
 */
export function isSlashCommand(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return false
  const spaceIdx = trimmed.indexOf(' ')
  const cmdName = spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx)
  return commands.some((c) => c.name === cmdName.toLowerCase())
}
