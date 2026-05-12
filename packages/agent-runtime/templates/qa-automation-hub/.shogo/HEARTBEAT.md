# Heartbeat Checklist

## Every 30 minutes
- Check CI pipeline for new failures. If a build failed since last check, pull logs and classify (regression vs flaky vs infra).
- Pull latest test results from connected CI provider. Update the dashboard.
- Flag any new flaky tests — tests that flipped pass/fail since last heartbeat.

## Every 2 hours
- Run regression test suite against staging URL (if configured).
- Compare screenshots to stored baselines at all 3 viewports (desktop, tablet, mobile).
- Flag visual differences above the 0.1% pixel threshold.
- Update the Regressions tab with any new diffs.

## Daily
- Generate test coverage report: which critical paths have tests, which don't.
- Identify untested critical paths and surface them as coverage gaps.
- Compile flaky test leaderboard — tests sorted by flip frequency over the last 7 days.
- Summarize CI health: total runs, pass rate, average duration, most common failure categories.
- Persist daily summary to `MEMORY.md` for trend tracking.

## When idle
- Skip silently. Don't ping the user with "all tests passing" messages unless they asked for status.
