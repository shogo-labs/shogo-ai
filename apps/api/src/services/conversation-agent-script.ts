// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Scripted channel agents for local end-to-end tests. When
 * `SHOGO_CHANNEL_AGENT_SCRIPT` points at a JSON file (local mode only), channel
 * agent replies come from that file instead of a real agent runtime:
 *
 *   {
 *     "delayMs": 200,
 *     "agents": {
 *       "Analyst": [
 *         { "when": "option 2", "reply": "Going with 2. @Planner please plan it." },
 *         { "reply": "Two options. {{origin}}, which one?" }
 *       ]
 *     }
 *   }
 *
 * Agents are keyed by project name ("workspace" for the workspace agent). The
 * first rule whose `when` regex matches the latest message wins; a rule without
 * `when` always matches. `{{origin}}` becomes a mention of the person the run is
 * billed to. The file is re-read on every reply so a test can rewrite it.
 */

import { readFileSync } from 'fs'
import { prisma } from '../lib/prisma'
import type { InvokeArgs } from './conversation-agent-dispatcher'

const db = prisma as any

interface ScriptRule { when?: string; reply: string }
interface AgentScript { delayMs?: number; agents?: Record<string, ScriptRule[]> }

export function scriptedAgentInvokeFromEnv(env = process.env): ((args: InvokeArgs) => Promise<Response>) | null {
  const path = env.SHOGO_CHANNEL_AGENT_SCRIPT
  if (!path) return null
  const deployed = (env.SHOGO_ENV || env.APP_ENV || env.NODE_ENV || '').toLowerCase()
  if (env.SHOGO_LOCAL_MODE !== 'true' || deployed === 'production' || deployed === 'prod') {
    console.warn('[channels] SHOGO_CHANNEL_AGENT_SCRIPT ignored outside local mode')
    return null
  }
  console.log(`[channels] channel agents are scripted from ${path}`)
  return (args) => scriptedReply(path, args)
}

async function scriptedReply(path: string, args: InvokeArgs): Promise<Response> {
  const script = JSON.parse(readFileSync(path, 'utf-8')) as AgentScript
  const name = args.projectId
    ? (await db.project.findUnique({ where: { id: args.projectId }, select: { name: true } }))?.name ?? args.projectId
    : 'workspace'
  const latest = args.prompt.trim().split('\n').pop() ?? ''
  const rule = (script.agents?.[name] ?? []).find((r) => !r.when || new RegExp(r.when, 'i').test(latest))
  const text = (rule?.reply ?? `${name} has no scripted reply.`).replaceAll('{{origin}}', `<@u:${args.userId}>`)
  return streamText(text, script.delayMs ?? 150, args.signal)
}

function streamText(text: string, delayMs: number, signal: AbortSignal): Response {
  const words = text.split(/(?<= )/)
  const half = Math.ceil(words.length / 2)
  const chunks = [words.slice(0, half).join(''), words.slice(half).join('')].filter(Boolean)
  const encoder = new TextEncoder()
  const sse = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse({ type: 'text-start', id: 't1' }))
      for (const delta of chunks) {
        await new Promise((r) => setTimeout(r, delayMs))
        if (signal.aborted) break
        controller.enqueue(sse({ type: 'text-delta', id: 't1', delta }))
      }
      controller.enqueue(sse({ type: 'text-end', id: 't1' }))
      controller.enqueue(sse({ type: 'finish' }))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}
