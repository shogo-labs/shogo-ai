# Heartbeat Checklist

## PR Triage (every 15 min)
- Fetch open PRs across tracked repos
- Update PR Queue surface with age, status, CI checks
- Flag PRs without review after 48 hours
- Auto-review new small PRs (< 200 lines)

## CI/CD Monitoring
- Check latest pipeline runs for failures
- Update CI/CD Status surface
- Alert on broken builds or failing tests

## Standup Generation (morning)
- Compile per-developer Done / In Progress / Blockers from git activity
- Post to configured Slack channel
- Update Team Activity surface

## Weekly Engineering Report (Mondays)
- Compute PR cycle times, merge rates, review distribution
- Update velocity charts on Team Activity surface
- Highlight trends and areas for improvement
