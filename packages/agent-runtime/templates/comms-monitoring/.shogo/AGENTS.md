# Agent Strategy

## Canvas Surfaces

1. **Alert Dashboard** — Primary surface showing today's alert count, last-checked timestamp, and a live feed of recent alerts from both email and Slack
2. **Email Monitor Panel** — Dedicated view for email alerts: sender rules, matched emails, urgency classifications, and delivery status
3. **Slack Mention Feed** — Real-time feed of @mentions, keyword matches, and watched-channel activity with urgency breakdown
4. **Rules & Configuration** — Editable panel for sender rules, keyword watchlists, channel mappings, and alert routing
5. **Delivery Log** — Historical record of all forwarded alerts with deduplication status and delivery counts

## Core Workflow

1. On each heartbeat, run `email-monitor` and `slack-mention-watch` in sequence
2. Load stored rules from memory for each skill before scanning
3. Filter results to only new items since the last check timestamp
4. Classify each item by urgency (urgent / normal / FYI)
5. Route urgent items immediately via `slack-forward` or `send_message`
6. Batch non-urgent items into a digest if volume exceeds threshold
7. Update all canvas surfaces with fresh counts, feeds, and timestamps
8. Persist last-check timestamps and seen message IDs to memory

## Skill Workflow

- **`email-monitor`** runs first — connects Gmail, applies sender rules, fetches new emails, classifies urgency, and hands off alerts to `slack-forward`
- **`slack-mention-watch`** runs second — connects Slack, scans for @mentions and keywords, categorizes results, updates the mention feed, and fires immediate alerts for urgent items
- **`slack-forward`** is called by `email-monitor` (and optionally by `slack-mention-watch`) to format and deliver rich Slack messages to the correct channel based on routing rules
- All three skills read from and write to shared memory keys to stay in sync and avoid duplicate alerts

## Recommended Integrations

- Search `gmail` — for email monitoring and search via Composio OAuth
- Search `slack` — for mention scanning, keyword search, and message delivery
- Search `notion` — for logging alert summaries to a shared team workspace
- Search `linear` — for auto-creating issues from high-urgency alerts
- Search `pagerduty` — for escalating critical production alerts beyond Slack

## Canvas Patterns

- **Metric grid** — alerts-today, unread mentions, keywords tracked, channels watched
- **DataList** — recent alerts feed (sender/channel, subject/snippet, urgency badge, timestamp)
- **Tabs** — switch between Email Alerts, Slack Mentions, and Delivery Log
- **Status indicators** — last-checked timestamp with green/yellow/red freshness indicator
- **Urgency breakdown chart** — bar or donut showing urgent / normal / FYI distribution
