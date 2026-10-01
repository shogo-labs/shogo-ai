// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Engineering team in a channel (eng-pod template), measured.
 *
 * A bug is posted in `#eng` with no @mention, on a small checkout app whose
 * coupon also discounts shipping (`fixtures/checkout-app`). The coordinator
 * triages it, the builder fixes it and opens a PR with a preview, the isolated
 * reviewer passes it, and the one thing a person does is approve the merge.
 *
 *   Records: time from the bug post to the PR and to the preview link, the
 *            messages a person had to read, the human interventions, and the
 *            wasted agent turns (definitions in `eng-pod-metrics.ts`). Results
 *            are printed and written to `RESULTS_DIR`
 *            (default `e2e/issue-pipeline/results/`) as JSON.
 *   Asserts: the run reaches a merged PR whose new test fails on the old code
 *            and passes on the fix, and meets the targets (PR under 15 min,
 *            at most 5 messages to read, exactly 1 intervention, 0 wasted
 *            turns). Set `ENG_POD_ENFORCE_TARGETS=0` to record without
 *            asserting the targets.
 *
 * Prerequisites: the eng-pod team applied to the workspace and its repo
 * connected to `GITHUB_TEST_REPO`: run `scripts/demo/seed-eng-pod.ts`.
 *
 * Run:
 *   GITHUB_TEST_REPO=<owner>/<repo> SHOGO_API_URL=http://localhost:8002 \
 *   SHOGO_API_KEY=shogo_sk_... WORKSPACE_ID=<id> \
 *     bun test ./e2e/issue-pipeline/l1-eng-pod-metrics.integration.test.ts
 *
 * Other env: FIXTURE_DIR (default fixtures/checkout-app), ENG_POD_CHANNEL
 * (default `eng`), SKIP_PREVIEW=1 (the pod has no preview URL configured).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkoutBaseBranch,
  checkoutPullRequest,
  getPipelineEnv,
  listPullRequests,
  runAllTests,
  waitUntil,
  type GhPullRequest,
  type PipelineEnv,
} from './helpers'
import {
  computeMetrics,
  formatMetrics,
  linksPreview,
  missedTargets,
  roleOf,
  TARGETS,
  type RunMessage,
} from './eng-pod-metrics'

const API_URL = (process.env.SHOGO_API_URL || 'http://localhost:8002').replace(/\/$/, '')
const API_KEY = process.env.SHOGO_API_KEY || ''
const WORKSPACE_ID = process.env.WORKSPACE_ID || ''
const CHANNEL_NAME = process.env.ENG_POD_CHANNEL || 'eng'
const SKIP_PREVIEW = process.env.SKIP_PREVIEW === '1'
const ENFORCE = process.env.ENG_POD_ENFORCE_TARGETS !== '0'
const RESULTS_DIR = process.env.RESULTS_DIR || join(import.meta.dir, 'results')

let env: PipelineEnv
let channelId: string

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
  return res.json() as Promise<T>
}

async function channelMessages(): Promise<RunMessage[]> {
  return (await api<{ messages: RunMessage[] }>('GET', `/conversations/${channelId}/messages?limit=200`)).messages
}

const inRun = (rootId: string) => (m: RunMessage) => m.id === rootId || m.threadRootId === rootId
const isAgent = (role: 'Coordinator' | 'Builder' | 'Reviewer') => (m: RunMessage) => m.authorType === 'agent' && roleOf(m) === role

beforeAll(async () => {
  env = getPipelineEnv()
  if (!process.env.FIXTURE_DIR) env = { ...env, fixtureDir: join(import.meta.dir, 'fixtures', 'checkout-app') }
  if (!API_KEY || !WORKSPACE_ID) throw new Error('SHOGO_API_KEY and WORKSPACE_ID are required (see README.md)')
  const { conversations } = await api<{ conversations: Array<{ id: string; name: string | null }> }>(
    'GET',
    `/workspaces/${WORKSPACE_ID}/conversations`,
  )
  const channel = conversations.find((c) => c.name === CHANNEL_NAME)
  if (!channel) throw new Error(`#${CHANNEL_NAME} not found; run scripts/demo/seed-eng-pod.ts first`)
  channelId = channel.id
})

describe('eng-pod: a bug in #eng ends in a merged PR with one human decision', () => {
  test(
    'coordinator → builder → reviewer → approval → merge, measured',
    async () => {
      // No repo reset here: the seed (`--reset-repo`) owns it. Force-pushing a new root commit now would
      // leave the pod's checkouts on a history that shares nothing with main, and no PR could be opened.
      const wait = (label: string) => ({ timeoutMs: env.timeoutMs, pollMs: env.pollMs, label })

      // The bug, posted the way a person would: no mention, no instructions.
      const startedAt = new Date()
      const { message: post } = await api<{ message: { id: string } }>('POST', `/conversations/${channelId}/messages`, {
        text: readFileSync(join(env.fixtureDir, 'BUG.md'), 'utf-8'),
      })
      const rootId = post.id

      // 1. The coordinator owns the thread and pins a task card to it.
      const card = await waitUntil(
        async () => (await channelMessages()).find((m) => inRun(rootId)(m) && isAgent('Coordinator')(m) && m.blocks?.type === 'status_card'),
        wait("the coordinator's task card in the thread"),
      )
      expect(card.blocks?.card).toBeDefined()

      // 2. The builder opens a PR (no run id here: a PR created after the post is this run's).
      const pr = await waitUntil<GhPullRequest>(
        async () =>
          (await listPullRequests(env, { state: 'all' })).find((p) => p.createdAt && new Date(p.createdAt) >= startedAt),
        wait('a pull request opened after the bug was posted'),
      )

      // 3. The preview link, on the card or in a reply.
      if (!SKIP_PREVIEW) {
        await waitUntil(
          async () => (await channelMessages()).find((m) => inRun(rootId)(m) && m.authorType === 'agent' && linksPreview(m)),
          wait('a preview link in the thread'),
        )
      }

      // 4. The isolated reviewer passes it.
      const verdict = await waitUntil(
        async () => (await channelMessages()).find((m) => inRun(rootId)(m) && isAgent('Reviewer')(m) && /^\W*(verdict\W*)?PASS\b/im.test(m.text)),
        wait("the reviewer's PASS"),
      )
      expect(verdict).toBeDefined()

      // 5. The merge waits for a person: the single intervention.
      const approval = await waitUntil(
        async () =>
          (await channelMessages()).find(
            (m) => inRun(rootId)(m) && m.authorType === 'agent' && m.blocks?.approval?.status === 'pending',
          ),
        wait('a merge approval card'),
      )
      await api('POST', `/conversation-messages/${approval.id}/approval`, { decision: 'approve' })

      // 6. It merges.
      const merged = await waitUntil<GhPullRequest>(
        async () => (await listPullRequests(env, { state: 'merged' })).find((p) => p.number === pr.number),
        wait(`PR #${pr.number} merged`),
      )

      // The fix is real: the PR's new test fails on the old code and passes on the fix.
      expect((await runAllTests(await checkoutBaseBranch(env, merged))).passed).toBe(false)
      expect((await runAllTests(await checkoutPullRequest(env, merged))).passed).toBe(true)

      const messages = await channelMessages()
      const metrics = computeMetrics({ messages, rootId, prCreatedAt: pr.createdAt })
      const missed = missedTargets(metrics)
      const report = formatMetrics(metrics)
      console.log(`\neng-pod run metrics\n${report}\n${missed.length ? `missed targets:\n- ${missed.join('\n- ')}` : 'all targets met'}\n`)

      mkdirSync(RESULTS_DIR, { recursive: true })
      const file = join(RESULTS_DIR, `eng-pod-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`)
      writeFileSync(
        file,
        JSON.stringify(
          { startedAt: startedAt.toISOString(), repo: env.githubTestRepo, pr: pr.url, rootId, targets: TARGETS, metrics, missed },
          null,
          2,
        ),
      )
      console.log(`results written to ${file}`)

      if (ENFORCE) expect(missed).toEqual([])
    },
    2 * 60 * 60 * 1000,
  )
})
