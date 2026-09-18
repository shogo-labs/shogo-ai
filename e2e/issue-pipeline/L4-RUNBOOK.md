# L4 runbook: `shogo-ai` fork + a real open issue

From `docs/issue-pipeline/PLAN.md`, Phase 4:

| Level | Given | Must produce | Assertions |
| --- | --- | --- | --- |
| L4 | `shogo-ai` fork + a real open issue | Mergeable PR | Human review |

L4 is deliberately **not** a `bun test` file. L0–L3 assert mechanical
properties (does a PR exist, does a test fail-then-pass, does a commit
message cite three runIds) that a script can check unattended. L4 asks a
different question — "is this actually a good PR against our real codebase"
— and the plan's own assertion column says so: **Human review**. Automating
that away would defeat the point of the level. This document is the runbook
a human follows to run L4 and judge it.

## Why a fork, not `shogo-ai` itself

The pipeline opens issues, comments, and PRs through a GitHub App connection
with write access. Point it at a fork so a bad run can't touch the real
repo's issue tracker, labels, or `main` branch. Once L0–L3 are "boringly
green" (see PLAN.md's Risks section) for a while, this can graduate to
running against `shogo-ai` directly with tighter scoping (e.g. a dedicated
`pipeline/` label + branch prefix), but that's a separate decision, not part
of this eval.

## Setup

1. Fork `shogo-ai` to a throwaway org/account.
2. Install the Shogo GitHub App on the fork only.
3. Stand up the pipeline against the fork — either:
   - the `issue-pipeline-solo` template (fast path), or
   - the full `templates/issue-pipeline/shogo-system.yaml` manifest (more
     representative of what a team would actually run), connecting its
     `intake` project to the fork.
4. Pick a real, currently-open, well-scoped issue on `shogo-ai` — small
   enough that a human could review the fix in one sitting (a good target:
   something already labeled `bug`, with a clear repro, that doesn't touch
   auth/billing/data-migration code paths). Cross-post it (or a paraphrase)
   as a new issue on the fork; do not let the pipeline write to the
   real `shogo-ai` issue.

## Run

1. Open the issue on the fork. Wait for the five-options comment (same
   mechanics as L0 — reuse `openFixtureIssue`/`getIssue`/`countNumberedOptions`
   from `helpers.ts` in a scratch script if you want the wait automated;
   the pick and the review are still manual).
2. Read the five options. Pick one like a human reviewer actually would —
   don't rubber-stamp option 1 the way L0/L1's scripted "Go with option 1"
   does. Comment your pick and reasoning.
3. Let the pipeline plan, implement, review, and open the PR.
4. If review findings come back and the implementer iterates, follow along;
   this is the "react to human comments" leg and is part of what's being
   evaluated.

## Judge (this is the actual eval)

Answer these before merging anything:

- [ ] Does the PR actually fix the real issue, not just the paraphrase?
- [ ] Is the regression test meaningful (fails without the fix, passes with
      it, and isn't just asserting the implementation's own internals)?
- [ ] Would you have written substantially the same fix?
- [ ] Are the security/scalability/DRY findings it surfaced (if any) ones a
      human reviewer would actually have flagged — no noise, no misses you
      can spot by eye?
- [ ] Is the diff scoped to the issue, or did it wander?
- [ ] Would you merge this into `shogo-ai` as-is, or with only trivial
      changes?

Record the answer (and the PR link) in the eval tracking doc / chat this run
came from. A "yes" to the last question is what "mergeable PR" means here —
this level passes on human judgment, not a green checkmark.

## Cleanup

Close the fork issue/PR, detach the GitHub App connection, and tear down the
pipeline projects once judged — L4 runs are one-off, not a standing fixture
like `fixtures/target-repo`.
