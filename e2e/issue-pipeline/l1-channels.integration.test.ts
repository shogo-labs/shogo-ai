// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * L1 with team chat (docs/issue-pipeline/PLAN.md, Decision 5): the same
 * planted bug as L1, but each run lives in one `#issue-pipeline` thread and the
 * stages hand off by @mentioning each other there. GitHub gets a mirror.
 *
 *   Asserts: Intake opens the thread; Analyst, Planner and Implementer reply in
 *            it in that order; Done Gate posts its verdict there; the options
 *            are mirrored to the issue with a link to the thread; a PR carrying
 *            the runId fixes the bug. The pick can come from the thread or
 *            from a plain GitHub comment, which Intake copies into the thread.
 *
 * Prerequisites: everything L1 needs (manifest applied, Intake connected to
 * the disposable repo), with a `system_apply` recent enough to have created
 * `#issue-pipeline` and `#pipeline-alerts`.
 *
 * Run:
 *   GITHUB_TEST_REPO=<owner>/<repo> SHOGO_API_URL=http://localhost:8002 \
 *   SHOGO_API_KEY=shogo_sk_... WORKSPACE_ID=<id> \
 *     bun test ./e2e/issue-pipeline/l1-channels.integration.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkoutBaseBranch,
  checkoutPullRequest,
  countNumberedOptions,
  getIssue,
  getPipelineEnv,
  getRunIdForIssue,
  listPullRequests,
  openFixtureIssue,
  postIssueComment,
  resetFixtureRepo,
  runAllTests,
  waitUntil,
  type GhPullRequest,
  type PipelineEnv,
} from './helpers'

interface ChatMessage {
  id: string
  seq: number
  threadRootId: string | null
  authorType: 'user' | 'agent' | 'system'
  authorAgent: { name?: string } | null
  text: string
  agentStatus: string | null
}

const API_URL = (process.env.SHOGO_API_URL || 'http://localhost:8002').replace(/\/$/, '')
const API_KEY = process.env.SHOGO_API_KEY || ''
const WORKSPACE_ID = process.env.WORKSPACE_ID || ''

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

async function channelMessages(): Promise<ChatMessage[]> {
  return (await api<{ messages: ChatMessage[] }>('GET', `/conversations/${channelId}/messages?limit=100`)).messages
}

async function threadReplies(rootId: string): Promise<ChatMessage[]> {
  const res = await api<{ messages: ChatMessage[] }>('GET', `/conversations/${channelId}/messages?threadRootId=${rootId}`)
  return res.messages.filter((m) => m.authorType !== 'agent' || m.agentStatus === 'done')
}

const byStage = (stage: string) => (m: ChatMessage) => m.authorType === 'agent' && !!m.authorAgent?.name?.includes(stage)

beforeAll(async () => {
  env = getPipelineEnv()
  if (!API_KEY || !WORKSPACE_ID) throw new Error('SHOGO_API_KEY and WORKSPACE_ID are required (see README.md)')
  const { conversations } = await api<{ conversations: Array<{ id: string; name: string | null }> }>(
    'GET',
    `/workspaces/${WORKSPACE_ID}/conversations`,
  )
  const channel = conversations.find((c) => c.name === 'issue-pipeline')
  if (!channel) throw new Error('#issue-pipeline not found; re-run system_apply with the current manifest')
  channelId = channel.id
})

/** Opens the fixture issue and waits for Intake's thread and Analyst's options in it. */
async function startRun(title: string) {
  await resetFixtureRepo(env)
  const before = new Set((await channelMessages()).map((m) => m.id))
  const issueNumber = await openFixtureIssue(env, title, readFileSync(join(env.fixtureDir, 'ISSUE.md'), 'utf-8'))

  const root = await waitUntil(
    async () => (await channelMessages()).find((m) => !before.has(m.id) && !m.threadRootId && byStage('Intake')(m)),
    { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: `Intake's #issue-pipeline thread for issue #${issueNumber}` },
  )
  const options = await waitUntil(
    async () => (await threadReplies(root.id)).find((m) => byStage('Analyst')(m) && countNumberedOptions(m.text) === 5),
    { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: "Analyst's five options in the thread" },
  )
  expect(options).toBeDefined()

  const mirrored = await waitUntil(
    async () => (await getIssue(env, issueNumber)).comments.find((c) => countNumberedOptions(c.body) === 5 && c.body.includes(`thread=${root.id}`)),
    { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: 'the options mirrored to the issue with a thread link' },
  )
  expect(mirrored).toBeDefined()
  const runId = await getRunIdForIssue(env, issueNumber)
  expect(runId).toBeDefined()
  return { issueNumber, root, runId: runId! }
}

/** Waits for the hand-offs after the pick and checks the PR fixes the bug. */
async function finishRun(rootId: string, runId: string) {
  const pr = await waitUntil<GhPullRequest>(
    async () => (await listPullRequests(env, { runId }))[0],
    { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: `an open PR carrying runId ${runId}` },
  )
  const replies = await waitUntil(
    async () => {
      const all = await threadReplies(rootId)
      return all.some((m) => byStage('Implementer')(m) && m.text.includes('PR ready')) ? all : undefined
    },
    { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: "Implementer's PR-ready reply in the thread" },
  )

  const first = (stage: string) => replies.findIndex(byStage(stage))
  expect(first('Analyst')).toBeGreaterThanOrEqual(0)
  expect(first('Planner')).toBeGreaterThan(first('Analyst'))
  expect(first('Implementer')).toBeGreaterThan(first('Planner'))
  const verdict = replies.findIndex((m) => byStage('Done Gate')(m) || /done gate/i.test(m.text))
  const ready = replies.findIndex((m) => byStage('Implementer')(m) && m.text.includes('PR ready'))
  expect(verdict).toBeGreaterThanOrEqual(0)
  expect(verdict).toBeLessThan(ready)
  expect(replies.some((m) => m.authorType === 'system' && m.text.startsWith('Paused'))).toBe(false)

  expect((await runAllTests(await checkoutBaseBranch(env, pr))).passed).toBe(false)
  expect((await runAllTests(await checkoutPullRequest(env, pr))).passed).toBe(true)
}

describe('L1 with team chat: one thread per run, stages hand off by @mention', () => {
  test(
    'the pick is made in the thread',
    async () => {
      const { root, runId } = await startRun('slugify() leaves a trailing dash for titles ending in punctuation')
      // No mention: it goes to Intake, the thread owner.
      await api('POST', `/conversations/${channelId}/messages`, { text: 'Go with option 1.', threadRootId: root.id })
      await finishRun(root.id, runId)
    },
    2 * 60 * 60 * 1000,
  )

  test(
    'a pick made on GitHub is copied into the thread and the run continues there',
    async () => {
      const { issueNumber, root, runId } = await startRun('slugify() trailing dash (GitHub pick)')
      await postIssueComment(env, issueNumber, 'Go with option 1.')
      await waitUntil(
        async () => (await threadReplies(root.id)).find((m) => byStage('Intake')(m) && m.text.includes('Go with option 1')),
        { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: 'the GitHub pick copied into the thread' },
      )
      await finishRun(root.id, runId)
    },
    2 * 60 * 60 * 1000,
  )
})
