# Issue pipeline fixture: `target-repo`

A minimal, self-contained repo with exactly one planted bug (see
[`ISSUE.md`](./ISSUE.md)). It exists to be the "any incoming work item" that
drives the `e2e/issue-pipeline` eval ladder in
[`docs/issue-pipeline/PLAN.md`](../../../../docs/issue-pipeline/PLAN.md),
Phase 4.

It is a standalone package (not part of the `shogo-ai` bun workspace) so it
can be pushed as-is to a real, disposable GitHub repo and handed to the
pipeline like any other codebase.

## Baseline state (what the pipeline sees at HEAD)

- `bun test` is green — the existing suite in `src/slugify.test.ts` doesn't
  exercise the bug.
- `src/slugify.ts` has the bug described in `ISSUE.md`.

## What a correct fix looks like

A correct fix touches only `src/slugify.ts` (strip trailing separators, e.g.
add `.replace(/-+$/, '')` to the chain) and adds a *new* regression test
(e.g. in a new `src/slugify.regression.test.ts`, or appended to
`slugify.test.ts`) asserting `slugify("Great Deal!") === "great-deal"`. The
eval harness (`e2e/issue-pipeline/helpers.ts`) verifies this mechanically:
it isolates the new/changed test file(s) from the PR branch, runs them
against `main` (expects failure — the bug is still there) and against the PR
branch (expects success).

## Resetting between eval runs

The harness owns a disposable GitHub repo (`$GITHUB_TEST_REPO`) and force-
pushes this directory's contents to its default branch before each L0/L1/L4
run via `resetFixtureRepo()` in `../helpers.ts`, so every run starts from
the same clean, buggy baseline regardless of what a previous run committed.
