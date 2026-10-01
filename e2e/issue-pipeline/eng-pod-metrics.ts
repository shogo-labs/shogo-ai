// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Metrics for the "engineering team in a channel" run (eng-pod template).
 *
 * Pure functions over the channel's messages (the shape `GET
 * /conversations/:id/messages` returns), so they are unit-tested in CI
 * (`eng-pod-metrics.test.ts`) and the live test
 * (`l1-eng-pod-metrics.integration.test.ts`) only has to collect messages and
 * timestamps.
 *
 * Definitions, so the numbers mean the same thing every run:
 *
 *   human-read messages   what a person has to read to follow the run: every
 *                         agent message that is top-level, a status card
 *                         (counted once however often it is edited), a
 *                         decision, an alert, or has no kind at all. Routine
 *                         `status` replies and the person's own posts are not
 *                         counted (they are collapsed in the product).
 *   human interventions   what a person had to do after posting the bug: any
 *                         message they wrote in the thread, plus each approval
 *                         card someone decided. The target is one: the merge
 *                         approval.
 *   wasted agent turns    work that did not move the task: agents other than
 *                         the coordinator that answered the untagged bug post,
 *                         "Paused" notices from the chain limit, and reviewer
 *                         rounds beyond the two the team is allowed.
 */

export interface RunMessage {
  id: string
  threadRootId: string | null
  /** Position in the conversation; the app lists messages by it. */
  seq?: number
  authorType: 'user' | 'agent' | 'system'
  authorAgent?: { name?: string } | null
  text: string
  blocks?: {
    type?: string
    messageKind?: string
    card?: { links?: Array<{ label?: string; url: string }> }
    approval?: { status?: string; decidedBy?: string | null }
    /** Set on a reply that shows "Worked for X"; `completedAt` is when the run ended (ms). */
    work?: { startedAt?: number; completedAt?: number; toolCalls?: number }
  } | null
  agentStatus?: string | null
  createdAt: string | Date
}

export const ROLES = ['Coordinator', 'Builder', 'Reviewer'] as const
export type Role = (typeof ROLES)[number]

export const REVIEWER_ROUND_LIMIT = 2

/** What "good" looks like for the demo (docs: plan "Success metrics"). */
export const TARGETS = {
  maxMsToPr: 15 * 60 * 1000,
  maxHumanReadMessages: 5,
  humanInterventions: 1,
  wastedAgentTurns: 0,
  timelineViolations: 0,
  narrationLeaked: 0,
} as const

export interface EngPodMetrics {
  /** Bug post → first pull request opened (ms), when one was opened. */
  msToPr: number | null
  /** Bug post → first message that links a preview (ms), when one was posted. */
  msToPreview: number | null
  humanReadMessages: number
  humanInterventions: number
  wastedAgentTurns: number
  /** Messages that existed before a reply finished but are listed after it. */
  timelineViolations: number
  /** Replies that open like a progress update instead of the result (heuristic). */
  narrationLeaked: number
  wasted: { extraResponders: string[]; pausedNotices: number; reviewerRoundsOverLimit: number }
  reviewerRounds: number
  totalMessages: number
}

export function roleOf(message: RunMessage): Role | null {
  const name = message.authorAgent?.name ?? ''
  return ROLES.find((r) => name.toLowerCase().includes(r.toLowerCase())) ?? null
}

const time = (m: RunMessage | { createdAt: string | Date }) => new Date(m.createdAt).getTime()

/**
 * The bug post, everything in its thread, and any top-level agent post made
 * after it (an agent that answers in the channel instead of the thread is
 * exactly the noise this measures), oldest first.
 */
export function runMessages(all: RunMessage[], rootId: string): RunMessage[] {
  const root = all.find((m) => m.id === rootId)
  const start = root ? time(root) : Infinity
  return all
    .filter(
      (m) =>
        m.id === rootId ||
        m.threadRootId === rootId ||
        (m.threadRootId === null && m.authorType === 'agent' && time(m) >= start),
    )
    .sort((a, b) => time(a) - time(b))
}

const isCard = (m: RunMessage) => m.blocks?.type === 'status_card'
const kindOf = (m: RunMessage) => m.blocks?.messageKind ?? null

export function isHumanRead(m: RunMessage, rootId: string): boolean {
  if (m.authorType !== 'agent') return false
  if (isCard(m)) return true
  const kind = kindOf(m)
  if (kind === 'decision' || kind === 'alert') return true
  if (kind === 'status') return false
  // Top-level agent posts are channel noise by definition; threaded replies
  // with no kind are counted too, so an agent that skips `kind` is not rewarded.
  return m.threadRootId === rootId || m.threadRootId === null
}

/** "Let me check…", "I'll start by…", "First, …": how an agent narrates before it has a result. */
const NARRATION_OPENER = /^\W*(let me|let's|i'll|i will|i am going to|i'm going to|now,? (let me|i'll|i will)|first,? (let me|i'll|i will|i))\b/i

/**
 * Replies that finished after other messages landed must be listed after them. A message is out
 * of order when it was created before the reply's run ended yet has a higher `seq`.
 */
export function timelineViolationsOf(replies: RunMessage[]): number {
  let count = 0
  for (const reply of replies) {
    const completedAt = reply.blocks?.work?.completedAt
    if (reply.seq === undefined || !completedAt) continue
    const outOfOrder = replies.some(
      (other) => other.id !== reply.id && other.seq !== undefined && other.seq > reply.seq! && time(other) < completedAt,
    )
    if (outOfOrder) count++
  }
  return count
}

const isVerdict = (m: RunMessage) => roleOf(m) === 'Reviewer' && /^\W*(verdict\W*)?(PASS|FAIL)\b/im.test(m.text)

/** Does this message link a preview (card link, or a URL labelled/named as one)? */
export function linksPreview(m: RunMessage, pattern = /preview/i): boolean {
  const links = m.blocks?.card?.links ?? []
  if (links.some((l) => pattern.test(l.label ?? '') || pattern.test(l.url))) return true
  const urls = m.text.match(/https?:\/\/\S+/g) ?? []
  return urls.some((u) => pattern.test(u)) || /\bpreview\b[^\n]{0,40}https?:\/\//i.test(m.text)
}

export function computeMetrics(input: {
  messages: RunMessage[]
  rootId: string
  /** When the pull request was opened (GitHub `createdAt`), if it was. */
  prCreatedAt?: string | Date | null
  previewPattern?: RegExp
}): EngPodMetrics {
  const run = runMessages(input.messages, input.rootId)
  const root = run.find((m) => m.id === input.rootId)
  if (!root) throw new Error(`bug post ${input.rootId} not found in the messages`)
  const start = time(root)
  const replies = run.filter((m) => m.id !== input.rootId)

  const humanReadMessages = replies.filter((m) => isHumanRead(m, input.rootId)).length

  const approvals = replies.filter((m) => m.blocks?.type === 'approval_request' || m.blocks?.approval)
  const decided = approvals.filter((m) => {
    const a = m.blocks?.approval
    return !!a?.decidedBy && (a.status === 'approved' || a.status === 'denied')
  }).length
  const humanInterventions = replies.filter((m) => m.authorType === 'user').length + decided

  const coordinatorFirst = replies.find((m) => roleOf(m) === 'Coordinator')
  const extraResponders = [
    ...new Set(
      replies
        .filter((m) => m.authorType === 'agent' && roleOf(m) !== 'Coordinator')
        // Only agents that jumped in before the coordinator did (they answered
        // the untagged post); the builder and reviewer are tagged in later.
        .filter((m) => !coordinatorFirst || time(m) < time(coordinatorFirst))
        .map((m) => m.authorAgent?.name ?? 'unknown agent'),
    ),
  ]
  const pausedNotices = replies.filter((m) => m.authorType === 'system' && /^Paused/i.test(m.text.trim())).length
  const reviewerRounds = replies.filter(isVerdict).length
  const reviewerRoundsOverLimit = Math.max(0, reviewerRounds - REVIEWER_ROUND_LIMIT)

  const narrationLeaked = replies.filter(
    (m) => m.authorType === 'agent' && !!m.blocks?.work && NARRATION_OPENER.test(m.text.trim()),
  ).length
  const preview = replies.find((m) => m.authorType === 'agent' && linksPreview(m, input.previewPattern))
  return {
    msToPr: input.prCreatedAt ? Math.max(0, new Date(input.prCreatedAt).getTime() - start) : null,
    msToPreview: preview ? Math.max(0, time(preview) - start) : null,
    humanReadMessages,
    humanInterventions,
    timelineViolations: timelineViolationsOf(replies),
    narrationLeaked,
    wastedAgentTurns: extraResponders.length + pausedNotices + reviewerRoundsOverLimit,
    wasted: { extraResponders, pausedNotices, reviewerRoundsOverLimit },
    reviewerRounds,
    totalMessages: run.length,
  }
}

/** Compares a run to TARGETS; an empty list means every target was met. */
export function missedTargets(m: EngPodMetrics): string[] {
  const out: string[] = []
  const min = (ms: number) => (ms / 60000).toFixed(1)
  if (m.msToPr === null) out.push('no pull request was opened')
  else if (m.msToPr > TARGETS.maxMsToPr) out.push(`PR took ${min(m.msToPr)} min (target under ${min(TARGETS.maxMsToPr)})`)
  if (m.humanReadMessages > TARGETS.maxHumanReadMessages) {
    out.push(`${m.humanReadMessages} messages to read (target ${TARGETS.maxHumanReadMessages} or fewer)`)
  }
  if (m.humanInterventions !== TARGETS.humanInterventions) {
    out.push(`${m.humanInterventions} human interventions (target exactly ${TARGETS.humanInterventions}: the merge approval)`)
  }
  if (m.wastedAgentTurns > TARGETS.wastedAgentTurns) out.push(`${m.wastedAgentTurns} wasted agent turns (target 0)`)
  if (m.timelineViolations > TARGETS.timelineViolations) out.push(`${m.timelineViolations} replies listed before messages that existed when they finished`)
  if (m.narrationLeaked > TARGETS.narrationLeaked) out.push(`${m.narrationLeaked} replies read like progress updates, not results`)
  return out
}

export function formatMetrics(m: EngPodMetrics): string {
  const min = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 60000).toFixed(1)} min`)
  return [
    `bug post → PR:        ${min(m.msToPr)}`,
    `bug post → preview:   ${min(m.msToPreview)}`,
    `messages to read:     ${m.humanReadMessages} (of ${m.totalMessages} in the thread)`,
    `human interventions:  ${m.humanInterventions}`,
    `wasted agent turns:   ${m.wastedAgentTurns} (extra responders ${m.wasted.extraResponders.length}, paused ${m.wasted.pausedNotices}, reviewer rounds over ${REVIEWER_ROUND_LIMIT}: ${m.wasted.reviewerRoundsOverLimit})`,
    `reviewer rounds:      ${m.reviewerRounds}`,
    `timeline violations:  ${m.timelineViolations}`,
    `narration in replies: ${m.narrationLeaked}`,
  ].join('\n')
}
