# Hoshi (mimo-v2.5) Coding Mistake Findings

> Investigation of where the Hoshi agent makes coding mistakes, what reproduces
> them, and the new eval coverage added to close the gaps.
>
> **Window:** production telemetry last 7 days · eval transcripts May 28 – Jun 19, 2026.

## TL;DR

- **Hoshi 1.0's backing model is `mimo-v2.5`** (Xiaomi MiMo), confirmed in
  `model_definitions` (`id 38e6339d-9135-4aff-8641-eba3ae7bebe5`, `apiModel mimo-v2.5`,
  provider `custom`). All free users run Hoshi; only ~11 workspaces are on paid plans.
- Hoshi is functional but **weakest on coding**, and it leans on the linter to catch
  its own mistakes instead of writing correct code up front.
- The two highest-volume production failures are **model-behavior bugs**, not infra:
  malformed `read_file` arguments and editing files before reading them.
- We already had evals that reproduce most of this (`canvas-v2-lint`,
  `coding-discipline`, `codegen-safety`) but **they had never been run against Hoshi**.
  Two gaps had no coverage at all — now added as `tool-discipline` and `typed-build`.

## Data sources

| Source | What it gave us |
| --- | --- |
| `agent_cost_metrics` (prod PG, `model='38e6339d…'`) | Run-level quality flags: success, loop, empty, max-turns, tool counts, wall time. |
| `tool_call_logs` (prod PG) | Per-tool error rates + raw error messages (`read_file`, `edit_file`, `read_lints`, `exec`). |
| `read_lints` results (prod PG) | The actual TypeScript diagnostics Hoshi's code produces. |
| `subscriptions` (prod PG) | Free vs paid attribution (only 11 active paid workspaces). |
| `packages/agent-runtime/eval-outputs/*mimo-v2.5*` | Controlled eval transcripts (codegen-safety, agent-hardening, plan, etc.). |

## Production findings (free users = Hoshi)

### Run-level quality (`agent_cost_metrics`, 7d, 1,068 runs)

| Metric | Hoshi | Notes |
| --- | --- | --- |
| success | 84.7% | |
| loopDetected | 3.7% | Haiku 4.5 & other custom model: 0% |
| responseEmpty | 3.7% | Haiku 4.5 & other custom model: 0% |
| hitMaxTurns | 6.4% | |
| avg tool calls | 4.5 | |
| avg wall time | 214 s | high |

Hoshi is the only high-volume production model with non-zero loop/empty rates.

### Tool-call errors (`tool_call_logs`, 7d)

Overall: **19,118 complete / 1,546 error (7.5%)**. Two tools = ~87% of all errors,
both attributed **100% to free/Hoshi** workspaces (0 from paid):

| Tool | Errors | Err rate | Dominant cause |
| --- | --- | --- | --- |
| `read_file` | 858 | 22.1% | **818 = malformed `offset` arg** ("offset: must be number / must be array / must match a schema in anyOf") |
| `edit_file` | 493 | 14.5% | **359 = "File has not been read yet" + 52 stale-read** (read-before-edit violations); ~14 "old_string not found" (hallucinated content) |
| `skill` | 5 | 18.5% | low volume |
| `create_plan` | 8 | 14.3% | low volume |

### Code-writing quality (`read_lints` results, 7d)

**29% of `read_lints` calls (171 / 592) already return errors** — roughly one in three
times Hoshi checks its own code, it's broken. Grouped TypeScript diagnostics:

| Code mistake | ~Count | Representative |
| --- | --- | --- |
| Wrong property / field / API access | ~470 | `Property 'prospectBooking' does not exist on type 'PrismaClient'` |
| Type mismatch (not assignable) | ~320 | `Argument of type X is not assignable to parameter of type Y` |
| Missing type annotations (implicit any) | ~285 | `Parameter 'x' implicitly has an 'any' type` |
| Unknown / missing object & component props | ~137 | `Object literal may only specify known properties`; missing `small`, `icon`, `opts` |
| Bad imports / undefined names | ~116 | `Cannot find module 'X'`, `Cannot find name 'X'` |
| Syntax & JSX errors | ~37 | `'X' expected`, unescaped `>` in JSX |
| Null / undefined safety | ~34 | `'X' is possibly 'null'` |

### The write → lint-fail → fix loop (the behavior you observed)

- **29%** of self-checks already broken.
- **93 sessions/week** hit lint failures; sessions that keep editing average **33 edits**
  of churn afterward.
- Only **~31%** of failing sessions ever reach a clean lint.
- Build verification is rarely run (only ~35 build/tsc failures across 8,256 `exec` calls).

**Conclusion:** the self-correction works *only when triggered*. When Hoshi skips the
lint/build check, broken code ships to the user unfixed.

## Eval-corpus findings (controlled coding tracks, mimo-v2.5)

| Track | Pass | Notes |
| --- | --- | --- |
| codegen-safety | 0/4 | Prisma 7 adapter thrash; declared "Everything works perfectly" while runtime was broken |
| agent-hardening | 11/28 | |
| non-agentic | 251/663 | top anti-pattern: "No tool calls at all" (×29) |
| tool-system | 3/6 | |
| plan | 12/20 | |
| agentic | 70/105 | |

By category, coding is weakest: `code-agent` 63% fail, `canvas-v2` 54%, `edit-file` 36%.

## Eval coverage analysis

| Production issue | Existing coverage | Gap |
| --- | --- | --- |
| Ships lint-dirty code | `canvas-v2-lint` `no-lint-errors-in-final` | — |
| Write → lint-fail → fix loop | `canvas-v2-lint` `self-corrected-if-needed` | — |
| Read-before-edit | `coding-discipline`, `canvas-v2-lint` `read-first` | — |
| Hallucinated component/import names | `canvas-v2-lint-fix-broken-code` | partial |
| Hallucinated Prisma fields / `Property does not exist` | weak (only via lint score) | **NEW: `typed-build`** |
| Malformed `read_file` `offset` args (the #1 prod tool error) | none | **NEW: `tool-discipline`** |
| `edit_file` errors (read-before-edit, old_string mismatch) as scored outcomes | behavioral only | **NEW: `tool-discipline`** |

> Important: the targeted tracks `canvas-v2-lint`, `coding-discipline`, and `bug-fix`
> have **never been run against Hoshi**, and `edit-file` was run once on Haiku only.
> Run them to get a baseline before/after any model or prompt change.

## New eval cases added

### `tool-discipline` — `test-cases-tool-discipline.ts`

Reproduces the top two production tool failures as *scored* criteria:

- **`read_file` argument-schema adherence** — tasks that require reading a specific
  line range of a large file (encouraging `offset`/`limit`); criteria fail if any
  `read_file` call passes a malformed `offset`/`limit` (string/object instead of
  number-or-array) or if the call errors.
- **Read-before-edit / no edit errors** — multi-file edit tasks; criteria fail if an
  `edit_file` targets a file that was never read first, or if any `edit_file` errors
  (`File has not been read yet`, `old_string not found`).

### `typed-build` — `test-cases-typed-build.ts`

Reproduces the #1 code error (`Property does not exist`) via field-name fidelity:

- Seeds a Prisma schema (and/or typed API) with **deliberately non-default field names**
  (`headline`, `bodyText`, `authorEmail`, `publishedAt`).
- Tasks ask for a feature whose "obvious" names (`title`, `body`, `author`, `createdAt`)
  would be wrong.
- Criteria reward referencing the **real** field names and penalize property access on
  the **hallucinated** names, plus reward `read_lints` usage + lint-clean final code.

## Hardening implemented (Jun 19, 2026)

Production-wide, tooling-first fixes in
[packages/agent-runtime/src/gateway-tools.ts](../gateway-tools.ts) — no eval
criteria were weakened.

| ID | Change | Why |
| --- | --- | --- |
| **A1** | `read_file` `offset`/`limit` schema widened to also accept a **string** (`"380"`) and an **object** (`{ start, end }` / `{ offset, limit }`); `execute` coerces all shapes to numbers and silently drops un-coercible values instead of erroring. | Removes the #1 production tool error (818/wk "offset: must be number / must be array"). The TypeBox `parameters` is the single schema source, so widening it stops the validator rejecting the call *before* `execute`. |
| **A2** | `write_file` / `edit_file` / create-on-edit now attach a compact `lint` summary (`{ ok }` or `{ ok:false, errorCount, errors[≤5], hint }`) via `lspManager.getDiagnosticsAsync`. Best-effort: only when the LSP is already running, hard-capped at ~1.2 s, omitted silently if not ready. **Feedback, not a gate.** | Weak models ship dirty code unless they remember to call `read_lints`. Surfacing errors *on the edit itself* closes the leaky self-correction loop without a mandatory build/lint exit gate. |
| **B1** | Removed stale "use grep" guidance from the `read_file` description + large-file note (no grep tool exists); added explicit offset examples (`offset: 380, limit: 40`, `offset: [380, 420]`); extended the `exec` description to prefer `read_file` over `cat/head/tail` **and** `search` over `grep/rg`. | Stale tool references confused the model; concrete examples lower offset malformation further. |

Verified A2 fires in the eval VM: edit results carry inline diagnostics
(e.g. `"errorCount": 22` + fix hint) — the LSP is live and feedback reaches the model.

### Before → after on mimo-v2.5 (VM mode, 6 workers, agent_only)

| Track | Before | After | Notes |
| --- | --- | --- | --- |
| `tool-discipline` | 3/5 · `tool-usage` **0/2** | **5/5** · `tool-usage` **2/2** | A1 win — the read_file arg-schema class is gone. |
| `coding-discipline` | 7/9 | **8/8** | B1 win — `use-read_file-not-exec(cat)` and `locate-before-edit` both pass. (Eval count dropped 9→8: the stale `use-grep-not-exec` case was removed and `grep-to-locate` was retargeted to `search`.) |
| `canvas-v2-lint` | 3/8 | 3/8 | A2 confirmed active; heavy multi-chart / SDK builds (E2/E5/E6) remain red — model-capability limit, accepted. |
| `typed-build` | 1/3 | 1/3 | E2 passes; E1 (Prisma field hallucination + runtime CRUD failure) and E3 (schema thrash, 2.7M tokens, 28 canvas compile errors) stay red — model-capability limit, accepted. |

**Realistic ceiling reached:** the deterministic tool fixes (A1) and prompt fixes
(B1) cleared the failures that were *tooling/guidance* problems. The remaining red
evals are genuine from-scratch reasoning/build tasks where mimo's capability — not
our tooling — is the bottleneck, so we report them as model limits rather than
weaken the tests. A2 helps in production (where every Hoshi user gets edit-time
diagnostics) even though it doesn't flip the heaviest agent_only canvas builds.

## How to run

```bash
cd packages/agent-runtime

# Baseline the existing targeted tracks on Hoshi (never run before):
bun run src/evals/run-eval.ts --track canvas-v2-lint    --model openrouter:xiaomi/mimo-v2.5 --local
bun run src/evals/run-eval.ts --track coding-discipline  --model openrouter:xiaomi/mimo-v2.5 --local

# The new tracks:
bun run src/evals/run-eval.ts --track tool-discipline    --model openrouter:xiaomi/mimo-v2.5 --local
bun run src/evals/run-eval.ts --track typed-build        --model openrouter:xiaomi/mimo-v2.5 --local
```

Use the OpenRouter backing id — `hoshi-1.0` is a public alias and isn't in `MODEL_ALIASES`,
and the admin eval trigger validates `--model` against the static catalog.

## Caveat on the lint criteria

`lastReadLintsClean()` returns `false` when the model **never calls `read_lints`**, so for
a model like Hoshi (which often skips it) the eval conflates "didn't check" with "shipped
broken code." That is acceptable as a quality proxy, but keep it in mind when reading
scores — pair it with the `used-read-lints` criterion to disambiguate.
