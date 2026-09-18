// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * L0 (docs/issue-pipeline/PLAN.md, Phase 4 eval ladder):
 *
 *   Given:  whiteboard prose (baked into the `issue-pipeline-solo` template's
 *           AGENTS.md/`.shogo/agents/*.md`) + a fixture repo with one
 *           planted bug.
 *   Must:   a single-project pipeline that opens a PR fixing the bug.
 *   Asserts: PR exists; a new test fails on base, passes on branch; the
 *            tracker comment has exactly five options.
 *
 * This is a black-box test: it never talks to the agent runtime directly.
 * It only does what a human/GitHub would do — open an issue on a real repo
 * — and polls GitHub for the pipeline's reactions, exactly like Phase 2's
 * webhook handlers expect. The "tracker" here is the GitHub issue itself
 * (the `github-issues` TaskSource adapter — see
 * templates/issue-pipeline-solo/.shogo/skills/task-source-github-issues/SKILL.md).
 *
 * Prerequisites:
 *   1. A disposable GitHub repo, connected via the Shogo GitHub App to a
 *      project created FROM the `issue-pipeline-solo` template.
 *   2. `gh` authenticated with write access to that repo (issues + PRs).
 *
 * Run:
 *   GITHUB_TEST_REPO=<owner>/<repo> bun test e2e/issue-pipeline/l0-solo.integration.test.ts
 *
 * This test issues real LLM turns across a multi-stage agent pipeline; a
 * full run can take many minutes. Default timeout is 30 minutes
 * (PIPELINE_TIMEOUT_MS).
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

let env: PipelineEnv

beforeAll(() => {
  env = getPipelineEnv()
})

describe('L0: issue-pipeline-solo fixes the planted bug end to end', () => {
  test(
    'opens an issue, gets five options, picks one, and lands a PR with a real regression test',
    async () => {
      await resetFixtureRepo(env)

      const issueBody = readFileSync(join(env.fixtureDir, 'ISSUE.md'), 'utf-8')
      const issueNumber = await openFixtureIssue(
        env,
        'slugify() leaves a trailing dash for titles ending in punctuation',
        issueBody
      )

      // ── Step 1: intake reproduces + analyst proposes five options ──────
      const withOptions = await waitUntil(
        async () => {
          const issue = await getIssue(env, issueNumber)
          const withFive = issue.comments.find((c) => countNumberedOptions(c.body) === 5)
          return withFive ? issue : undefined
        },
        { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: 'a comment with exactly five options' }
      )
      const optionsComment = withOptions.comments.find((c) => countNumberedOptions(c.body) === 5)!
      expect(countNumberedOptions(optionsComment.body)).toBe(5)

      const runId = await getRunIdForIssue(env, issueNumber)
      expect(runId, 'expected a <!-- shogo:runId=... --> marker on the issue or a comment').toBeDefined()

      // ── Step 2: human-in-the-loop pick ──────────────────────────────────
      await postIssueComment(env, issueNumber, 'Go with option 1.')

      // ── Step 3: plan -> implement -> review -> gate -> PR ───────────────
      const pr = await waitUntil<GhPullRequest>(
        async () => {
          const prs = await listPullRequests(env, { runId })
          return prs[0]
        },
        { timeoutMs: env.timeoutMs, pollMs: env.pollMs, label: `an open PR carrying runId ${runId}` }
      )
      expect(pr.number).toBeGreaterThan(0)

      // The implementer must not touch the frozen baseline suite (see the
      // comment at the top of fixtures/target-repo/src/slugify.test.ts).
      expect(pr.files.some((f) => f.path.endsWith('slugify.test.ts'))).toBe(false)
      const newTestFiles = pr.files.filter((f) => /\.test\.ts$/.test(f.path))
      expect(newTestFiles.length).toBeGreaterThan(0)

      // ── Step 4: the new test must fail on base and pass on the PR branch ─
      const baseDir = await checkoutBaseBranch(env, pr)
      const baseResult = await runAllTests(baseDir)
      expect(baseResult.passed, `expected the base branch to still reproduce the bug:\n${baseResult.output}`).toBe(false)

      const prDir = await checkoutPullRequest(env, pr)
      const prResult = await runAllTests(prDir)
      expect(prResult.passed, `expected the PR branch to be green:\n${prResult.output}`).toBe(true)
    },
    2 * 60 * 60 * 1000 // outer bun:test timeout; PIPELINE_TIMEOUT_MS governs the actual wait
  )
})
