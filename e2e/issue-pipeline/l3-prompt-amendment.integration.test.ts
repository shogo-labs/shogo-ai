// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * L3 (docs/issue-pipeline/PLAN.md, Phase 4 eval ladder):
 *
 *   Given:  three seeded runs with the same accepted security finding.
 *   Must:   amend the planner's prompt.
 *   Asserts: only `## Learned` changed; the checkpoint message cites all
 *            three runIds.
 *
 * This exercises the "evolve in the wild, not in evals" loop from Decision 4
 * in PLAN.md directly: seed the `retrospective` project's `Finding` table
 * via three `record-finding` calls (same reviewer + category, `accepted:
 * true`, `planGap: true` so blame lands on `planner` — see
 * `retrospective/AGENTS.md`'s Attribute step), trigger its `amend-prompt`
 * skill once (a heartbeat sweep would eventually do this on its own; this
 * test asks for it directly so the run doesn't depend on the heartbeat
 * interval), then inspect `planner`'s on-disk git history.
 *
 * Prerequisites:
 *   1. The multi-project pipeline applied to a *local* workspace (this test
 *      reads git history straight off disk under `workspaces/<projectId>/`
 *      — see `projectWorkspaceDir()` in helpers.ts. Point `WORKSPACES_ROOT`
 *      at the right `workspaces/` dir, or set
 *      `PROJECT_WORKSPACE_DIR_<projectId>` overrides per project).
 *   2. `AGENT_URL` pointed at the `retrospective` project's agent runtime.
 *   3. `PLANNER_PROJECT_ID` — the id of the `planner` project, so this test
 *      knows which workspace dir's git history to inspect.
 *
 * Run:
 *   AGENT_URL=http://localhost:6201 PLANNER_PROJECT_ID=<uuid> \
 *     bun test e2e/issue-pipeline/l3-prompt-amendment.integration.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import {
  agentFetch,
  extractLearnedSection,
  fileAtHead,
  fileBeforeRevision,
  getTestEnv,
  latestCommitTouching,
  projectWorkspaceDir,
  runIdsInText,
  sectionsChangedOutsideLearned,
  waitForAgent,
  waitUntil,
  type TestEnv,
} from './helpers'

let agentEnv: TestEnv
let plannerProjectId: string

beforeAll(async () => {
  agentEnv = getTestEnv()
  await waitForAgent(agentEnv)
  plannerProjectId = process.env.PLANNER_PROJECT_ID || ''
  if (!plannerProjectId) throw new Error('PLANNER_PROJECT_ID is required (the planner project to inspect after the amendment).')
})

describe('L3: three recurring accepted security findings amend the planner prompt', () => {
  test(
    'seeding three runs with the same finding produces exactly one ## Learned amendment citing all three runIds',
    async () => {
      const plannerDir = projectWorkspaceDir(plannerProjectId)
      const before = await latestCommitTouching(plannerDir, 'AGENTS.md')

      const runIds = ['run_eval_l3_a', 'run_eval_l3_b', 'run_eval_l3_c']
      const category = 'missing-authz-check'

      for (const runId of runIds) {
        const res = await agentFetch(agentEnv, '/agent/channels/webhook/message', {
          method: 'POST',
          body: JSON.stringify({
            message: [
              'Use your record-finding skill to persist this finding exactly as given (this is a seeded eval finding, already judged — do not re-review anything):',
              JSON.stringify({
                id: `finding_${runId}`,
                runId,
                reviewer: 'security',
                category,
                severity: 'high',
                summary: 'Endpoint is missing an authorization check on the write path.',
                planGap: true,
                accepted: true,
                resolution: 'fixed-in-pr',
                createdAt: new Date().toISOString(),
                resolvedAt: new Date().toISOString(),
              }),
            ].join('\n'),
          }),
        })
        expect(res.ok).toBe(true)
      }

      // Trigger the sweep directly rather than waiting for HEARTBEAT.md's cadence.
      const sweepRes = await agentFetch(agentEnv, '/agent/channels/webhook/message', {
        method: 'POST',
        body: JSON.stringify({
          message: `Run your amend-prompt skill's amendment sweep now for the (security, ${category}) group. Report which project you amended and the runIds you cited.`,
        }),
      })
      expect(sweepRes.ok).toBe(true)

      const after = await waitUntil(
        async () => {
          const commit = await latestCommitTouching(plannerDir, 'AGENTS.md')
          return commit && commit.sha !== before?.sha ? commit : undefined
        },
        { timeoutMs: 10 * 60 * 1000, pollMs: 5000, label: "a new commit touching planner's AGENTS.md" }
      )

      // Checkpoint message cites all three runIds (per the Hygiene Rules).
      const citedRunIds = runIdsInText(after.message)
      for (const runId of runIds) {
        expect(citedRunIds, `commit message did not cite ${runId}:\n${after.message}`).toContain(runId)
      }

      // Only ## Learned changed.
      const beforeText = await fileBeforeRevision(plannerDir, after.sha, 'AGENTS.md')
      const afterText = await fileAtHead(plannerDir, after.sha, 'AGENTS.md')
      expect(sectionsChangedOutsideLearned(beforeText, afterText)).toEqual([])

      const learnedAfter = extractLearnedSection(afterText) ?? ''
      const learnedBefore = extractLearnedSection(beforeText) ?? ''
      expect(learnedAfter).not.toBe(learnedBefore)
      expect(learnedAfter.toLowerCase()).toContain('authz')
    },
    30 * 60 * 1000
  )
})
