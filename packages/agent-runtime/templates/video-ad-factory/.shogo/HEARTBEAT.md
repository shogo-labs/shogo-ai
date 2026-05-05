# Heartbeat Checklist

Heartbeat is off by default for this template. Turn it on in `config.json`
(or via the agent settings UI) once the user has active generation jobs or
running campaigns that need monitoring.

## When projects are active
- Poll pending video generations — check status via Arcads API and surface
  completed assets immediately in the dashboard.
- Track credit usage — flag if credits are running low (below 20% of monthly budget).
- Surface completed assets with QA status (clean / needs-review / failed).

## Daily (when enabled)
- Summarize yesterday's generated assets: count, total credits spent, models used.
- Report which ad variants performed best if analytics are connected (CTR, hook rate, ROAS).
- Flag any failed generations that need retry or user intervention.
- Check if any scheduled generations are queued and remind user of upcoming credit spend.

## When idle
- Skip silently. Don't ping the user with generic creative suggestions.
