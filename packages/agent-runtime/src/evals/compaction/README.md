# Compaction eval (`--track compaction`)

Scores the context summarizer — and the variants under test — on three things at
once: **how much wire context it frees**, **what the agent can still do
afterwards**, and **what it cost**. (SHO-327.)

```bash
# CI: the six committed fixtures, ~$0.05
cd packages/agent-runtime && bun run evals:compaction --fixtures synthetic

# Real sessions from this machine (export first, see below)
bun run evals:compaction --fixtures real --variants A,B1,D

# Record the baseline a candidate must beat, and gate against it
bun run evals:compaction --fixtures all --write-baseline
bun run evals:compaction --fixtures all --gate
```

`run-eval --track compaction` delegates here, so either command name works.

## Slicing a long run

A real-fixture sweep is network-bound and can outlive a shell timeout. Cells are
written to disk as they land, and three flags make that resumable:

```bash
bun run evals:compaction --fixtures real --limit-real 8 --variants B1 --append --resume
bun run evals:compaction --fixtures all --append --resume --report-only
```

`--append` merges the slice into the existing results (keyed by
`variant|fixture`, so spend accumulates instead of resetting), `--resume` skips
cells already paid for, and `--report-only` re-renders the report and baseline
without spending anything.

Uneven coverage never becomes a fake comparison: the table and the gate are
computed only over the fixtures **every** variant graded (`comparableFixtures`
in `report.ts`), and the report states how many partially-covered cells that
excluded.

## What is measured

Every number is taken **after every wire layer** (`buildHistory` →
`applyToolResultBudget` → `microcompact` → `snipConsumedResults`), never from the
stored session: stored chars are not what the provider is billed for.

| metric | meaning |
|---|---|
| `freedPct` | wire tokens freed vs the same fixture before compaction |
| `tokensAfter` | wire tokens actually sent after the compaction |
| `summaryChars` / `summarizerChars` | summary size, and the transcript the summarizer was shown |
| `factRecall` | share of probe questions answerable from the compacted context (planted facts string-matched, decisions/next step judged) |
| `nextActionMatch` | 1 same tool + target, 0.5 same tool, 0 otherwise — the real next call, from the transcript |
| `reReadRate` | share of continuation calls that repeat a call whose result was dropped: what dropping costs |
| `inventedTools` | calls to a tool never offered (the SHO-122 guard) |
| `summarize` usage | in/out tokens, cost and latency, straight from the gateway |

## Variants

| id | change |
|---|---|
| `A` | production today — nothing dropped, full result bodies in the summarizer input |
| `B0/B1/B2` | drop consumed tool results in the kept tail at summarize time, protecting the last 0/1/2 tool rounds |
| `C` | summarizer input carries only `← name result (N chars)` (errors keep 300 chars) |
| `D` | `B1 + C` |

Select with `COMPACTION_VARIANT=A|B0|B1|B2|C|D`. **`A` is the default** and is
byte-identical to the code before this feature (tested in
`src/__tests__/compaction-variants.test.ts`). Sweeps: `COMPACTION_TAIL_BUDGET_RATIO`
(default 0.40), `COMPACTION_SUMMARY_INPUT_CHARS`, `AGENT_SUMMARIZER_MODEL`.

## Real fixtures

```bash
bun scripts/export-compaction-fixtures.ts --min-tokens 25000 --limit 30
```

Reads every `.workspace-roots/*/.shogo/sessions.db` **read-only**, splits each
qualifying session into (history, continuation), derives probes from the
transcript itself (no model call, no cost) and redacts secrets with the same
pattern list `mine-prod-failures.ts` uses.

Output lands in `packages/agent-runtime/src/evals/fixtures/compaction/`, which is
**gitignored**: it is real workspace content and must never be committed.

## Gate

A variant may become the default only if, against the recorded baseline:

- it frees **≥ 15 points** more wire context
- `factRecall` and `nextActionMatch` stay within **−3 points**
- `reReadRate` rises by at most **10 points**
- `context-retention` and `cache-compaction-recovery` still pass

Those last two are declared per run, and the check **fails closed**: a track is
satisfied only by a recorded pass, so leaving one off the command line fails the
gate rather than passing it by omission. That is deliberate — an unrun track is
missing evidence, and this check exists precisely to stop a default flip on
missing evidence.

```bash
bun run evals:compaction --fixtures synthetic \
  --tracks context-retention=true,cache-compaction-recovery=true --gate
```

The report header prints every track as `pass`, `**FAIL**` or `**NOT RUN**`, and
the recorded baseline stores the same map, so a later run can see which tracks
the baseline was measured with. An unknown track name or a value that is not
`true`/`false` is an error, not a silently ignored flag.

Thresholds and the comparison live in `gate.ts` and are unit-tested, including a
hand-edited baseline (which must fail) and a run with no tracks recorded (which
must not pass).

## Artifacts

`evals/compaction-report.md` and `evals/compaction-results.json` are written per
run (both gitignored). The report has one row per variant, the spend, and the
three worst fixtures.
