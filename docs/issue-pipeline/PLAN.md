# Issue Pipeline: a self-assembling, self-evolving agent system on Shogo

Status: Phase 1 in progress. Owner: Russ. Reviewers: Adhi, Gaurav, Eby.

## Goal

Any incoming work item (bug, feature request, enhancement, or a recurring
task such as "review yesterday's telemetry") flows through a pipeline of
specialised agents, each of which is an ordinary Shogo project with its own
interface, history, and prompt. Humans pick one of five proposed approaches;
agents plan, implement, review, and open a PR; a retrospective agent watches
recurring reviewer feedback and amends the upstream prompt that keeps causing
it. The final eval is not a benchmark: it is "send Shogo this document and
Shogo builds and e2e-tests the system itself".

Design notes that led here live in the chat canvas
`autonomous-issue-pipeline-on-shogo.canvas.tsx`; this file is the durable
version of the decisions.

## Pipeline (from the whiteboard)

```
intake ─▶ reproduce ─▶ analyse (5 options) ─▶ [human picks] ─▶ plan
   ▲          fast          capable                            capable
   │
   │      ┌──────────────── implement (fast workers) ◀──────────────┐
   │      │                        │                                │
   │      │        security · scalability · DRY (fast, readonly)    │
   │      │                        │                                │
   │      └─────────────▶ done gate (capable) ── not done ──────────┘
   │                               │ done
   └─── react to PR comments ◀── open PR (gh)
```

Every run has one `runId` that is threaded through every project hop and
stamped on every `AgentCostMetric.metadata`, so an issue can be traced from
tracker comment to merged PR.

## Decisions

1. **Module = Project.** Each stage is a Shogo project. It already has
   everything a module needs: `AGENTS.md`, `.shogo/agents/*.md`,
   `.shogo/skills/`, `ProjectAgent` rows, its own Prisma DB, its own canvas UI
   for a dashboard, checkpoints for history.
2. **Composition = manifest.** A `shogo-system.yaml` at the anchor project
   declares the projects, their agents, attachments, channels, integrations
   and heartbeats. `.shogo-project` stays the per-module archive; the manifest
   is the `go.mod`. `system_apply` is idempotent and reports a diff.
3. **Invocation = `project_call`.** A typed gateway tool that invokes a named
   `ProjectAgent` on an attached project via the existing
   `agent-proxy/agent/hooks/agent` path, carrying `runId`. No new transport.
4. **Prompt evolution happens in the wild, not in evals.** Reviewers emit
   structured findings (`category`, `planGap`, `accepted`). A retrospective
   agent counts recurrences and amends the owning agent's `## Learned`
   section. `planGap=true` blames the planner, `planGap=false` blames the
   implementer, recurring `accepted=false` blames the reviewer. Prompts are
   files, so checkpoints are the version history; no `PromptVersion` table.
5. **Human gate = a decision record, not a chat reply.** Options are posted
   to the task source (Jira comment, GitHub issue comment, or the built-in
   tracker) and the pick comes back through the same webhook.
6. **Task source is an adapter.** `TaskSource` = `{ list, get, comment,
   transition }` with Jira (Composio), GitHub Issues (`gh`), and built-in
   (Prisma table in the intake project) implementations. Nothing downstream
   knows which one is behind it.
7. **Start as a team, split into projects.** Phase 3 first ships the whole
   pipeline as one project (coordinator + `.shogo/agents/*`) because that
   needs zero platform work and validates the prompts. Then it splits along
   the manifest.

## Phases

### Phase 1: platform tools (this is the only phase that touches the platform)

Runtime side (`packages/agent-runtime`), API side (`apps/api`). All new
routes live under `/api/internal/...` and use the existing
`authenticate` / `authorizeWorkspaceScope` model: a runtime token is a
project or workspace capability, so every route cross-checks that the target
projects belong to the caller's workspace.

| Deliverable | Where | Notes |
| --- | --- | --- |
| `POST /api/internal/workspaces/:id/projects` | `apps/api/src/routes/internal.ts` | Create a project in the caller's workspace. Body: `name, description?, techStackId?, workingMode?, templateId?`. Reuses the same service the public route uses so tier limits apply. |
| `GET/POST/DELETE /api/internal/projects/:id/attachments` | same | Durable `ProjectAttachment` (anchor → attached), wrapping `project-attachment.service.ts`. Distinct from the session-scoped members routes that already exist. |
| `PATCH /api/internal/projects/:id/config` | same | `AgentConfig` (heartbeat, model), `Project.settings` subset, `slackEnabled`. Explicitly not: publish, trust level, billing. |
| `internal-api.ts` wrappers | `packages/agent-runtime/src/internal-api.ts` | `createProject`, `listAttachments`, `attachProject`, `detachProject`, `configureProject`, `callProjectAgent`. Same `CheckpointCallResult` envelope. |
| `project_create`, `project_attach`, `project_detach`, `project_list`, `project_configure` | `packages/agent-runtime/src/project-tools.ts` (new file; `gateway-tools.ts` is 7.7k lines) | Registered in `createTools`. Gated by the permission engine as mutating tools. |
| `project_call` | same | `{ project, agent?, message, runId?, wait? }`. Resolves the target's `agent-proxy` URL via the API, POSTs to `/agent/hooks/agent`, returns the reply (sync) or an acceptance (async). Stamps `runId` into `AgentCostMetric.metadata` for the callee's turn. |
| `shogo-system.yaml` schema | `packages/core/src/system-manifest.ts` | zod schema + `diffManifest(current, desired)`. |
| `system_apply` | `project-tools.ts` | Reads the manifest, computes the diff against live state, applies creates/attaches/configs in dependency order, writes agent files into each project, returns the diff. Dry-run flag. |
| Tests | `packages/agent-runtime/src/__tests__/project-tools.test.ts`, `apps/api/src/routes/__tests__/internal.project-lifecycle.test.ts`, `packages/core/src/__tests__/system-manifest.test.ts` | Route auth matrix (SA, project token same workspace, project token other workspace, workspace token), tool happy paths, manifest diff idempotency. |

### Phase 2: the missing stage (GitHub comment → agent)

| Deliverable | Where |
| --- | --- |
| Handle `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` in the GitHub App webhook, resolve the connected project, and POST to its `agent-proxy/agent/hooks/agent` with the event rendered as a message and `runId` recovered from the PR body. | `apps/api/src/routes/github.ts`, `apps/api/src/services/github.service.ts` |
| Route filter so only comments mentioning the bot or on bot-authored PRs wake the agent. | same |

### Phase 3: build the system (prompts and a template, no platform code)

| Deliverable | Where |
| --- | --- |
| `templates/issue-pipeline/shogo-system.yaml` plus one folder per module (`intake`, `analyst`, `planner`, `implementer`, `security`, `scalability`, `dry`, `done-gate`, `retrospective`, `harness`), each with `AGENTS.md`, `.shogo/agents/*.md`, `HEARTBEAT.md` where relevant. | `packages/agent-runtime/templates/issue-pipeline/` |
| Findings contract: `findings.schema.json` and the Prisma model in the retrospective project's own DB. | same |
| Retrospective hygiene rules encoded in its prompt: cap on `## Learned`, retire to skill after N quiet runs, never edit outside the section, commit message cites runIds. | same |
| TaskSource adapters as skills: `jira` (Composio), `github-issues` (`gh`), `builtin` (Prisma). | `templates/issue-pipeline/intake/.shogo/skills/` |
| Single-project variant (`templates/issue-pipeline-solo/`) for L0. | same |

### Phase 4: the eval (Shogo builds the system)

| Level | Given | Must produce | Assertions |
| --- | --- | --- | --- |
| L0 | Whiteboard prose + fixture repo with one planted bug | Single-project pipeline that opens a PR fixing the bug | PR exists; new test fails on base, passes on branch; tracker comment has exactly five options |
| L1 | `shogo-system.yaml` | One project per stage, attached and wired | Same as L0, plus `ProjectAttachment` rows match the manifest, `system_apply` second run reports an empty diff |
| L2 | Whiteboard prose only | Writes the manifest, then passes L1 | Manifest validates against the schema |
| L3 | Three seeded runs with the same accepted security finding | Planner prompt amended | Only `## Learned` changed; checkpoint message cites three runIds |
| L4 | `shogo-ai` fork + a real open issue | Mergeable PR | Human review |

Harness: `e2e/issue-pipeline/` (Playwright + `exec`), a fixture repo under
`e2e/issue-pipeline/fixtures/target-repo`, Composio Jira mocked through
`/agent/tool-mocks`, real GitHub test repo, permission engine in
`full_autonomy` with an assertion that nothing outside the fixture repo and
the pipeline projects was written.

## Non-goals

- No new job queue. Heartbeat and webhooks are the triggers.
- No `PromptVersion` table. Checkpoints are the history.
- No DSPy or `AgentEvalSet` in the learning loop. Findings are the signal.
- Nested subagents stay capped at depth 1; the coordinator owns all spawns.

## Risks

- A full L1 run is dozens of capable-model turns. Keep the fixture tiny.
- Prompt bloat from the retrospective. Hygiene rules are mandatory, not
  optional.
- L4 against `shogo-ai` runs on a fork only until L1 to L3 are boringly green.
