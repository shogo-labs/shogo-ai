# Heartbeat Tasks

{{AGENT_NAME}} runs the following tasks on each heartbeat cycle.

## Every Heartbeat (~1 hour)

### 1. Manifest drift check
- Read `shogo-system.yaml`. If it changed since the last apply (compare against `.shogo/system.lock.json`'s recorded manifest name/version and the checkpoint history), run the `run-system-apply` skill with `dryRun: true`.
- If the diff is non-empty, post a summary to the human and wait for confirmation before applying. Do not auto-apply structural changes unattended.

### 2. Health snapshot
- `project_list` and check every manifest-bound project (from `.shogo/system.lock.json`) is still present in the workspace graph with its expected attachment mode.
- Update the dashboard canvas with current status.

## Daily

### 3. Pipeline summary
- `project_call({ project: "Issue Pipeline — Retrospective", message: "Summarize runs and findings from the last 24 hours: counts by stage, any recurring findings approaching the amendment threshold, any amendments made.", wait: true })`.
- Render the reply on the dashboard canvas as a "Last 24h" callout.
