# Heartbeat Checklist

## Vault Maintenance (every heartbeat — 6 hours)
- Scan for orphan notes (no inbound links from other notes) and flag them for review
- Identify stale facts not verified in 30+ days and queue for re-verification
- Check for notes with low confidence that have been in vault for 7+ days without additional sources
- Update vault metrics snapshot via `POST /api/vault-metrics`

## Nightly Close (daily, outside quiet hours)
- Summarize the day: decisions made, tasks created, sources ingested
- Reconcile any new contradictions discovered during the day
- Run synthesis pass: scan notes updated in the last 24 hours for cross-source patterns
- Generate daily note via `POST /api/daily-notes` with day summary
- Flag any notes that were updated by multiple sources today (high-activity topics)

## Weekly Review (every 7 days)
- Generate vault health report:
  - Total notes, growth rate (new notes this week vs last)
  - Orphan count (notes with zero inbound links)
  - Contradiction count (unresolved vs resolved)
  - Synthesis count (patterns identified this week)
  - Staleness index (% of notes not verified in 30+ days)
- Identify knowledge gaps: topics the user engages with often but has few vault notes on
- Surface highest-confidence synthesis pages for the user to review
- Archive resolved contradictions older than 30 days
