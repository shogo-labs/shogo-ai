// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-488 · group 7 — an agent's permission prompt, in a remote workspace.
 *
 * A permission prompt is a message in the conversation with
 * `blocks.type === 'approval_request'`; the panel reads the pending ones from
 * `GET /workspaces/:id/approvals/pending` and decides with
 * `POST /approvals/:messageId` (`services/conversation-approvals.ts`). On a
 * workspace hosted on a paired computer the card is written by the desktop's
 * agent and has to reach the cloud live, and the decision has to reach the
 * desktop and resume the same turn.
 *
 * What runs today is the read half, on all three targets: the pending list
 * resolves through the same path the panel uses — the cloud's own store for a
 * cloud workspace, and the desktop's runtime through the proxy for a hosted
 * one — and answers `{ approvals: [] }` on a workspace nobody has asked in. A
 * 501 or a proxy error there is exactly the failure that leaves a person
 * staring at a prompt that never arrives.
 *
 * The write half — the turn asks, the card shows in the cloud, approving it
 * from the cloud resumes the turn on the desktop — is `test.skip` below: the
 * scripted model (`apps/desktop/e2e/streaming/fake-llm-server.ts`) can only
 * call `read_file`, and a permission prompt only exists because the agent
 * emitted `data-permission-request` (`packages/agent-runtime/src/
 * permission-engine.ts:480`). Making this run needs a `permission` script in
 * that fixture (a gated tool call), not a change here.
 *
 * Needs `CHANNELS_TEST_PG_URL` and `TEST_REDIS_URL`/`REDIS_URL`. Skips without them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { FakeLlmServer } from '../../../../desktop/e2e/streaming/fake-llm-server'
import {
  TARGET_NAMES,
  openLive,
  read,
  startRemoteWorkspace,
  type RemoteWorkspace,
  type Target,
} from './harness'

const PG_URL = process.env.CHANNELS_TEST_PG_URL
const REDIS_URL = process.env.TEST_REDIS_URL || process.env.REDIS_URL
const describeIfInfra = PG_URL && REDIS_URL ? describe : describe.skip

let ws: RemoteWorkspace
let llm: FakeLlmServer
const target = (name: (typeof TARGET_NAMES)[number]): Target => ws.target(name)

beforeAll(async () => {
  if (!PG_URL || !REDIS_URL) return
  ws = await startRemoteWorkspace()
  llm = ws.llm
}, 600_000)

afterAll(async () => {
  await ws?.stop()
})

const pendingPath = (t: Target) => `/api/workspaces/${encodeURIComponent(t.workspaceId)}/approvals/pending`

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

      test.skip('a permission prompt posted on the desktop shows live in the cloud, and approving it there resumes the turn', async () => {
        // Blocked on the model fixture, not on this suite: see the file header.
        // When `fake-llm-server` can request permission, this is the shape:
        //
        //   const t = target(name)
        //   const { live: cloud } = await openLive({ ...t, peer: undefined })
        //   const turn = startTurn(t, `Ask ${marker('permission', tag, …)}`)
        //   // the card arrives on the socket, live
        //   await cloud.waitForEvent((e) => e.type === 'message.created' &&
        //     e.message?.blocks?.type === 'approval_request', { label: 'the approval card' })
        //   // the pending list has it, for the person who was pinged
        //   await waitFor('the card in /approvals/pending', async () =>
        //     (await read(t, pendingPath(t))).data?.approvals?.some((a) => a.tag === tag), LIVE_BUDGET_MS, 250)
        //   // deciding it from the cloud reaches the desktop, which resumes the turn
        //   const decided = await send(t.api, 'POST', `${approvePath(t)}`, { decision: 'allow' })
        //   expect(decided.status).toBeLessThan(300)
        //   await waitFor('the turn to continue on the desktop', async () =>
        //     llm.sentAt(tag).length > heldAt, 60_000, 250)
        void llm
      }, 240_000)
    })
  }
})
