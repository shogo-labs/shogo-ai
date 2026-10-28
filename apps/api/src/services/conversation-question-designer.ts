// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Finds questions an agent asked people in plain prose and turns them into
 * question cards (`conversation-questions`), choosing how each one is best
 * answered: pick an option, approve, type a value, pick a teammate, or enter
 * a secret.
 *
 * Runs on every finished agent message in a channel. A free text check skips
 * messages with nothing that reads like a request, so those never cost a
 * model call, unless the conversation has open questions the message might
 * settle. One cheap model call then returns the questions, which open
 * question each one repeats, and which open questions the message says are
 * no longer needed.
 */

import { prisma } from '../lib/prisma'
import { registerAfterPostHook } from './conversation-pipeline'
import { onMessageTextSettled } from './conversation.service'
import { plainText } from './conversation-agent-relevance'
import { agentDisplayName } from './conversation.service'
import { renderMentionsAsText } from './conversation-mentions'
import {
  normalizeQuestionDrafts,
  questionsOf,
  type MessageBlocks,
  type QuestionDraft,
  type QuestionRecipients,
} from './conversation-message-kind'
import {
  attachQuestions,
  listOpenQuestions,
  markScanned,
  resolveQuestionRecipients,
  supersedeQuestions,
  type OpenQuestion,
} from './conversation-questions'

const db = prisma as any

const MAX_MESSAGE_CHARS = 6_000
const MAX_OPEN_IN_PROMPT = 20

/** Someone the message tags: `u:<userId>`, `a:p:<projectId>` or `a:ws`. */
export interface TaggedTarget {
  key: string
  name: string
  kind: 'person' | 'agent'
}

export interface DesignRequest {
  agentName: string
  text: string
  /** Who a question goes to when it isn't addressed to anyone in particular, and how they were picked. */
  recipients: { names: string[]; via: QuestionRecipients['via']; anyone: boolean }
  /** People and agents tagged in the message, so each question can go to the one it's addressed to. */
  tagged?: TaggedTarget[]
  open: Array<{ id: string; header: string; prompt: string }>
}

export interface DesignResult {
  questions: QuestionDraft[]
  /** For each question, the id of the open question it repeats. */
  sameAs: Array<string | null>
  /** Open questions the message says are no longer needed or already settled. */
  moot: string[]
}

export type QuestionDesigner = (request: DesignRequest) => Promise<DesignResult | null>

// ─── Gate ────────────────────────────────────────────────────────────────────

const ASK_PHRASES = [
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bplease (confirm|approve|decide|choose|pick|share|send|provide|drop|let me know|advise)\b/i,
  /\blet me know\b/i,
  /\bneed (a|one|your)? ?(decision|answer|approval|input|go-ahead|sign-off)\b/i,
  /\bneed .{0,40} from (you|\W*$|\W*[:.,])/i,
  /\bneed\b.{0,40}\bto (pick|choose|decide|confirm|approve|share|send|provide)\b/i,
  /\b(drop|paste|send|share|add) (the|your|a|an)\b.{0,40}\b(key|token|password|secret|credentials?)\b/i,
  /\bwaiting (on|for) (you|your)\b/i,
  /\b(do|should) (we|i) (proceed|go ahead)\b/i,
  /\bwhich (one|option)\b/i,
]

/** Text with code, links and mention tokens removed, so a `?` in a URL or snippet doesn't count. */
function proseOf(text: string): string {
  return plainText(
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/\bhttps?:\/\/\S+/gi, ' '),
  )
}

/** True when a message reads like it asks someone for something. */
export function looksLikeAsk(text: string): boolean {
  const prose = proseOf(text)
  if (prose.length < 8) return false
  return /\?(\s|$|\*|_|\))/.test(`${prose} `) || ASK_PHRASES.some((re) => re.test(prose))
}

// ─── Model ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You read a message an AI agent posted in a team chat and find the questions it asks people, so the app can show each one as an answerable card instead of a sentence buried in the update.

Include a question only when the agent genuinely needs input from a person to continue: a decision, an approval, a value, a name, or a credential. Leave out greetings and offers ("What are we building today?", "Let me know if you need anything"), rhetorical questions, questions the message answers itself, and questions addressed to other agents. Most messages ask nothing; then return no questions.

For each question pick how it is best answered:
- "choice": the message names the alternatives. Give 2-6 short options (1-5 words each, with a one-line description of what it means). multiSelect only when several can apply.
- "confirm": a go/no-go, approve-or-not question ("proceed with these three?").
- "person": asks who owns, has access to, or should do something.
- "secret": asks for an API key, token, password or other credential. Give secretName as an env-style name like ENSEMBLEDATA_API_TOKEN.
- "text": anything else. hint "number" for amounts, budgets, counts; "url" for links.

header: a 1-4 word label (max 40 chars), e.g. "Alert destination".
prompt: the question rewritten so it stands alone (max 200 chars), ending with "?".
One entry per distinct decision, at most 4.

to: who the question is addressed to, as keys from the tagged list ("u:..." people, "a:..." agents). When it names or tags particular people, list only them, so a question for one person doesn't land with everyone tagged. When it is addressed to an agent, give that agent's key. Leave to empty when the question isn't addressed to anyone in particular.

If a question repeats one of the open questions listed, set sameAs to that question's id. List in moot the ids of open questions this message says are no longer needed, already resolved, or superseded.

Reply with JSON only:
{"questions":[{"header":"","prompt":"","interaction":"choice","options":[{"label":"","description":""}],"multiSelect":false,"hint":null,"secretName":null,"to":[],"sameAs":null}],"moot":[]}`

/** The message with mention tokens as names, so the model can tell who is addressed. */
function readableText(text: string, tagged: TaggedTarget[]): string {
  const name = (key: string) => tagged.find((t) => t.key === key)
  const users = new Map<string, string>()
  const projects = new Map<string, string>()
  for (const t of tagged) {
    if (t.key.startsWith('u:')) users.set(t.key.slice(2), t.name)
    else if (t.key.startsWith('a:p:')) projects.set(t.key.slice(4), `${t.name} (agent)`)
  }
  const ws = name('a:ws')
  return renderMentionsAsText(text, { users, projects, workspaceAgentName: ws ? `${ws.name} (agent)` : undefined })
}

export function buildPrompt(request: DesignRequest): string {
  const tagged = request.tagged ?? []
  const who = request.recipients.anyone
    ? 'anyone in the channel'
    : `${request.recipients.names.join(', ') || 'someone'} (${request.recipients.via === 'mention' ? 'tagged in the message' : 'the person the agent is working for'})`
  const tags = tagged.length ? tagged.map((t) => `- ${t.key}: ${t.name} (${t.kind})`).join('\n') : 'nobody'
  const open = request.open.length
    ? request.open.map((q) => `- id: ${q.id}\n  header: ${q.header}\n  prompt: ${q.prompt}`).join('\n')
    : 'none'
  return [
    `Agent: ${request.agentName}`,
    `Tagged in the message:\n${tags}`,
    `A question not addressed to anyone in particular goes to: ${who}`,
    `Open questions in this conversation:\n${open}`,
    `Message:\n${readableText(request.text, tagged).slice(0, MAX_MESSAGE_CHARS)}`,
  ].join('\n\n')
}

/**
 * The design out of a model reply; null when it isn't usable JSON. A question
 * addressed only to tagged agents is left out; one addressed to tagged people
 * goes to just them. Keys not in `tagged` are ignored.
 */
export function parseDesign(raw: string, openIds: Set<string>, tagged: TaggedTarget[] = []): DesignResult | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  let value: any
  try {
    value = JSON.parse(match[0])
  } catch {
    return null
  }
  const listed = Array.isArray(value?.questions) ? value.questions.filter((q: unknown) => q && typeof q === 'object') : []
  const kept: Array<{ draft: QuestionDraft; sameAs: string | null }> = []
  const byKey = new Map(tagged.map((t) => [t.key, t]))
  for (const q of listed) {
    const to = (Array.isArray(q.to) ? q.to : []).flatMap((key: unknown) => {
      const target = typeof key === 'string' ? byKey.get(key) : undefined
      return target ? [target] : []
    }) as TaggedTarget[]
    if (to.length && to.every((t) => t.kind === 'agent')) continue
    const userIds = to.flatMap((t) => (t.kind === 'person' ? [t.key.slice(2)] : []))
    const [draft] = normalizeQuestionDrafts([{ ...q, userIds }])
    if (!draft) continue
    kept.push({ draft, sameAs: typeof q.sameAs === 'string' && openIds.has(q.sameAs) ? q.sameAs : null })
  }
  const moot = Array.isArray(value?.moot) ? value.moot.filter((id: unknown): id is string => typeof id === 'string' && openIds.has(id)) : []
  return { questions: kept.map((k) => k.draft), sameAs: kept.map((k) => k.sameAs), moot: [...new Set<string>(moot)] }
}

/** Small, fast model used when the title model is unreachable. */
const DESIGNER_FALLBACK_MODEL = 'claude-haiku-4-5-20251001'

/** The real model call, exported for the live eval (`scripts/eval-question-designer.ts`). */
export const modelDesigner: QuestionDesigner = async (request) => {
  const { generateTitleCompletion } = await import('../lib/title-model')
  const result = await generateTitleCompletion({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(request),
    maxTokens: 900,
    fallbackModelIds: [DESIGNER_FALLBACK_MODEL],
  })
  return parseDesign(result.text, new Set(request.open.map((q) => q.id)), request.tagged)
}

let designer: QuestionDesigner = modelDesigner

/** Test seam: replace the model call. Pass null to restore it. */
export function setQuestionDesigner(next: QuestionDesigner | null): void {
  designer = next ?? modelDesigner
}

function designerEnabled(): boolean {
  if (process.env.SHOGO_QUESTION_DESIGNER === 'off') return false
  // Tests opt in through the seam, so suites that don't care never reach a model.
  return designer !== modelDesigner || process.env.NODE_ENV !== 'test'
}

// ─── Running it ──────────────────────────────────────────────────────────────

const inFlight = new Set<string>()

function eligible(row: any): boolean {
  if (!row || row.authorType !== 'agent' || row.deletedAt) return false
  if (row.agentStatus === 'running' || !String(row.text ?? '').trim()) return false
  const blocks = row.blocks as MessageBlocks | null
  if (blocks?.type === 'approval_request' || blocks?.questionScan) return false
  return questionsOf(blocks).length === 0
}

async function recipientNames(recipients: QuestionRecipients): Promise<string[]> {
  if (!recipients.userIds.length) return []
  const users = await db.user.findMany({ where: { id: { in: recipients.userIds } }, select: { name: true, email: true } })
  return users.map((u: any) => u.name || u.email)
}

/** People (including those a tagged group expands to) and agents the message tags. */
async function taggedIn(row: any): Promise<TaggedTarget[]> {
  const mentions = await db.conversationMention.findMany({
    where: { messageId: row.id, targetType: { in: ['user', 'agent'] } },
    select: { targetType: true, targetUserId: true, projectId: true },
  })
  const userIds = mentions.flatMap((m: any) => (m.targetType === 'user' && m.targetUserId ? [m.targetUserId] : []))
  const projectIds = mentions.flatMap((m: any) => (m.targetType === 'agent' && m.projectId ? [m.projectId] : []))
  const [users, projects] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    projectIds.length ? db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }) : [],
  ])
  const userName = new Map<string, string>(users.map((u: any) => [u.id, u.name || u.email]))
  const projectName = new Map<string, string>(projects.map((p: any) => [p.id, p.name]))
  const tagged: TaggedTarget[] = []
  for (const m of mentions as any[]) {
    if (m.targetType === 'user' && m.targetUserId) {
      tagged.push({ key: `u:${m.targetUserId}`, name: userName.get(m.targetUserId) ?? 'someone', kind: 'person' })
    } else if (m.targetType === 'agent' && m.projectId) {
      tagged.push({ key: `a:p:${m.projectId}`, name: projectName.get(m.projectId) ?? 'agent', kind: 'agent' })
    } else if (m.targetType === 'agent') {
      tagged.push({ key: 'a:ws', name: await agentDisplayName(row.workspaceId, null), kind: 'agent' })
    }
  }
  return [...new Map(tagged.map((t) => [t.key, t])).values()]
}

/**
 * Look at one finished agent message and attach the questions it asks.
 * Never throws: a failed model call leaves the message as it was.
 */
export async function designQuestionsFor(messageId: string): Promise<void> {
  if (!designerEnabled() || inFlight.has(messageId)) return
  inFlight.add(messageId)
  try {
    const row = await db.conversationMessage.findUnique({ where: { id: messageId } })
    if (!eligible(row)) return
    const conversation = await db.conversation.findUnique({ where: { id: row.conversationId } })
    if (!conversation || conversation.kind === 'activity' || conversation.archivedAt) return

    const open: OpenQuestion[] = (await listOpenQuestions(conversation.id)).filter((o) => o.row.id !== row.id)
    if (!looksLikeAsk(row.text) && !open.length) return

    const recipients = await resolveQuestionRecipients(row, conversation)
    const agentName = (row.authorAgentRef?.name as string | undefined) ?? 'Agent'
    const result = await designer({
      agentName,
      text: row.text,
      recipients: { names: await recipientNames(recipients), via: recipients.via, anyone: !!recipients.anyone },
      tagged: await taggedIn(row),
      open: open.slice(0, MAX_OPEN_IN_PROMPT).map((o) => ({ id: o.question.id, header: o.question.header, prompt: o.question.prompt })),
    })
    if (!result) return

    if (result.moot.length) {
      await supersedeQuestions(result.moot, conversation.id, `${agentName} said it is no longer needed`)
    }
    if (result.questions.length) {
      await attachQuestions({ messageId: row.id, drafts: result.questions, source: 'inferred', sameAs: result.sameAs, recipients })
    } else {
      await markScanned(row.id)
    }
  } catch (err) {
    console.warn('[QuestionDesigner] failed:', (err as Error)?.message ?? err)
  } finally {
    inFlight.delete(messageId)
  }
}

let registered = false

/** Run the designer on every finished agent message. Safe to call more than once. */
export function registerQuestionDesigner(): void {
  if (registered) return
  registered = true
  // Tool posts, task and schedule results.
  registerAfterPostHook((result) => {
    if (eligible(result.row)) void designQuestionsFor(result.row.id)
  })
  // A streamed reply is posted as a placeholder and finished with an update.
  onMessageTextSettled((row) => {
    if (eligible(row)) void designQuestionsFor(row.id)
  })
}

export function _resetQuestionDesignerForTests(): void {
  inFlight.clear()
  designer = modelDesigner
}
