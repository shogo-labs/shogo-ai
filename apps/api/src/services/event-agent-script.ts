// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scripted trigger agents for local end-to-end tests. When
 * `SHOGO_EVENT_AGENT_SCRIPT` points at a JSON file (local mode only), agent
 * targets of event subscriptions run this script instead of a real runtime:
 *
 *   {
 *     "triggers": {
 *       "Welcome new members": [
 *         {
 *           "when": "member\\.joined",
 *           "actions": [
 *             { "tool": "team_chat_dm", "args": { "user": "{{payload.member.userId}}", "text": "Welcome!" } },
 *             { "tool": "team_chat_add_member", "args": { "channel": "onboarding", "users": ["{{payload.member.userId}}"] } }
 *           ],
 *           "reply": "Welcomed {{payload.member.name}}."
 *         }
 *       ],
 *       "*": [{ "fail": "no script for this trigger" }]
 *     }
 *   }
 *
 * Triggers are keyed by subscription name ("*" is the fallback). The first
 * rule whose `when` regex matches the event type wins. Actions perform the
 * same side effects as the agent tools of the same name, as the target agent.
 * `{{payload.x.y}}` and `{{event.type}}` are substituted. The file is re-read
 * on every run so a test can rewrite it.
 */

import { readFileSync } from 'fs'
import { prisma } from '../lib/prisma'
import { DeliveryError, setEventAgentRunner, type EventAgentRunner, type EventAgentTurnInput } from './event-delivery-targets'

const db = prisma as any

interface ScriptAction { tool: 'team_chat_dm' | 'team_chat_post' | 'team_chat_add_member'; args: Record<string, any> }
interface ScriptRule {
  when?: string
  reply?: string
  fail?: string
  failKind?: 'retry' | 'forbidden'
  actions?: ScriptAction[]
}
interface EventScript { triggers?: Record<string, ScriptRule[]> }

/** Every scripted run in this process, newest last (for server-level tests). */
export const scriptedEventRuns: Array<{ subscriptionId: string; projectId: string | null; prompt: string; eventType: string }> = []

export function scriptedEventAgentFromEnv(env = process.env): EventAgentRunner | null {
  const path = env.SHOGO_EVENT_AGENT_SCRIPT
  if (!path) return null
  const deployed = (env.SHOGO_ENV || env.APP_ENV || env.NODE_ENV || '').toLowerCase()
  if (env.SHOGO_LOCAL_MODE !== 'true' || deployed === 'production' || deployed === 'prod') {
    console.warn('[events] SHOGO_EVENT_AGENT_SCRIPT ignored outside local mode')
    return null
  }
  console.log(`[events] trigger agents are scripted from ${path}`)
  return (input) => runScript(JSON.parse(readFileSync(path, 'utf-8')) as EventScript, input)
}

export function installScriptedEventAgentFromEnv(env = process.env): boolean {
  const runner = scriptedEventAgentFromEnv(env)
  if (runner) setEventAgentRunner(runner)
  return !!runner
}

function lookupPath(source: unknown, path: string): unknown {
  let cur: any = source
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function render(value: unknown, input: EventAgentTurnInput): any {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const [root, ...rest] = path.split('.')
      const base = root === 'payload' ? input.envelope.payload : root === 'event' ? input.envelope : undefined
      const found = rest.length ? lookupPath(base, rest.join('.')) : base
      return found == null ? '' : typeof found === 'object' ? JSON.stringify(found) : String(found)
    })
  }
  if (Array.isArray(value)) return value.map((v) => render(v, input))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, input)]))
  }
  return value
}

async function resolveUserId(workspaceId: string, user: string): Promise<string> {
  const member = await db.member.findFirst({
    where: { workspaceId, projectId: null, OR: [{ userId: user }, { user: { email: { in: [user, user.toLowerCase()] } } }] },
    select: { userId: true },
  })
  if (!member) throw new DeliveryError(`Scripted action: ${user} is not a workspace member`, 'retry')
  return member.userId
}

async function resolveChannel(workspaceId: string, channel: string, projectId: string | null) {
  const conv = await db.conversation.findFirst({
    where: { workspaceId, OR: [{ id: channel }, { slug: channel.replace(/^#/, '').toLowerCase() }] },
  })
  if (!conv) throw new DeliveryError(`Scripted action: channel ${channel} not found`, 'retry')
  if (conv.kind === 'public') return conv
  const member = await db.conversationMember.findFirst({ where: { conversationId: conv.id, memberType: 'agent', projectId } })
  if (!member) throw new DeliveryError(`Scripted action: channel ${channel} is not visible to this agent`, 'retry')
  return conv
}

async function runAction(action: ScriptAction, input: EventAgentTurnInput): Promise<void> {
  const args = render(action.args, input)
  const { agentDisplayName, openAgentConversation, addUserMembersAsAgent } = await import('./conversation.service')
  const { postAgentMessage } = await import('./chat-providers/outbound')
  const agent = { projectId: input.projectId, name: await agentDisplayName(input.workspaceId, input.projectId) }
  switch (action.tool) {
    case 'team_chat_dm': {
      const userId = await resolveUserId(input.workspaceId, String(args.user))
      const conv = await openAgentConversation(input.workspaceId, userId, { projectId: input.projectId })
      await postAgentMessage({ conversationId: conv.id, workspaceId: input.workspaceId, text: String(args.text), agent })
      return
    }
    case 'team_chat_post': {
      const conv = await resolveChannel(input.workspaceId, String(args.channel), input.projectId)
      await postAgentMessage({ conversationId: conv.id, workspaceId: input.workspaceId, text: String(args.text), agent })
      return
    }
    case 'team_chat_add_member': {
      const conv = await resolveChannel(input.workspaceId, String(args.channel), input.projectId)
      const users = (Array.isArray(args.users) ? args.users : [args.users]).map(String)
      await addUserMembersAsAgent(conv, users)
      return
    }
    default:
      throw new DeliveryError(`Scripted action: unknown tool ${(action as any).tool}`, 'retry')
  }
}

async function runScript(script: EventScript, input: EventAgentTurnInput): Promise<{ summary: string | null }> {
  scriptedEventRuns.push({
    subscriptionId: input.subscription.id,
    projectId: input.projectId,
    prompt: input.prompt,
    eventType: input.envelope.type,
  })
  const rules = script.triggers?.[input.subscription.name] ?? script.triggers?.['*'] ?? []
  const rule = rules.find((r) => !r.when || new RegExp(r.when, 'i').test(input.envelope.type))
  if (!rule) return { summary: `No scripted reply for trigger "${input.subscription.name}".` }
  if (rule.fail) throw new DeliveryError(render(rule.fail, input), rule.failKind ?? 'retry')
  for (const action of rule.actions ?? []) await runAction(action, input)
  return { summary: rule.reply ? render(rule.reply, input) : null }
}
