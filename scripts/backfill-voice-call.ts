// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off backfill for a completed ElevenLabs conversation that was
 * not captured by our voice_call_meters table — usually because the
 * workspace-level `post_call_webhook_id` wasn't wired up at the time
 * of the call.
 *
 * Re-uses the exact path the webhook handler runs (recordCallUsage),
 * so billing + transcript + usage_event land identically to a live
 * webhook delivery. Safe to re-run: recordCallUsage is idempotent on
 * `(conversationId, callSid)`.
 *
 * Usage:
 *   bun scripts/backfill-voice-call.ts <conversationId> <projectId>
 */

import { prisma } from '../apps/api/src/lib/prisma'
import { recordCallUsage } from '../apps/api/src/lib/voice-meter'

const [, , CONV_ID, PROJECT_ID] = process.argv
if (!CONV_ID || !PROJECT_ID) {
  console.error('usage: bun scripts/backfill-voice-call.ts <conversationId> <projectId>')
  process.exit(1)
}

const XI = process.env.ELEVENLABS_API_KEY
if (!XI) {
  console.error('ELEVENLABS_API_KEY not set')
  process.exit(1)
}

const res = await fetch(
  `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(CONV_ID)}`,
  { headers: { 'xi-api-key': XI } },
)
if (!res.ok) {
  console.error('EL fetch failed:', res.status, await res.text())
  process.exit(1)
}
const conv: any = await res.json()
const md = conv.metadata ?? {}
const phone = md.phone_call ?? {}

const cfg = await prisma.voiceProjectConfig.findUnique({
  where: { projectId: PROJECT_ID },
  select: { projectId: true, workspaceId: true },
})
if (!cfg) {
  console.error('no VoiceProjectConfig for project', PROJECT_ID)
  process.exit(1)
}

const direction = phone.direction === 'outbound' ? 'outbound' : 'inbound'
const durationSeconds = md.call_duration_secs ?? 0
const startedAt = md.start_time_unix_secs
  ? new Date(md.start_time_unix_secs * 1000)
  : undefined
const endedAt = startedAt
  ? new Date(startedAt.getTime() + durationSeconds * 1000)
  : new Date()

const result = await recordCallUsage({
  projectId: cfg.projectId,
  workspaceId: cfg.workspaceId,
  direction,
  durationSeconds,
  conversationId: conv.conversation_id,
  ...(phone.call_sid ? { callSid: phone.call_sid } : {}),
  ...(conv.agent_id ? { agentId: conv.agent_id } : {}),
  ...(phone.agent_number ? { toNumber: phone.agent_number } : {}),
  ...(phone.external_number ? { fromNumber: phone.external_number } : {}),
  ...(Array.isArray(conv.transcript) ? { transcript: conv.transcript } : {}),
  ...(conv.analysis?.transcript_summary
    ? { transcriptSummary: conv.analysis.transcript_summary }
    : {}),
  ...(startedAt ? { startedAt } : {}),
  endedAt,
})

console.log('backfilled:', JSON.stringify(result, null, 2))
process.exit(0)
