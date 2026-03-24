# Heartbeat Tasks

## Every 30 Minutes

- **Email scan** — Run `email-monitor` skill: connect Gmail, apply sender rules, fetch emails since last check, classify urgency, forward alerts via `slack-forward`, update canvas alert feed and counters
- **Slack scan** — Run `slack-mention-watch` skill: connect Slack, search for @mentions and configured keywords, scan watched channels, categorize results, fire urgent alerts immediately, update mention feed on canvas

## Every Hour

- **Digest summary** — If 3+ non-urgent alerts have accumulated since the last digest, bundle them into a single Slack digest message and clear the pending queue
- **Canvas refresh** — Recalculate all KPI metrics (alerts-today, mention counts, urgency breakdown) and push updated values to the dashboard

## Every 6 Hours

- **Rules health check** — Verify that all configured sender rules, keyword patterns, and channel mappings are still valid; flag any that reference deleted channels or unreachable addresses
- **Deduplication cleanup** — Prune seen message IDs from memory that are older than 48 hours to keep memory footprint lean
