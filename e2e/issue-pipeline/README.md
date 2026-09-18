# Issue pipeline eval ladder

Phase 4 of [`docs/issue-pipeline/PLAN.md`](../../docs/issue-pipeline/PLAN.md):
the final eval is not a benchmark, it's "send Shogo this document and Shogo
builds and e2e-tests the system itself." This directory is the harness for
that ladder.

| Level | Given | Must produce | Test file |
| --- | --- | --- | --- |
| L0 | Whiteboard prose (baked into `issue-pipeline-solo`) + fixture repo with one planted bug | Single-project pipeline opens a PR fixing the bug | `l0-solo.integration.test.ts` |
| L1 | `shogo-system.yaml` applied to a workspace | Same outcome as L0 from 10 wired projects; `system_apply` is idempotent | `l1-multi-project.integration.test.ts` |
| L2 | Whiteboard prose only | Writes the manifest itself, then passes L1 | `l2-manifest-from-prose.integration.test.ts` |
| L3 | Three seeded runs with the same accepted security finding | Planner's `## Learned` section is amended | `l3-prompt-amendment.integration.test.ts` |
| L4 | `shogo-ai` fork + a real open issue | Mergeable PR | [`L4-RUNBOOK.md`](./L4-RUNBOOK.md) (manual — the plan's own assertion is "Human review") |

Like `e2e/channels/` and `e2e/replication/`, these are **integration** tests
against live infrastructure, not unit tests — they are not part of the
default `bun test` run. `helpers.test.ts` is the exception: it covers the
pure parsing/diffing logic in `helpers.ts` with no live dependencies, so it
runs in normal CI.

## Two ways these levels are driven

Following Decision 3 in PLAN.md ("Invocation = `project_call`. ... No new
transport") and Phase 2 ("the missing stage: GitHub comment → agent"), the
harness never talks to the agent runtime directly for anything that has a
real-world trigger:

- **L0, L1, L4** are pure GitHub black-box tests. They open an issue,
  post comments, and poll for the bot's comments/PRs on a real, disposable
  repo — exactly what a human or Phase 2's webhook handlers would see. See
  `helpers.ts`'s `gh` wrappers.
- **L2, L3** ask something that has no natural GitHub trigger ("here's the
  whiteboard, build the system" / "here are three findings, sweep now") and
  so go through WebChat (`../channels/helpers.ts`, the same client
  `e2e/channels/webchat.integration.test.ts` uses) directly to the relevant
  project's agent runtime.

## Fixture

[`fixtures/target-repo/`](./fixtures/target-repo/) is a tiny, self-contained
repo with exactly one planted bug (see its `ISSUE.md`). `resetFixtureRepo()`
force-pushes it to `$GITHUB_TEST_REPO` before each L0/L1 run so every run
starts from the same clean baseline. It has its own `bun test` suite you can
run standalone:

```bash
cd e2e/issue-pipeline/fixtures/target-repo && bun test
```

## Environment variables

| Variable | Required by | Description |
| --- | --- | --- |
| `GITHUB_TEST_REPO` | L0, L1 | `<owner>/<repo>` of a disposable repo connected via the Shogo GitHub App. Force-pushed to — must be disposable. |
| `FIXTURE_DIR` | L0, L1 (optional) | Overrides which fixture directory gets pushed. Defaults to `fixtures/target-repo`. |
| `AGENT_URL` | L1 (verification step), L2, L3 | Base URL of the relevant project's agent runtime — the harness/anchor project for L1/L2, the `retrospective` project for L3. Same shape as `e2e/channels/helpers.ts`. |
| `PLANNER_PROJECT_ID` | L3 | Id of the `planner` project, so the test can inspect its on-disk git history. |
| `WORKSPACES_ROOT` | L3 (optional) | Overrides the root `workspaces/` dir the harness reads project git history from. Defaults to the repo's own `workspaces/`. |
| `PROJECT_WORKSPACE_DIR_<projectId>` | L3 (optional) | Per-project override, if a project's workspace isn't under `WORKSPACES_ROOT`. |
| `PIPELINE_POLL_MS` | all | Poll interval while waiting on GitHub/agent state. Default `5000`. |
| `PIPELINE_TIMEOUT_MS` | all | Max wait for a full pipeline run. Default `1800000` (30 min) — these are real multi-turn capable-model runs across multiple projects, not chat replies. |

`gh` must be installed and authenticated with write access to
`$GITHUB_TEST_REPO` (issues + PRs) wherever these tests run.

## Running

```bash
# Pure logic, no live infra — runs in normal CI:
bun test e2e/issue-pipeline/helpers.test.ts

# L2 also has a no-live-infra half (schema validity of the checked-in manifest):
bun test e2e/issue-pipeline/l2-manifest-from-prose.integration.test.ts

# L0 — single project against a disposable repo:
GITHUB_TEST_REPO=<owner>/<repo> \
  bun test e2e/issue-pipeline/l0-solo.integration.test.ts

# L1 — full manifest, plus idempotency check against the anchor's agent:
GITHUB_TEST_REPO=<owner>/<repo> AGENT_URL=http://localhost:6200 \
  bun test e2e/issue-pipeline/l1-multi-project.integration.test.ts

# L2, both halves — a fresh project builds the manifest from prose alone:
AGENT_URL=http://localhost:6200 GITHUB_TEST_REPO=<owner>/<repo> \
  bun test e2e/issue-pipeline/l2-manifest-from-prose.integration.test.ts

# L3 — seed three findings, verify exactly one ## Learned amendment:
AGENT_URL=http://localhost:6201 PLANNER_PROJECT_ID=<uuid> \
  bun test e2e/issue-pipeline/l3-prompt-amendment.integration.test.ts
```

Or via the `package.json` scripts: `test:issue-pipeline:fixture`,
`test:issue-pipeline:l0` … `test:issue-pipeline:l3`. There is intentionally
no `test:issue-pipeline:l4` script — see `L4-RUNBOOK.md`.

## What "pass" means at each level

- **L0/L1**: a PR exists carrying the run's `runId`; a new test file the PR
  adds fails when run against the base branch and passes on the PR branch;
  the pipeline's analysis comment on the issue has exactly five numbered
  options.
- **L1 only**: additionally, asking the anchor project to dry-run
  `system_apply` again reports no pending create/attach/configure/file
  actions — the same idempotency bar `system-manifest.test.ts` and
  `issue-pipeline-template.test.ts` already enforce at the unit level, now
  proven live.
- **L2**: the manifest the agent produces parses with `parseSystemManifest`
  and has no dangling attachment targets; the resulting system then passes
  L1.
- **L3**: exactly one new commit lands on the planner's `AGENTS.md`, its
  diff touches only the `## Learned` section, and its commit message cites
  all three seeded runIds.
- **L4**: see `L4-RUNBOOK.md` — a human answers a checklist and decides
  whether they'd actually merge the PR.
