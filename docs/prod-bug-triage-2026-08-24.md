# Production bug triage — 48h database review, 2026-08-24

Findings and fix plans for every significant user-facing failure visible in the
**production** platform database (`shogo`, IAD primary `platform-pg-2`) over the
48 hours ending 2026-08-24 09:00 UTC.

Every number in this document was measured against production in that window.
Claims are marked **[measured]** when observed directly in the data or the live
cluster, **[code]** when they follow from reading the current tree, and
**[hypothesis]** when they are inference that still needs a targeted repro.

Four first-pass conclusions did not survive verification. They are corrected
inline rather than quietly removed, because three of them would have sent
someone to fix the wrong thing:

| § | First-pass claim | Corrected finding |
|---|---|---|
| A1 | Publish fails somewhere in the publish pipeline (plan gate, subdomain, build) | Rejected by `validateAuth` **before** `publishProject()` runs — 48h of API logs contain zero `[Publish]` lines |
| B1 | The client queued the user's repeated messages and dropped them | Queued messages are never persisted; five rows *were* persisted, so each send genuinely attempted delivery and failed downstream |
| C1 | The Composio auto-upload fix may not be deployed to production | All four `shogo-runtime` images running in production descend from `ac3be894c`; the flag is live. This is a code gap, not a deploy gap |
| D2 | A formatter/linter on write invalidates the agent's cached read | No format-on-write exists in the runtime. The stale-read error message blames "linter" misleadingly; real causes are external edits and partial reads |

> **Headline.** The two most damaging bugs are both *silent*. Publish returns
> `401` from a code path with no logging at all (§A1), and a chat turn that dies
> before reaching the LLM writes no metrics row (§B2). Both were invisible to
> monitoring and were only found by reading raw table data — which is the
> strongest argument for fixing the observability gaps alongside the bugs.

---

## Contents

| § | Area | Issues |
|---|---|---|
| — | Measured baseline | 48h volumes and failure rates |
| A | Publish authentication | A1 |
| B | Silent dropped chat turns | B1–B2 |
| C | Composio file uploads | C1 |
| D | `edit_file` / `read_file` — 40% of all tool errors | D1–D4 |
| E | Agent goal drift on long sessions | E1 |
| F | Integration connect friction | F1 |
| — | Suggested order of work | |

---

## Reproduction harness

### 1. Production SQL (read-only, via the primary Postgres pod)

There is no local `psql`; the primary pod has one. Credentials come from the
CNPG app secret. **Delete the password file when finished.**

```bash
CTX=context-cp7l2tcj76q            # IAD (home region). FRA is context-cbbetkypxva
NS=shogo-production-system
kubectl --context $CTX -n $NS get secret platform-pg-app \
  -o jsonpath='{.data.password}' | base64 -d > /tmp/pgpass_shogo.txt

cat > /tmp/pgf.sh <<'EOF'
#!/bin/bash
PGPASSWORD=$(cat /tmp/pgpass_shogo.txt)
kubectl --context context-cp7l2tcj76q -n shogo-production-system \
  exec -i platform-pg-2 -- env PGPASSWORD="$PGPASSWORD" \
  psql -U shogo -d shogo -h localhost -v ON_ERROR_STOP=1 < "$1"
EOF
chmod +x /tmp/pgf.sh
/tmp/pgf.sh query.sql

rm -f /tmp/pgpass_shogo.txt        # do not leave this on disk
```

Two notes that cost time on the first pass: Prisma maps to **camelCase column
names**, so every column needs double quotes in SQL (`"createdAt"`, not
`created_at`), which is far easier from a file than from `psql -c`. And the two
regions run **active-active logical replication** (`sub_from_us` / `us_from_eu`,
confirmed by the `replication-monitor` CronJob logs), so either primary answers
the same questions to within replication lag.

### 2. Internal publish auth probe (from inside a project runtime)

```bash
# Which credentials does this runtime actually have?
ls /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null || echo "NO SA TOKEN (metal)"
echo "RUNTIME_AUTH_SECRET set: ${RUNTIME_AUTH_SECRET:+yes}"

# Replay exactly what the publish tool sends
curl -s -o /dev/null -w 'HTTP %{http_code}\n' \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null)" \
  -H "x-runtime-token: $RUNTIME_AUTH_SECRET" \
  "$SHOGO_API_URL/api/internal/projects/$PROJECT_ID/publish"
```

`401` with no SA token file present is §A1.

---

## Measured baseline (48h to 2026-08-24 09:00 UTC) [measured]

Recorded so later fixes can be compared against a known starting point.

| Metric | Value |
|---|---|
| New users / projects | 158 / 286 |
| New chat sessions | 328 |
| User messages | 2,783 |
| Tool calls | 23,865 |
| Tool calls errored | 513 (2.15%) |
| Agent runs (`agent_cost_metrics`) | 1,153 |
| — `success = false` | 102 (8.8%) |
| — `responseEmpty` | 62 (5.4%) |
| — `hitMaxTurns` | 44 (3.8%) |
| — `loopDetected` | 3 (0.3%) |
| — `escalated` | **0** |

Tool errors by tool, top of the distribution:

| Tool | Errors | Share of all tool errors |
|---|---|---|
| `edit_file` | 208 | 40.5% |
| `read_file` | 65 | 12.7% |
| `web` | 65 | 12.7% |
| `publish` | 48 | 9.4% |
| `YOUTUBE_MULTIPART_UPLOAD_VIDEO` | 23 | 4.5% |
| `write_file` | 20 | 3.9% |
| `exec` | 19 | 3.7% |

Essentially all traffic runs on one model: 1,137 of 1,153 runs used
`38e6339d-9135-4aff-8641-eba3ae7bebe5` = **Hoshi 1.0** (`mimo-v2.5`), which
therefore carries almost all of the failure signals above. Comparative
per-model quality claims are not available from this window.

**`escalated = 0` across 1,153 runs is suspicious** [hypothesis]. Either
auto-router escalation never fired in 48h or it is not being recorded. Worth a
few minutes to confirm the signal is wired, since it is one of the documented
multi-signal success columns and a permanently-zero column is worse than none.

---

## A1. Publish returns 401 because internal routes reject runtime tokens in production

**Severity: critical.** Blocks the core "ship it" action.

**Symptom** [measured]. Every failed `publish` tool call in the window returned
the identical payload — `{"error":"Unauthorized","status":401}`, 48 occurrences
across **24 distinct chat sessions**, spread across all hours. Not one user, not
one project.

**Root cause** [code]. `validateAuth()` (`apps/api/src/routes/internal.ts:84-115`)
accepts a runtime token only in local mode, and returns `false` with no logging
otherwise:

```ts
async function validateAuth(c: Context, projectId?: string): Promise<boolean> {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const identity = await validatePodToken(authHeader.slice(7))
    if (identity) return true
  }

  if (process.env.SHOGO_LOCAL_MODE === 'true') {
    const runtimeToken = c.req.header('x-runtime-token')
    // ... verifyRuntimeToken / verifyWorkspaceRuntimeToken ...
  }

  return false
}
```

The publish tool (`packages/agent-runtime/src/gateway-tools.ts`,
`createPublishTool`) calls `/api/internal/projects/:id/publish` via
`internal-api.ts`, whose `getInternalHeaders()` attaches
`Authorization: Bearer <SA token>` **only if the K8s ServiceAccount token file
exists**, and always attaches `x-runtime-token` from `RUNTIME_AUTH_SECRET`.

So any runtime without an SA token file sends only a credential that production
ignores. The 401 is emitted at `internal.ts:811` (GET) and `:854` (POST) before
`publishProject()` is reached.

**Two independent failure modes fall out of this** [code]:

1. Runtimes with no SA token file (metal microVMs — `build-project-env.ts`
   points them at the *public* API URL) can never authenticate. Always 401.
2. Knative pods that do have an SA token get **no fall-through**: if
   `validatePodToken` fails for any reason, a perfectly valid `x-runtime-token`
   on the same request is ignored.

**Evidence that it is mode 1** [measured]. Across 48h of logs from all four
production API pods there are **zero** `[K8sAuth]` lines and **zero**
`[Publish]` lines. Every `validatePodToken` failure path logs something
(`Token not authenticated`, `Not a service account token`,
`Token from wrong namespace`, `TokenReview failed`), so the absence of those
lines means these requests carried **no `Authorization` header at all** and fell
straight through the silent `return false`. The absent `[Publish]` lines
independently confirm the pipeline never ran.

Caveat before treating this as settled [hypothesis]: the API pods sampled were
~26h old and only IAD was checked, so this covers most but not all of the
window. Confirm by correlating the 24 affected projects against their runtime
placement (metal vs Knative) — that both proves mode 1 and sizes the blast
radius.

**Fix.**

1. Accept `verifyRuntimeToken` / `verifyWorkspaceRuntimeToken` in production,
   not only under `SHOGO_LOCAL_MODE`, reusing the project-scoping checks already
   written for local mode so a project token cannot act on another project and a
   workspace token still has to pass the project-membership check.
2. Make the Bearer branch fall through to the runtime token on failure instead of
   dead-ending.
3. **Log every `validateAuth` rejection with the reason.** This bug ran for
   weeks because its failure path is completely silent; the logging is arguably
   the more valuable half of the fix.

**Verification.** `apps/api/src/routes/__tests__/internal.test.ts` currently
*asserts the buggy behaviour* (runtime token accepted only in local mode), so
that expectation must be inverted deliberately rather than discovered as a
break. Add a case for a metal-shaped request (no Bearer header, valid runtime
token) expecting 200. Then publish end-to-end from a metal-backed project, and
re-run the `tool_call_logs` query — `publish` 401s should go to zero.

---

## B1. A user's turn can fail with no assistant reply and no error shown

**Severity: critical.**

**Symptom** [measured]. Session `cc8f5164-1a97-488e-bf02-9fa2e8870238` — a
long-running project (77 agent runs since 2026-08-05, an admin panel with
withdrawal and anomaly-review flows). The user sent the **same message five
times between 16:15 and 16:32 UTC** on 2026-08-23, then twice more at 22:15.
Between those messages: no assistant rows, no `agent_cost_metrics` rows, and —
per the user's behaviour — no visible error. A run at 22:54 finally succeeded
(2,295 s wall time, 11 tool calls).

**This exact symptom is already documented in the tree** [code], in
`apps/mobile/lib/chat-stall-watchdog.ts:14-21`:

> ChatPanel guards its `handleSendMessage` on
> `isStreaming || isProcessingQueueRef || isSendingMessageRef`, so a stuck
> status routes every subsequent user send to the queue […] Symptom in prod: the
> user keeps typing for hours, every user row lands in the DB, no assistant row
> ever lands, and the project's warm-pool pod is eventually evicted for
> inactivity because no chat POST ever fires.

**Correction to the first pass.** That doc comment describes the *queue* path,
but the queue path is **not** what happened here [code]: when `isStreaming` is
true, `ChatPanel` queues the message in React state and does **not** persist it.
Five rows reached Postgres, so `isStreaming` was false on each attempt and each
send ran `sendMessageInternal` in full. The failure is therefore *downstream of
delivery*, not the wedged-status queue.

**Contributing structure** [code]. The user row is persisted fire-and-forget, on
a different endpoint from the run, before delivery is attempted:

- `apps/mobile/components/chat/ChatPanel.tsx:3985-3993` — `actions.addMessage(...)`
  → `POST /api/chat-messages` → `prisma.chatMessage.create`, with only a
  `console.warn` on failure.
- Delivery then goes to `POST /api/projects/:id/chat` (`project-chat.ts`).

There is no transaction or correlation between the two, so a user row with no
run is a representable state with nothing to reconcile it.

Failures after persistence are swallowed on at least two paths [code]: a
network-class failure is absorbed into the offline queue and surfaces only as a
passive "N Queued" strip rather than an error, and the stall watchdog's
`stop()` clears `emptyResponseError` on abort (`ChatPanel.tsx:2236-2238`), so a
turn that never produced a byte can end with the error state wiped.

**Most likely trigger** [hypothesis]: the project runtime was unavailable
(503 / pod unreachable / warm-pool eviction) for that ~17 minute stretch,
recovering hours later — which fits both the 6-hour gap and the eventual
success. Confirm with runtime pod events for that project at that timestamp.

**Reproduce.** Two paths, both worth covering:

1. *Runtime unavailable* — scale the project's runtime to zero (or apply a
   NetworkPolicy blocking `/agent/chat`) and send a message. Assert the
   production signature: user row present, no assistant row, **no
   `agent_cost_metrics` row**, and check what the UI actually shows.
2. *Wedged stream* — delay the first SSE byte beyond
   `DEFAULT_SUBMITTED_STALL_MS` (120 s) to trip the watchdog, and confirm
   whether the abort leaves the user with any indication of failure.

**Fix.** Observability first (see B2), because this currently cannot be
measured. Then the UX: stop clearing error state on watchdog abort and surface
"Request timed out — tap retry"; promote swallowed offline-queue failures to a
real error banner instead of the passive queue strip. Structurally, consider
marking user rows pending until the stream starts, so "sent" and "delivered" are
distinguishable in the data.

---

## B2. A turn that dies before the LLM writes no metrics row

**Severity: high.** This is the reason B1 was invisible.

**Root cause** [code]. `closeSession()`
(`apps/api/src/lib/proxy-billing-session.ts:283-286`) returns before recording
anything when no tokens were consumed:

```ts
  const totalTokens = session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens + session.outputTokens
  if (totalTokens === 0 && session.imageBilledUsd === 0) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }
```

`recordAgentCostMetric` sits below that guard, so any turn that fails before an
LLM call leaves no trace. Worse, sessions that never reach `openSession` at all
(balance 402, pod resolution failure — both before `project-chat.ts:1149-1155`)
are equally invisible. The failure modes that produce **no** metrics row are
exactly the ones a user experiences as "nothing happened".

This means the headline reliability figures in the baseline above —
8.8% failed, 5.4% empty — are **floors, not totals**. Turns that died early are
missing from both the numerator and the denominator.

**Fix.** Record a zero-token turn-attempted/failed row (or a dedicated
`turn_failures` record) so these are countable, including a reason code for the
pre-`openSession` rejections. Add a warning log when a session closes with zero
tokens while a user message exists for that chat session.

**Verification.** After deploy, the 48h queries from this document should show a
non-zero count of early-failure turns; that number is the true size of B1.

---

## C1. Composio file uploads fail because file params are never normalized

**Severity: high** for the affected workflow (video generation → publish), which
is a heavily-used flow in this window.

**Symptom** [measured]. All 23 `YOUTUBE_MULTIPART_UPLOAD_VIDEO` failures are
`Failed to download file with s3key '<X>': storage returned HTTP 404`, and the
`<X>` values are wildly inconsistent — which is the actual clue:

| Observed `<X>` | Kind |
|---|---|
| `/tmp/test_upload.mp4` | absolute path outside the workspace |
| `/app/workspace/scripts/cricket_videos/output/cricket_fact_1.mp4` | absolute path inside the workspace |
| `http://localhost:3001/api/media/the_flood_rescuers.mp4` | localhost URL |
| `https://litter.catbox.moe/bbn7dk.mp4` | external URL |
| `https://<uuid>.preview.shogo.ai/api/youtube/serve/top5movies2026.mp4` | preview URL |
| `e0518aeb-…/top5movies2026.mp4`, then `e0518aeb-…/videos/top5movies2026.mp4` | agent guessing S3-style keys |

**Correction to the first pass.** This is **not** a missing deploy [measured].
Every `shogo-runtime` image running in `shogo-production-workspaces` is a
descendant of `ac3be894c` (the commit that sets
`dangerouslyAllowAutoUploadDownloadFiles: true`), verified with
`git merge-base --is-ancestor` against the four distinct image SHAs in use. The
SDK auto-upload flag is live and uploads still fail.

**Root cause** [code]. In `createProxyTool().execute()`
(`packages/agent-runtime/src/composio.ts:696-716`) only **relative** paths are
rebased onto the workspace; URLs and absolute paths pass through unchanged by
explicit design. Meanwhile `getComposioFileUploadDirs()` permits only
`$WORKSPACE_DIR` and `$HOME/.composio/temp`, so `/tmp/foo.mp4` cannot be staged
by the SDK either. Anything the SDK does not stage is forwarded verbatim, and
Composio's backend interprets the string as an **already-uploaded S3 key** →
404.

The agent is also not told what to pass [code]: `file_uploadable` is dropped by
`jsonSchemaPropertyToTypebox()` so it never reaches the model, tool descriptions
come verbatim from the Composio catalog with no Shogo overlay, and no system
prompt covers file params.

**The retry-with-different-keys behaviour is our own hint text, not model
whimsy** [code]. `classifyComposioError` maps the s3key 404 to
`kind: 'notfound'` and attaches this hint (`composio.ts:559-562`):

> The target resource was not found, or the tool slug is not available. Verify
> the id/handle (do not guess ids), or use `search_integrations`/`connect` to
> find the correct tool. Do not repeat the same call unchanged.

For a genuine missing-resource error that is good advice. For "the file was
never staged" it is actively harmful: it tells the agent the *identifier* is
wrong and that it must vary the call — which is exactly what produced
`e0518aeb-…/top5movies2026.mp4` followed by `e0518aeb-…/videos/top5movies2026.mp4`.
The misclassification, not the model, is driving the guessing loop.

**Reproduce.** `packages/agent-runtime/scripts/test-youtube-upload.ts` already
exists as a harness. Extend it to the four shapes above: external URL, localhost
URL, `/tmp` absolute path, and a nonexistent workspace file.

**Fix.**

1. Normalize `file_uploadable` fields before dispatch: resolve the path, verify
   it exists and lands under an allowed upload dir, and fail with an actionable
   message if not.
2. Stage external/preview URLs by downloading into the workspace first (or
   return an explicit "download it first" instruction), rather than forwarding a
   URL as an S3 key.
3. Map `/tmp` into an allowed staging dir, since agents legitimately land there
   after `exec`.
4. Add a distinct error classification for unstaged-file failures so they no
   longer inherit the `notfound` "verify the id / vary the call" hint. The
   replacement hint should name the real problem and the real remedy ("the file
   was not uploaded; pass a workspace-relative path to an existing file"), which
   removes the incentive to guess key variants.
5. Overlay the tool description for file params: "pass a workspace-relative
   path, not a URL".

**Verification.** The eval mock is currently wrong and cannot catch this
[code]: `packages/agent-runtime/src/evals/tool-mocks.ts:1905-1907` mocks the
param as `videoFilePath` while production takes **`videoFile`**. Fix the mock,
add unit tests for rebasing and URL rejection, then re-check
`tool_call_logs` for `errorKind: notfound` on Composio upload slugs.

---

## D. `edit_file` and `read_file` — 40% of all tool errors

**Severity: high by volume, low per occurrence.** Each failure usually costs a
turn rather than blocking the user, but at 273 combined errors in 48h this is
the single largest drain on agent productivity.

The matching pipeline is better than the error counts suggest [code]: it already
falls back through curly-quote normalization, CRLF normalization, JSON-escape
unescaping, trailing-whitespace stripping, and whitespace-flexible trimmed-line
comparison — and a fuzzy hit **does** apply the edit. So the wins are in
*recovery and hint quality*, not in more matching.

### D1. Ambiguity is decided on exact matches, before fuzzy fallback

`gateway-tools.ts:1787-1791` counts **exact** occurrences and hard-fails when
`> 1 && !replace_all`, before the fuzzy path runs. An `old_string` that is
ambiguous exactly but unambiguous after normalization fails anyway.
**Fix:** reorder so an unambiguous fuzzy match is not blocked by an ambiguous
exact count.

### D2. Stale-read rejection ends the turn instead of recovering

The guard at `gateway-tools.ts:1747-1763` is correct in intent and already has a
content-equality escape hatch for full reads (mtime changed but bytes identical
→ proceed). Two gaps remain:

- **Partial reads always hard-reject**, because `recordRead` stores no content
  for them (`file-state-cache.ts`), so the content-equality fallback cannot
  apply. **Fix:** store range hashes for partial reads.
- **No auto-recovery.** The agent must spend a turn re-reading. **Fix:** on a
  stale rejection, re-read and retry once automatically when the edit still
  applies unambiguously.

**Correction to the first pass.** The error text blames "user, linter, or
another process", but there is **no format-on-write, Prettier, or `eslint --fix`
in the write path** [code] — writes only normalize line endings, strip trailing
whitespace from `new_string`, and notify the LSP for diagnostics. Real causes
are external edits (IDE/user) and the partial-read gap above. The message should
stop implying a linter Shogo does not run.

### D3. The "similar content" hint is too weak to correct from

`gateway-tools.ts:1813-1826` takes only the **first line** of `old_string`,
substring-matches it, and returns at most **2** windows of ±1 line. For the
common `old_string not found` case this rarely gives the model enough to fix
itself in one shot. **Fix:** return the actual nearest matching block with
enough surrounding context to re-issue the edit immediately.

### D4. `read_file` on `/tmp` throws a sandbox error the agent cannot act on

`assertWithinWorkspace` (`permission-engine.ts:821-822`) **throws**
`Path outside workspace: <p>` and `read_file` does not catch it, so the raw
message becomes the tool error. Agents reach `/tmp` legitimately, because `exec`
is not confined to the workspace and its output references absolute paths.
**Fix:** catch it and return guidance (use a workspace-relative path, or a
workspace temp dir), and consider a writable workspace-local temp location.

**Verification for all of D.** Coverage is already strong
(`edit-file-guards.test.ts`, `gateway-tools.edit-file.test.ts`,
`file-state-cache-v5.test.ts`); add cases built from the exact production error
payloads, then use `evals/test-cases-edit-file.ts` to confirm error *volume*
drops rather than merely changing shape.

---

## E1. Agent loses the original goal on long, complex sessions

**Severity: medium.** A quality problem, not a crash — but a visible source of
user frustration.

**Symptom** [measured]. Session `fa5d52ea-953c-4b7a-8cb4-004b09e6c443`, a
multi-hour build of an Indian-market trading/prediction tool. The user sent this
correction **twice, verbatim, 43 minutes apart** (2026-08-23 12:31 and 15:14):

> "this is not the trading platform, it is market prediction tool, have you
> backtested with 5 ai modells? … i think you have missed the point why we are
> building this"

The agent conceded both times ("I lost the plot", "I've been overcomplicating
this") and drifted again. The same session also opened with a hard failure
("Sorry, I was unable to generate a response") and accumulated 6 failure-flagged
runs. Corroborating counts across the window: 44 runs hit the max-turns ceiling
and 2 user messages contain "missed the point".

**Fix — measurement before behaviour change.** Convert this transcript into an
eval case in the existing `evals/` infrastructure that scores whether the
original stated goal is still satisfied after N turns. Only then change
behaviour, most likely by re-anchoring the stated goal into context on long
sessions via the existing `create_plan` tool. Prompt-tweaking before the eval
exists cannot distinguish improvement from regression, which is why this is
sequenced last among the code changes.

---

## F1. Integration failures dead-end instead of prompting a connect

**Severity: low** (3 sessions), but self-contained and cheap.

**Symptom** [measured]. Two distinct dead-ends:

- `GITHUB_GET_A_REPOSITORY` → `No connected account found for user ID
  shogo_<…> for toolkit github` — the user has not connected GitHub, and the
  error is a raw upstream 404.
- `connect` → `"github" is not in the MCP catalog. Available servers:
  playwright, fetch, sqlite, mongodb, discourse, stripe, exa, sentry, airbnb,
  filesystem, computer-use.` The agent tried the obvious thing and was refused.

**Fix.** Intercept the not-connected error and return an actionable connect
prompt/URL, and either add `github` to the MCP catalog or alias it to the
Composio GitHub toolkit so `connect({ "github" })` resolves instead of failing.

---

## Suggested order of work

1. **§A1 publish auth** — small, well-understood, unblocks the core ship action
   for 24+ sessions' worth of users. Add the rejection logging in the same
   change.
2. **§B2 turn-failure metric** — cheap, and it is the instrument that makes B1
   and every later reliability claim measurable. Do it before B1's UX work.
3. **§B1 silent-failure UX** — stop clearing the error on abort; surface
   swallowed delivery failures.
4. **§C1 Composio file normalization** — fixes a complete user workflow; fix the
   eval mock in the same pass.
5. **§D1–D4 `edit_file` recovery** — highest raw volume, but partially
   self-healing today, so it ranks below the total blockers.
6. **§E1 goal-drift eval**, then **§F1 integration prompts** — opportunistic.

Open questions to settle before starting the corresponding fix: confirm the
metal-vs-Knative split for §A1, pull runtime pod events for §B1's window, and
check whether `escalated` is wired at all.
