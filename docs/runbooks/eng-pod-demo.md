# Engineering team in a channel: demo runbook

A bug is posted in `#eng` with no mention. One agent triages it, another fixes
it and opens a PR with a preview, an isolated third agent reviews it, and the
person approves the merge. About three minutes on screen, native chat first and
a Slack segment second.

Nothing here is faked. The video uses the fastest real run of three rehearsals.

## What you need

| Thing | Notes |
| --- | --- |
| A disposable GitHub repo | Connected through the Shogo GitHub App. It is force-pushed to, so never use a real repo. |
| GitHub App permissions | **Contents: write** and **Pull requests: write** (the builder opens and merges PRs through the app). With contents only, the builder pushes its branch, `github_create_pr` fails with "Resource not accessible by integration" and the run stops short of a PR. Accept the permission change on the installation after editing the app. |
| The `checkout-app` fixture | `e2e/issue-pipeline/fixtures/checkout-app`. Coupon `SAVE10` takes money off shipping: `$48.60` instead of `$49.10`. |
| A workspace with team chat on | Native mode, or bridged to Slack for the second segment. |
| An API key | `shogo_sk_...` for the seed and the measuring test. |
| The coordinator's runtime URL | Optional. The seed asks the coordinator to apply the team through the API's agent proxy; set `AGENT_URL` only to use a different runtime. |
| Slack (second segment) | The app installed in the workspace, `#eng` adopted to a Slack channel such as `#eng-bridge`. |
| Pinned model | `claude-sonnet-4-6` is set by the manifest. Channel runs honor a model chosen for a project and only fall back to Auto routing when none was chosen (Auto picked Haiku, which skipped the PR step). Do not change it between rehearsals and the recording. |

## Seed

```bash
SHOGO_API_URL=http://localhost:8002 SHOGO_API_KEY=shogo_sk_... WORKSPACE_ID=<id> \
GITHUB_TEST_REPO=<owner>/<repo> GITHUB_INSTALLATION_ID=<n> AGENT_URL=http://localhost:6200 \
  bun run demo:seed-eng-pod -- --reset-repo --run-briefing
```

It is safe to run again. It creates the coordinator from the `eng-pod`
template, has it apply `shogo-system.yaml` (builder, reviewer and `#eng`),
connects the three projects to the repo, force-pushes the buggy baseline,
creates the weekday 9am briefing routine and, with `--run-briefing`, queues it
so a briefing is already sitting in `#eng`. Add `--slack` to bridge the
workspace to Slack. The script prints anything a person still has to do. It also creates the
`@maintainers` group (pass `MAINTAINER_USER_IDS=id1,id2` to fill it), installs the
coordinator's prompt and skill through `system_apply`, and applies again if a
new project was not reachable on disk the first time. Each run asks the
coordinator to apply the manifest, so expect about a minute.

### On a laptop

- Either start the API with `AI_MODE=api-keys` and provider keys in the
  environment (and do **not** export `SHOGO_API_KEY`: a key there sends AI calls
  to Shogo Cloud, which rejects a local key), or run on the Shogo proxy: set
  `SHOGO_API_KEY` (a real key for that environment), `SHOGO_CLOUD_URL`,
  `AI_PROXY_URL` (`<cloud>/api/ai/v1`) and `AI_PROXY_TOKEN` (the same key). Hoshi
  and other custom models need `AI_PROXY_URL` and `AI_PROXY_TOKEN` in the API
  process, including for the relevance check; a staging key only works against
  the staging host.
- To rehearse with another model, set it on the three `agent_configs` after the
  seed. Each seed applies the manifest again and puts the pinned model back.
- Set `SHOGO_AUTO_REPLY_INTERVAL_MS=20000` for rehearsals. A channel agent may
  answer unasked once per 10 minutes by default, so a second bug posted inside
  that window gets no answer.
- Without `PUBLIC_PREVIEW_URL` there is no preview link; run the test with
  `SKIP_PREVIEW=1`.
- The local API mounts the GitHub routes, so `github/connect` and the builder's
  PR and merge tools work against a dev GitHub App.

Check before each take:

- `#eng` exists, has the three agents and `@maintainers`, and shows a briefing.
- The repo's `main` has the coupon bug (`/?coupon=SAVE10` shows `$48.60`).
- No leftover PR from an earlier take is open on the repo.
- The phone has the app and notifications on, and the island is running.

## Script (about 3 minutes)

| Time | What happens | What to point out |
| --- | --- | --- |
| 0:00 | The 9am briefing is already in `#eng` (shipped, waiting on you, blocked). | Routines report into the channel. |
| 0:15 | Post "checkout total is wrong when a coupon is applied" with a screenshot. No mention. | Nobody was tagged. |
| 0:25 | The coordinator replies in a thread: GitHub issue link and a task card with criteria and the steps Triage, Fix, Review, Merge. | Only one agent answered. |
| 0:45 | The builder is tagged. The card advances. Expand the collapsed updates once. | The channel stays quiet; the detail is one click away. Speed this part up in the video. |
| 1:30 | The PR and the live preview link are posted. Open the preview and show `$49.10`. | A result you can click. |
| 1:50 | The reviewer posts PASS. | Its prompt had only the hand-off and the criteria. It cannot read the channel. |
| 2:05 | A decision card asks to merge. The phone gets one push. Approve it. | One person, one decision. |
| 2:20 | Slack: repeat the post and the approval in `#eng-bridge`, cut faster. | Each agent has its own name and avatar. The card updates in place. The merge is a Block Kit button. |
| 2:45 | The card shows done with a summary. Overlay the metrics table. | Side by side with a stream of bot posts: one card instead. |

Caveat to check in rehearsal: the island and phone show the merge request
through the app's existing decision notifications. Approving from the island is
not a separate path, so if it does not offer the buttons, approve in the thread
and say so.

## Measure each rehearsal

```bash
GITHUB_TEST_REPO=<owner>/<repo> SHOGO_API_URL=http://localhost:8002 \
SHOGO_API_KEY=shogo_sk_... WORKSPACE_ID=<id> \
  bun run test:issue-pipeline:eng-pod
```

The test posts the bug, approves the merge itself, waits for the PR to merge
and checks that the PR's new test fails on the old code and passes on the fix.
It prints a report and writes `e2e/issue-pipeline/results/eng-pod-<time>.json`.
Reseed with `--reset-repo` between runs: it force-pushes the baseline and
closes every open issue and PR on the repo, so it must stay a disposable repo.
The test does not reset the repo itself, because a new root commit after the
pod has synced leaves its checkouts with no history in common with `main`.
Also clear `#eng` first, or use a fresh channel: if the same bug report is
already in the channel's recent history the agents treat it as handled and stay
quiet.

Targets: PR in under 15 minutes, 5 or fewer messages to read, exactly 1 human
intervention, 0 wasted agent turns. The definitions are in
`e2e/issue-pipeline/README.md`.

## Rehearsal log

Fill in after each of three runs, then keep the fastest real run.

| Run | Date | Bug → PR | Bug → preview | Messages to read | Interventions | Wasted turns | Keep? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |

## If a take goes wrong

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Two agents answer the bug | The relevance filter let a second one through | Count it as a wasted turn, mute the extra agent in `#eng` (`@<agent> mute`) and note it; do not record this take. |
| A "Paused" notice appears | Agents tagged each other past the chain limit | Look at the thread for who tagged whom; fix the prompts, not the limit. |
| No approval card, builder tries `gh pr merge` | Stale `.shogo/permissions.json` in the builder project | Re-run the seed; the engine reloads rules each turn. Merge must be `ask` for the builder and `block` for the others. |
| Approval card says expired | The run ended or the runtime timed out before the click | Run again; an ask-first rule waits 15 minutes, other prompts keep the 30 second default. |
| `github_create_pr` fails with "Validation Failed" | The builder pushed a branch with no history in common with `main`, usually because the repo was reset after the pod synced | Reseed with `--reset-repo`, then post the bug. |
| No preview link | `PUBLIC_PREVIEW_URL` not set for the builder | Set it in the builder's environment, or run the test with `SKIP_PREVIEW=1` and do not claim a preview. |
| Briefing missing | The dispatcher has not ticked yet | Wait about a minute, or run the seed with `--run-briefing` again. |

## Before recording

- Three rehearsals done and logged above.
- Keep a backup recording of the best run.
- Publish the metrics table from the JSON of the run you keep.
