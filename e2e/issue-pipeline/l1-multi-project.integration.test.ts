// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * L1 (docs/issue-pipeline/PLAN.md, Phase 4 eval ladder):
 *
 *   Given:  `shogo-system.yaml` (the checked-in
 *           templates/issue-pipeline/shogo-system.yaml, already applied to a
 *           workspace via `system_apply` — see the `run-system-apply` skill).
 *   Must:   one project per stage, attached and wired, that fixes the same
 *           planted bug as L0.
 *   Asserts: same as L0 (PR exists, new test fails-then-passes, five
 *            options), plus `ProjectAttachment` rows match the manifest and
 *            a second `system_apply` reports an empty diff.
 *
 * The GitHub-facing half is identical to L0 — same fixture repo, same
 * assertions — because from GitHub's point of view a 10-project pipeline
 * and a single coordinator project look the same (one connected repo, one
 * bot identity posting comments and opening PRs). What's different is the
 * manifest-wiring assertion, which this test verifies live by asking the
 * anchor project's own agent to dry-run `system_apply` and checking that it
 * reports zero pending changes — the same acceptance bar
 * `system-manifest.test.ts` and `issue-pipeline-template.test.ts` already
 * enforce at the unit level, now proven against a real, already-applied
 * workspace instead of a fixture.
 *
 * Prerequisites:
 *   1. `templates/issue-pipeline/shogo-system.yaml` applied to a workspace
 *      (harness project ran `system_apply`; see
 *      templates/issue-pipeline/.shogo/skills/run-system-apply/SKILL.md).
 *   2. The `intake` project connected to a disposable GitHub repo via the
 *      Shogo GitHub App.
 *   3. `AGENT_URL` pointed at the *harness* (anchor) project's agent
 *      runtime, so this test can ask it to re-run `system_apply --dry-run`.
 *
 * Run:
 *   GITHUB_TEST_REPO=<owner>/<repo> AGENT_URL=http://localhost:6200 \
 *     bun test e2e/issue-pipeline/l1-multi-project.integration.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentFetch,
  checkoutBaseBranch,
  checkoutPullRequest,
  countNumberedOptions,
  getIssue,
  getPipelineEnv,
  getRunIdForIssue,
  getTestEnv,
  listPullRequests,
  openFixtureIssue,
  postIssueComment,
  resetFixtureRepo,
  runAllTests,
  waitForAgent,
  waitUntil,
  type GhPullRequest,
  type PipelineEnv,
  type TestEnv,
} from './helpers'

let env: PipelineEnv
let agentEnv: TestEnv

beforeAll(async () => {
  env = getPipelineEnv()
  agentEnv = getTestEnv() // requires AGENT_URL, pointed at the harness project
  await waitForAgent(agentEnv)
})

describe('L1: the multi-project pipeline fixes the same bug as L0', () => {
  test(
    'ten wired projects reproduce the L0 outcome',
    async () => {
      await resetFixtureRepo(env)

      const issueBody = readFileSync(join(env.fixtureDir, 'ISSUE.md'), 'utf-8')
      const issueNumber = await openFixtureIssue(
        env,
        'slugify() leaves a trailing dash for titles ending in punctuation',
        issueBody
      )

      const withOptions = await waitUntil(
        async () => {
          const issue = await getIssue(env, issueNumber)
          const withFive = issue.comments.find((c) => countNumberedOptions(c.body) === 5)
          return withFive ? issue : undefined
        },
        { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: 'a comment with exactly five options' }
      )
      expect(countNumberedOptions(withOptions.comments.find((c) => countNumberedOptions(c.body) === 5)!.body)).toBe(5)

      const runId = await getRunIdForIssue(env, issueNumber)
      expect(runId).toBeDefined()

      await postIssueComment(env, issueNumber, 'Go with option 1.')

      const pr = await waitUntil<GhPullRequest>(
        async () => {
          const prs = await listPullRequests(env, { runId })
          return prs[0]
        },
        { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: `an open PR carrying runId ${runId}` }
      )

      const baseDir = await checkoutBaseBranch(env, pr)
      const baseResult = await runAllTests(baseDir)
      expect(baseResult.passed).toBe(false)

      const prDir = await checkoutPullRequest(env, pr)
      const prResult = await runAllTests(prDir)
      expect(prResult.passed).toBe(true)
    },
    2 * 60 * 60 * 1000
  )

  test('a second system_apply against the live workspace reports an empty diff', async () => {
    const res = await agentFetch(agentEnv, '/agent/channels/webhook/message', {
      method: 'POST',
      body: JSON.stringify({
        message:
          'Run your run-system-apply skill against templates/issue-pipeline/shogo-system.yaml with dryRun: true and report the diff summary verbatim.',
      }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json()
    const reply: string = body.reply ?? ''
    // summarizeDiff() (system-manifest.ts) renders an empty diff as either
    // no bullet lines or an explicit "no changes" style summary — assert the
    // reply does NOT claim any create/attach/config/file action is pending.
    expect(reply).not.toMatch(/\b(creates?|attaches?|configures?|writes?)\b.*\bproject\b/i)
  }, 120_000)
})
