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
  channelMessages,
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
      // Measured on this harness (17:54, with the desktop's Security mode set to
      // `balanced` and its runtimes restarted first): the model's `exec` call
      // runs and the turn continues — `model requests: round 0: 3 tokens,
      // tool=exec | round 1: 3 tokens` — and no prompt is ever emitted, so no
      // card exists to approve.
      //
      // Why: a runtime serving a *cloud* workspace is spawned with the cloud's
      // policy, and `composeCloudPolicy` (`apps/api/src/lib/security-policy.ts`)
      // only carries per-tool action rules and deny lists — its `mode` is hard
      // coded to `full_autonomy`, and with no rules configured it returns `null`
      // at all. The person's own Security setting (`SECURITY_PREFS`) is never
      // consulted on that path, so a hosted workspace cannot ask, whatever the
      // setting says.
      //
      // The assertion below is the behaviour the card requires, kept as
      // `test.failing` so it runs: the day a prompt is possible here, this goes
      // red and the marker flips to `test`.
      test.failing(
        'a gated tool call asks in the channel live, and approving it resumes the turn [a hosted runtime is never asked]',
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
          const messages = await channelMessages(t, seed.channelId)
          const cardRow = messages.find((m) => m.id === messageId)
          expect(cardRow?.blocks?.approval?.status, JSON.stringify(cardRow?.blocks).slice(0, 400)).toBe('approved')
          const said = messages.map((m) => String(m.text ?? '')).join('\n')
          expect(said, `the agent's reply carries ${token(tag, 6)}`).toContain(token(tag, 6))
        } finally {
          live.close()
        }
        },
        300_000,
      )
    })
  }
})
