// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 7 — an agent's permission prompt, in a remote workspace.
 *
 * A permission prompt is a message in the conversation with
 * `blocks.type === 'approval_request'`; the panel reads the pending ones from
 * `GET /workspaces/:id/approvals/pending` and decides one with
 * `POST /conversation-messages/:messageId/approval` (`services/
 * conversation-approvals.ts`). On a workspace hosted on a paired computer the
 * card is written by the desktop's agent and has to reach the cloud live, and
 * the decision has to reach the desktop and resume the same turn.
 *
 * The prompt only exists because the runtime emitted `data-permission-request`
 * (`packages/agent-runtime/src/permission-engine.ts:480`), which balanced mode
 * does when a shell command is not on its allowlist. `fake-llm-server`'s
 * `permission` script is exactly that: a turn that streams half its tokens,
 * calls `exec` with a command nobody put on the allowlist, and finishes after
 * the person answers.
 *
 * A channel `@agent` mention is used on purpose: the approval card is posted by
 * the channel dispatcher for a *project* agent (`conversation-agent-dispatcher
 * .ts` ~2310, "only project agents have a runtime to answer"), so a workspace
 * chat turn would never produce one.
 *
 * Runs on the two targets that can run a model (see `TURN_TARGETS`). Needs
 * `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`; skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  LIVE_BUDGET_MS,
  TARGET_NAMES,
  TURN_TARGETS,
  agentMention,
  marker,
  openLive,
  read,
  send,
  startRemoteWorkspace,
  token,
  waitFor,
  type RemoteWorkspace,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

/**
 * Lets the suite stop the machine's runtimes. The desktop inherits this
 * process's env, so it is set before the stack boots.
 */
const BOOTSTRAP_SECRET = 'sho488-approvals-bootstrap'
process.env.SHOGO_E2E_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET

let ws: RemoteWorkspace
let llm: FakeLlmServer
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
  // A runtime only asks when its mode is not `full_autonomy`, which is the
  // default (`DEFAULT_SECURITY_PREFERENCE`) — measured: with the default, the
  // scripted `exec` runs and the turn continues, no prompt ever exists. This is
  // the switch the desktop's Settings → Security writes, set before any runtime
  // boots and followed by a restart so an already-running one re-reads it.
  const prefs = await fetch(`${ws.machine.localApiBase}/api/local/security-prefs`, {
    method: 'POST',
    headers: {
      cookie: ws.machine.localCookies,
      origin: ws.machine.localApiBase,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'balanced', approvalTimeoutSeconds: 900 }),
  })
  if (!prefs.ok) console.warn(`[approvals] could not set balanced mode: ${prefs.status}`)

  const restarted = await fetch(`${ws.machine.localApiBase}/api/local/system/restart-runtime`, {
    method: 'POST',
    headers: { 'x-e2e-bootstrap-secret': BOOTSTRAP_SECRET },
  })
  const stopped = (await restarted.json().catch(() => ({}))) as { stopped?: string[] }
  console.log(
    `[approvals] balanced mode: ${prefs.ok ? 'set' : 'FAILED'}; runtimes stopped: ` +
      `${JSON.stringify(stopped.stopped ?? [])} (restart answered ${restarted.status})`,
  )
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const pendingPath = (t: Target) => `/api/workspaces/${encodeURIComponent(t.workspaceId)}/approvals/pending`
const decidePath = (messageId: string) => `/api/conversation-messages/${encodeURIComponent(messageId)}/approval`

/** The card, as it looks on the wire: a decision message carrying an approval block. */
interface CardEvent {
  type: string
  message?: { id?: string; text?: string; blocks?: { type?: string; approval?: { requestId?: string; toolName?: string; status?: string } } }
}

function isApprovalCard(event: any): boolean {
  const blocks = event?.message?.blocks
  return (
    event?.type === 'message.created' &&
    (blocks?.type === 'approval_request' || /needs approval/i.test(String(event?.message?.text ?? '')))
  )
}

describeIfInfra('remote workspace · approvals', () => {
  for (const name of TARGET_NAMES) {
    describe(name, () => {
      test('the pending-approval list resolves on this workspace and is empty when nobody has asked', async () => {
        const t = target(name)
        const res = await read(t, pendingPath(t))
        expect(res.status, `${res.status} ${JSON.stringify(res.data).slice(0, 300)}`).toBe(200)
        expect(Array.isArray(res.data?.approvals), JSON.stringify(res.data).slice(0, 300)).toBe(true)
        expect(res.data.approvals.length, JSON.stringify(res.data.approvals).slice(0, 300)).toBe(0)
      }, 120_000)
    })
  }

  for (const name of TURN_TARGETS) {
    describe(`${name} · prompt`, () => {
      // The cause, measured on this harness (SHO-494 item 5): the desktop's
      // Security setting was written to `LocalConfig.SECURITY_PREFS` and read
      // only by `RuntimeManager.buildSecurityPolicy` — a private helper nothing
      // called. No local spawn ever carried `SECURITY_POLICY`, so every runtime
      // on a computer booted at the runtime's default (`full_autonomy`): the
      // scripted `exec` ran and the turn continued, and no card existed.
      //
      // It failed on the *desktop* target too because the desktop is where both
      // of these turns run: a hosted workspace's channel turn is spawned by the
      // computer as well, so both were silently `full_autonomy`. The fix is one
      // composer (`localSecurityPolicy`) called by both env builders, so a
      // project runtime and the workspace runtime that serves a hosted
      // workspace are spawned with the owner's own mode.
      test(
        'a gated tool call asks in the channel live, and approving it resumes the turn',
        async () => {
        const t = target(name)
        const seed = t.seed
        const tag = `perm${name}${Date.now().toString(36)}`
        const { live } = await openLive(t)

        // Half the tokens, then `exec` with a command that is not on the
        // runtime's shell allowlist, so balanced mode has to ask.
        const mention = agentMention(seed, `please run this ${marker('permission', tag, 6, { ms: 10 })}`)
        try {
          const posted = await send(t.api, 'POST', `/api/conversations/${encodeURIComponent(seed.channelId)}/messages`, {
            text: mention,
          })
          expect(posted.status, JSON.stringify(posted.data).slice(0, 300)).toBeLessThan(300)

          // 1. The card arrives on the open socket, with no GET in between.
          //    Generous budget: this target has to boot a runtime and run a
          //    model turn before the prompt exists at all.
          let arrived
          try {
            arrived = await live.waitForEvent(isApprovalCard, {
              label: 'the approval card',
              timeoutMs: 60_000,
            })
          } catch (err) {
            const turns = llm
              .requestsFor(tag)
              .map((t) => `round ${t.round}: ${t.sentAt.length} tokens, tool=${t.toolCalled ?? 'none'}`)
            throw new Error(`${(err as Error).message}\n  model requests: ${turns.join(' | ') || 'none'}`)
          }
          const card = arrived.event as CardEvent
          expect(String(card.message?.text ?? ''), 'the card names the tool it wants to run').toMatch(/approval/i)
          const messageId = String(card.message?.id ?? '')
          expect(messageId, `the card has an id: ${JSON.stringify(card).slice(0, 400)}`).toMatch(/\w/)

          // 2. The panel's own read agrees.
          await waitFor(
            'the card in /approvals/pending',
            async () => {
              const res = await read(t, pendingPath(t))
              return (res.data?.approvals ?? []).some((a: any) => a.messageId === messageId)
            },
            LIVE_BUDGET_MS * 2,
            250,
          )

          // 3. Deciding it from this side reaches the runtime, which continues
          //    the turn: the second half of the tokens follows.
          const decided = await send(t.api, 'POST', decidePath(messageId), { decision: 'approve' })
          expect(decided.status, JSON.stringify(decided.data).slice(0, 400)).toBeLessThan(300)
          await waitFor(
            'the turn to resume after the approval',
            () => llm.sentAt(tag).length >= 6,
            120_000,
            250,
          )

          // 4. The card reads answered, and the agent's reply carries the turn.
          //    Read the card by id: a decision is an `update` to the message it
          //    belongs to, and the list's page is a budget, not a guarantee.
          const decision = await read(t, `/api/conversation-messages/${encodeURIComponent(messageId)}`)
          const cardRow = decision.data?.message ?? null
          expect(cardRow, `the card reads back (${decision.status})`).not.toBeNull()
          expect(
            cardRow?.blocks?.approval?.status,
            `the card's approval block: ${JSON.stringify(cardRow?.blocks ?? null).slice(0, 400)}`,
          ).toBe('approved')
          // The reply is posted when the turn ends, and it lands in the thread
          // under the message that mentioned the agent — so the channel page is
          // the wrong place to look for it.
          const mentionId = String(posted.data?.message?.id ?? '')
          const thread = async () => {
            const res = await read(
              t,
              `/api/conversations/${encodeURIComponent(seed.channelId)}/messages?threadRootId=${encodeURIComponent(mentionId)}&limit=50`,
            )
            return [res.data?.root, ...(res.data?.messages ?? [])]
              .filter(Boolean)
              .map((m: any) => String(m.text ?? ''))
              .join('\n')
          }
          await waitFor(
            'the agent’s reply in the thread',
            async () => (await thread()).includes(token(tag, 6)),
            120_000,
            500,
          ).catch(() => {})
          expect(await thread(), `the agent's reply carries ${token(tag, 6)}`).toContain(token(tag, 6))
        } finally {
          live.close()
        }
        },
        300_000,
      )
    })
  }
})
