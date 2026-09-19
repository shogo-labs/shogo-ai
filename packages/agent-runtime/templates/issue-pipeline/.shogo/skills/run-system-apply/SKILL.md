---
name: run-system-apply
version: 1.0.0
description: Dry-run, confirm, and apply shogo-system.yaml to (re)build the issue-pipeline's nine module projects
trigger: "set up the pipeline|rebuild|system_apply|apply the manifest|manifest drift|shogo-system.yaml changed"
tools: [system_apply, project_list, ask_user, send_message]
---

# Run System Apply

1. **Dry run.** `system_apply({ dryRun: true })`. Read the `plan` array in the result.
2. **Summarize.** Turn the plan into a short human-readable list grouped by op: creates, attaches, configures, file writes, and anything in `manual` (things that need credentials — GitHub App connection, Jira/Composio auth — and cannot be applied by this tool).
3. **Confirm.** If this is the first run (the plan contains `create` ops) or the diff touches more than file writes, `ask_user` to confirm before applying. A pure "0 changes" dry run needs no confirmation.
4. **Apply.** `system_apply({ dryRun: false })`. Report `applied`, `skipped`, and `errors` back to the human.
5. **Manual follow-ups.** For every line in `manual`, tell the human exactly what to connect and where (e.g. "Connect GitHub to the *Issue Pipeline — Intake* project so it can receive issue/PR webhooks and open PRs").
6. **Re-verify.** Optionally run one more `dryRun: true` — a healthy apply reports `empty: true`.

If `system_apply` reports `skipped` entries about a project "not reachable on disk yet", tell the human to wait for the next runtime restart (the merged root needs to remount the newly-attached project) and re-run this skill.
