// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Teammate Loop — Long-Lived Agent Loop with Idle/Wake Cycling
 *
 * Runs a continuous agent loop for a teammate, handling:
 * - Per-turn agent execution with its own AbortController
 * - Auto-compaction of conversation when token count exceeds threshold
 * - Idle/wake cycling via mailbox polling and task claiming
 * - Graceful shutdown negotiation via structured messages
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'
import { runAgentLoop } from './agent-loop'
import type { ToolContext } from './gateway-tools'
import type { TeamManager, MailboxMessage, TaskInfo } from './team-manager'
import { teammateStorage, type TeammateContext } from './teammate-context'

const POLL_INTERVAL_MS = 500
const AUTO_COMPACT_TOKEN_THRESHOLD = 80_000
const CHARS_PER_TOKEN_ESTIMATE = 4

export interface TeammateLoopConfig {
  agentId: string
  teamId: string
  name: string
  color?: string
  leaderAgentId: string
  systemPrompt: string
  tools: AgentTool[]
  model?: string
  provider?: string
  maxTurnsPerWake?: number
  initialPrompt?: string
  uiWriter?: { write(chunk: Record<string, any>): void }
}

export interface TeammateLoopCallbacks {
  onIdle?: (agentId: string) => void
  onWake?: (agentId: string, reason: string) => void
  onShutdown?: (agentId: string) => void
  onTurnComplete?: (agentId: string, toolCalls: number) => void
  onCompaction?: (agentId: string, beforeTokens: number, afterTokens: number) => void
}

export interface TeammateLoopHandle {
  readonly agentId: string
  readonly teamId: string
  /** Abort the current turn only — teammate goes idle and loops back. */
  abortCurrentTurn(): void
  /** Kill the entire teammate lifecycle. */
  kill(): void
  /** Promise that resolves when the teammate loop exits. */
  readonly done: Promise<void>
}

function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ('text' in block) chars += (block as any).text.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}

function buildCompactSummaryPrompt(messages: Message[]): string {
  const textParts: string[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      textParts.push(`[${m.role}]: ${m.content.slice(0, 500)}`)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ('text' in block) {
          textParts.push(`[${m.role}]: ${(block as any).text.slice(0, 500)}`)
        }
      }
    }
  }
  return textParts.join('\n').slice(0, 10000)
}

function wrapAsTeammateMessage(from: string, text: string): Message {
  return {
    role: 'user',
    content: `<teammate-message from="${from}">\n${text}\n</teammate-message>`,
  } as Message
}

function wrapAsTaskAssignment(task: TaskInfo): Message {
  return {
    role: 'user',
    content: `<task-assignment id="${task.id}" subject="${task.subject}">\n${task.description || task.subject}\n</task-assignment>`,
  } as Message
}

interface WakeResult {
  type: 'message' | 'task' | 'shutdown' | 'aborted'
  message?: MailboxMessage
  task?: TaskInfo
}

async function waitForNextPromptOrShutdown(
  agentId: string,
  teamManager: TeamManager,
  teamId: string,
  lifecycleSignal: AbortSignal,
): Promise<WakeResult> {
  while (!lifecycleSignal.aborted) {
    const messages = teamManager.readUnread(agentId)

    const shutdown = messages.find((m: MailboxMessage) => m.messageType === 'shutdown_request')
    if (shutdown) return { type: 'shutdown', message: shutdown }

    const leaderMsg = messages.find((m: MailboxMessage) => m.messageType === 'text' && m.fromAgent.startsWith('team-lead@'))
    if (leaderMsg) return { type: 'message', message: leaderMsg }

    const peerMsg = messages.find((m: MailboxMessage) => m.messageType === 'text' || m.messageType === 'task_assignment')
    if (peerMsg) return { type: 'message', message: peerMsg }

    const task = teamManager.findAvailableTask(teamId)
    if (task) {
      const claimed = teamManager.claimTask(task.id, agentId)
      if (claimed) return { type: 'task', task }
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return { type: 'aborted' }
}

export function startTeammateLoop(
  config: TeammateLoopConfig,
  parentCtx: ToolContext,
  teamManager: TeamManager,
  callbacks?: TeammateLoopCallbacks,
): TeammateLoopHandle {
  const lifecycleAbort = new AbortController()
  let workAbort = new AbortController()

  const teammateCtx: TeammateContext = {
    agentId: config.agentId,
    teamId: config.teamId,
    name: config.name,
    color: config.color,
    isLeader: false,
  }

  const done = teammateStorage.run(teammateCtx, async () => {
    let allMessages: Message[] = []

    if (config.initialPrompt) {
      allMessages.push({
        role: 'user',
        content: config.initialPrompt,
      } as Message)
    }

    while (!lifecycleAbort.signal.aborted) {
      workAbort = new AbortController()

      try {
        const modelConfig = parentCtx.config?.model
        // Extract the last user message as the prompt; the rest is history
        let prompt = 'Continue with your current tasks.'
        let lastUserIdx = -1
        for (let i = allMessages.length - 1; i >= 0; i--) {
          if (allMessages[i].role === 'user') { lastUserIdx = i; break }
        }
        let history = allMessages
        if (lastUserIdx >= 0) {
          const lastMsg = allMessages[lastUserIdx]
          prompt = typeof lastMsg.content === 'string'
            ? lastMsg.content
            : Array.isArray(lastMsg.content)
              ? lastMsg.content.filter((b: any) => 'text' in b).map((b: any) => b.text).join('\n')
              : 'Continue with your current tasks.'
          history = allMessages.slice(0, lastUserIdx)
        }
        const w = config.uiWriter
        const aid = config.agentId
        const tid = config.teamId
        let tmTextId: string | null = null
        let tmReasoningId: string | null = null

        function closeTmText() {
          if (tmTextId && w) {
            w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'end', textId: tmTextId } })
            tmTextId = null
          }
        }

        const iterationsPerWake = config.maxTurnsPerWake || 50
        const MAX_TEAMMATE_CONTINUATIONS = 5
        let tmContinuations = 0

        let result = await runAgentLoop({
          provider: config.provider || modelConfig?.provider || 'anthropic',
          model: config.model || modelConfig?.name || 'claude-haiku-4-5-20251001',
          system: config.systemPrompt,
          prompt,
          history,
          tools: config.tools,
          maxIterations: iterationsPerWake,
          signal: workAbort.signal,
          thinkingLevel: 'low',
          onTextDelta: w ? (delta) => {
            if (!tmTextId) {
              tmTextId = `tm-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'start', textId: tmTextId } })
            }
            w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'delta', textId: tmTextId, delta } })
          } : undefined,
          onThinkingStart: w ? () => {
            closeTmText()
            tmReasoningId = `tm-reason-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
            w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'reasoning-start', textId: tmReasoningId } })
          } : undefined,
          onThinkingDelta: w ? (delta) => {
            if (tmReasoningId) {
              w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'reasoning-delta', textId: tmReasoningId, delta } })
            }
          } : undefined,
          onThinkingEnd: w ? () => {
            if (tmReasoningId) {
              w.write({ type: 'data-teammate-text', data: { agentId: aid, teamId: tid, phase: 'reasoning-end', textId: tmReasoningId } })
              tmReasoningId = null
            }
          } : undefined,
          onBeforeToolCall: w ? async (toolName, args, toolCallId) => {
            closeTmText()
            w.write({ type: 'data-teammate-tool', data: { agentId: aid, teamId: tid, toolName, toolCallId, phase: 'start', args } })
          } : undefined,
          onAfterToolCall: w ? async (toolName, _args, result, isError, toolCallId) => {
            const parsed = typeof result === 'string' ? (() => { try { return JSON.parse(result) } catch { return result } })() : result
            w.write({ type: 'data-teammate-tool', data: { agentId: aid, teamId: tid, toolCallId, phase: 'output', toolName, result: parsed, isError } })
          } : undefined,
        })

        closeTmText()

        if (result.newMessages) {
          allMessages.push(...result.newMessages)
        }

        // Auto-continue if maxIterations was exhausted
        while (
          result.maxIterationsExhausted &&
          !result.loopBreak &&
          !result.error &&
          !workAbort.signal.aborted &&
          tmContinuations < MAX_TEAMMATE_CONTINUATIONS
        ) {
          tmContinuations++
          console.log(
            `[Teammate:${config.name}] Auto-continuing (pass ${tmContinuations}/${MAX_TEAMMATE_CONTINUATIONS})`
          )
          // Rebuild history from all messages accumulated so far
          let contLastUserIdx = -1
          for (let ci = allMessages.length - 1; ci >= 0; ci--) {
            if (allMessages[ci].role === 'user') { contLastUserIdx = ci; break }
          }
          const contHistory = allMessages
          const contPrompt = 'Continue — you ran out of steps. Pick up exactly where you left off and complete the remaining work.'
          allMessages.push({ role: 'user', content: contPrompt } as Message)

          result = await runAgentLoop({
            provider: config.provider || modelConfig?.provider || 'anthropic',
            model: config.model || modelConfig?.name || 'claude-haiku-4-5-20251001',
            system: config.systemPrompt,
            prompt: contPrompt,
            history: contHistory,
            tools: config.tools,
            maxIterations: iterationsPerWake,
            signal: workAbort.signal,
            thinkingLevel: 'low',
          })
          if (result.newMessages) {
            allMessages.push(...result.newMessages)
          }
        }

        callbacks?.onTurnComplete?.(config.agentId, result.toolCalls.length)
        w?.write({ type: 'data-team-activity', data: { event: 'turn-complete', agentId: aid, teamId: tid, toolCalls: result.toolCalls.length } })
      } catch (err: any) {
        if (err.name === 'AbortError' || lifecycleAbort.signal.aborted) break
        console.error(`[Teammate:${config.name}] Turn error:`, err.message)
      }

      const tokenEstimate = estimateTokens(allMessages)
      if (tokenEstimate > AUTO_COMPACT_TOKEN_THRESHOLD && allMessages.length > 4) {
        const summary = buildCompactSummaryPrompt(allMessages)
        const compactedMessages: Message[] = [
          { role: 'user', content: `[Previous conversation summary]\n${summary}\n\n[End of summary — continue with your current tasks]` } as unknown as Message,
          { role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the context from the summary. Checking for new tasks.' }] } as unknown as Message,
        ]
        const afterTokens = estimateTokens(compactedMessages)
        callbacks?.onCompaction?.(config.agentId, tokenEstimate, afterTokens)
        allMessages = compactedMessages
      }

      if (lifecycleAbort.signal.aborted) break

      teamManager.setMemberActive(config.agentId, false)
      teamManager.writeMessage(config.teamId, config.leaderAgentId, config.agentId, {
        type: 'idle_notification',
        message: 'Teammate is idle and ready for new tasks.',
        summary: 'idle',
      })
      callbacks?.onIdle?.(config.agentId)
      config.uiWriter?.write({ type: 'data-team-activity', data: { event: 'idle', agentId: config.agentId, teamId: config.teamId } })

      const wake = await waitForNextPromptOrShutdown(
        config.agentId,
        teamManager,
        config.teamId,
        lifecycleAbort.signal,
      )

      if (wake.type === 'aborted' || lifecycleAbort.signal.aborted) break

      if (wake.type === 'shutdown') {
        allMessages.push(wrapAsTeammateMessage(
          wake.message!.fromAgent,
          `SHUTDOWN REQUEST: ${wake.message!.message}\nPlease wrap up your work and respond with SendMessage using shutdown_response type.`,
        ))
        callbacks?.onWake?.(config.agentId, 'shutdown_request')
        config.uiWriter?.write({ type: 'data-team-activity', data: { event: 'wake', agentId: config.agentId, teamId: config.teamId, reason: 'shutdown_request' } })
        teamManager.setMemberActive(config.agentId, true)
        continue
      }

      if (wake.type === 'message') {
        allMessages.push(wrapAsTeammateMessage(
          wake.message!.fromAgent,
          wake.message!.message,
        ))
        callbacks?.onWake?.(config.agentId, 'message')
        config.uiWriter?.write({ type: 'data-team-activity', data: { event: 'wake', agentId: config.agentId, teamId: config.teamId, reason: 'message' } })
        teamManager.setMemberActive(config.agentId, true)
        continue
      }

      if (wake.type === 'task') {
        allMessages.push(wrapAsTaskAssignment(wake.task!))
        callbacks?.onWake?.(config.agentId, 'task_claim')
        config.uiWriter?.write({ type: 'data-team-activity', data: { event: 'wake', agentId: config.agentId, teamId: config.teamId, reason: 'task_claim' } })
        teamManager.setMemberActive(config.agentId, true)
        continue
      }
    }

    callbacks?.onShutdown?.(config.agentId)
    config.uiWriter?.write({ type: 'data-team-activity', data: { event: 'shutdown', agentId: config.agentId, teamId: config.teamId } })
  })

  return {
    agentId: config.agentId,
    teamId: config.teamId,
    abortCurrentTurn() {
      workAbort.abort()
    },
    kill() {
      lifecycleAbort.abort()
      workAbort.abort()
    },
    done,
  }
}
