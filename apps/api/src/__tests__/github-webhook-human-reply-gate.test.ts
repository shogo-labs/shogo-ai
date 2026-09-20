// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression: `handleIssueCommentWebhook`/`handlePullRequestReviewWebhook`/
 * `handlePullRequestReviewCommentWebhook` (services/github.service.ts) used
 * to gate on `mentionsBot(text) || isBotLogin(issue.user?.login)` alone
 * before ever trying to wake the connected project. In practice a human
 * reporter — never the bot — opens the issue, and a plain human reply like
 * "Go with option 1." never @-mentions anyone, so that gate almost always
 * evaluated false and the handler returned before touching the DB at all.
 *
 * This silently stalled the issue-pipeline's human-in-the-loop step (the
 * analyst posts 5 options, a human replies "option N", intake should wake
 * back up) with zero error anywhere — found live running the
 * `l1-multi-project.integration.test.ts` eval: the webhook delivered fine
 * (200 OK per GitHub's own delivery log) but intake never re-engaged.
 *
 * The fix adds a third OR branch: if the issue/PR body already carries a
 * tracked `runId` marker (`runIdMarker`/`extractRunId` — embedded once the
 * pipeline starts tracking a run), wake regardless of who's replying. This
 * test proves the gate now passes for that case by asserting the handler
 * gets far enough to hit `findConnectionByRepo` (mocked to return no
 * connection, so we can observe the "no project connected" log without
 * needing a real project/runtime).
 *
 * Run: bun test ./apps/api/src/__tests__/github-webhook-human-reply-gate.test.ts
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const findFirstCalls: any[] = []
let connectionToReturn: any = null
const mockPrisma = {
  gitHubConnection: {
    findFirst: mock(async (args: any) => {
      findFirstCalls.push(args)
      return connectionToReturn // no connected project by default — short-circuits wakeConnectedProjectAgent
    }),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma: mockPrisma as any }))

const callProjectAgentCalls: any[] = []
mock.module('../services/agent-call.service', () => ({
  callProjectAgent: mock(async (_c: any, projectId: string, workspaceId: string, req: any) => {
    callProjectAgentCalls.push({ projectId, workspaceId, ...req })
    return { status: 202, body: {} }
  }),
}))

const {
  handleIssueWebhook,
  handleIssueCommentWebhook,
  handlePullRequestReviewWebhook,
  handlePullRequestReviewCommentWebhook,
} = await import('../services/github.service')

const fakeContext = {} as any

beforeEach(() => {
  findFirstCalls.length = 0
  callProjectAgentCalls.length = 0
  connectionToReturn = null
  mockPrisma.gitHubConnection.findFirst.mockClear()
})

/**
 * Regression: `handleIssueWebhook` (new "issue opened" events) used to wake
 * the connected project with no `runId` at all. `callProjectAgent`'s session
 * key defaults to `run:<runId>` (agent-call.service.ts) only when a runId is
 * given — with none, every new-issue event on a project fell into the same
 * default session, so the full turn history of every previously-seen issue
 * (including intake's own past tool calls, which happen to mention *other*
 * issues' runIds) stayed in context. On a fixture that reopens byte-for-byte
 * identical bug reports, this reliably made intake regurgitate a stale runId
 * from a prior issue instead of minting a fresh one for the current issue
 * number — found live running the L1 multi-project eval (every issue after
 * the first got the wrong runId in its posted-options comment). The fix
 * assigns a deterministic `run-issue-<number>` up front and states it
 * explicitly in the message, so each issue gets its own isolated session and
 * never needs to improvise (or copy) an id.
 */
describe('handleIssueWebhook assigns a deterministic per-issue runId', () => {
  test('a new "issue opened" event is woken with runId=run-issue-<number>, stated in the message', async () => {
    connectionToReturn = { project: { id: 'proj-1', workspaceId: 'ws-1' } }

    await handleIssueWebhook(fakeContext, {
      action: 'opened',
      repository: { full_name: 'acme/widgets' },
      installation: { id: 42 },
      issue: {
        number: 99,
        title: 'Something is broken',
        body: 'Steps to reproduce...',
        html_url: 'https://github.com/acme/widgets/issues/99',
      },
    })

    expect(callProjectAgentCalls.length).toBe(1)
    expect(callProjectAgentCalls[0].runId).toBe('run-issue-99')
    expect(callProjectAgentCalls[0].message).toContain('#99')
    expect(callProjectAgentCalls[0].message).toContain('run-issue-99')
  })

  test('two different issues on the same project get two different runIds (no shared/default session)', async () => {
    connectionToReturn = { project: { id: 'proj-1', workspaceId: 'ws-1' } }

    await handleIssueWebhook(fakeContext, {
      action: 'opened',
      repository: { full_name: 'acme/widgets' },
      issue: { number: 100, title: 'Bug A', body: 'Same repro text every time', html_url: 'https://x/100' },
    })
    await handleIssueWebhook(fakeContext, {
      action: 'opened',
      repository: { full_name: 'acme/widgets' },
      issue: { number: 101, title: 'Bug A', body: 'Same repro text every time', html_url: 'https://x/101' },
    })

    expect(callProjectAgentCalls.length).toBe(2)
    expect(callProjectAgentCalls[0].runId).toBe('run-issue-100')
    expect(callProjectAgentCalls[1].runId).toBe('run-issue-101')
  })

  test('a non-"opened" issue action (e.g. labeled) is still ignored', async () => {
    connectionToReturn = { project: { id: 'proj-1', workspaceId: 'ws-1' } }

    await handleIssueWebhook(fakeContext, {
      action: 'labeled',
      repository: { full_name: 'acme/widgets' },
      issue: { number: 102, title: 'Bug', body: 'x', html_url: 'https://x/102' },
    })

    expect(callProjectAgentCalls.length).toBe(0)
  })
})

describe('handleIssueCommentWebhook wakes on a tracked-run reply even with no bot mention', () => {
  test('a plain human reply ("Go with option 1.") on an issue that already has a runId marker wakes the agent', async () => {
    await handleIssueCommentWebhook(fakeContext, {
      action: 'created',
      repository: { full_name: 'acme/widgets' },
      issue: {
        number: 60,
        user: { login: 'a-human-reporter' }, // NOT the bot — the common case
        body: 'Something is broken.\n\n<!-- shogo:runId=abc-123 -->',
      },
      comment: {
        user: { login: 'a-human-reporter' },
        body: 'Go with option 1.', // no @-mention of the bot at all
        html_url: 'https://github.com/acme/widgets/issues/60#issuecomment-1',
      },
    })

    // Reaching findConnectionByRepo means the gate did NOT return early.
    expect(mockPrisma.gitHubConnection.findFirst.mock.calls.length).toBe(1)
    expect(findFirstCalls[0].where.repoFullName).toBe('acme/widgets')
  })

  test('a plain human reply on an issue with NO tracked runId and no bot mention is correctly ignored', async () => {
    await handleIssueCommentWebhook(fakeContext, {
      action: 'created',
      repository: { full_name: 'acme/widgets' },
      issue: {
        number: 61,
        user: { login: 'a-human-reporter' },
        body: 'Something else is broken.', // no runId — pipeline never touched this issue
      },
      comment: {
        user: { login: 'a-human-reporter' },
        body: 'any thoughts?',
        html_url: 'https://github.com/acme/widgets/issues/61#issuecomment-2',
      },
    })

    expect(mockPrisma.gitHubConnection.findFirst.mock.calls.length).toBe(0)
  })

  test('a comment that @-mentions the bot still wakes the agent even with no runId (unchanged behavior)', async () => {
    await handleIssueCommentWebhook(fakeContext, {
      action: 'created',
      repository: { full_name: 'acme/widgets' },
      issue: { number: 62, user: { login: 'a-human-reporter' }, body: 'No runId here.' },
      comment: {
        user: { login: 'a-human-reporter' },
        body: '@shogo-ai please take a look',
        html_url: 'https://github.com/acme/widgets/issues/62#issuecomment-3',
      },
    })

    expect(mockPrisma.gitHubConnection.findFirst.mock.calls.length).toBe(1)
  })
})

describe('PR review webhooks get the same runId fallback', () => {
  test('handlePullRequestReviewWebhook wakes on a tracked-run PR even with a plain "LGTM"', async () => {
    await handlePullRequestReviewWebhook(fakeContext, {
      action: 'submitted',
      repository: { full_name: 'acme/widgets' },
      pull_request: { number: 7, user: { login: 'a-human-author' }, body: '<!-- shogo:runId=xyz-789 -->' },
      review: { user: { login: 'a-human-reviewer' }, state: 'approved', body: 'LGTM' },
    })

    expect(mockPrisma.gitHubConnection.findFirst.mock.calls.length).toBe(1)
  })

  test('handlePullRequestReviewCommentWebhook wakes on a tracked-run PR even with a plain inline comment', async () => {
    await handlePullRequestReviewCommentWebhook(fakeContext, {
      action: 'created',
      repository: { full_name: 'acme/widgets' },
      pull_request: { number: 8, user: { login: 'a-human-author' }, body: '<!-- shogo:runId=xyz-000 -->' },
      comment: {
        user: { login: 'a-human-reviewer' },
        body: 'nit: rename this',
        path: 'src/index.ts',
        line: 12,
        html_url: 'https://github.com/acme/widgets/pull/8#discussion_r1',
      },
    })

    expect(mockPrisma.gitHubConnection.findFirst.mock.calls.length).toBe(1)
  })
})
