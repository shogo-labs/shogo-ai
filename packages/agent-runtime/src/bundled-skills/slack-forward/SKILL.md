---
name: slack-forward
version: 1.0.0
description: Format and forward email alerts to configured Slack channels with rich formatting
trigger: "forward to slack|slack alert|notify slack|send to slack|post to slack"
tools: [tool_search, tool_install, memory_read, write_file, send_message]
---

# Slack Forward

Format and deliver email alerts to Slack:

1. **Connect** — Check if Slack integration is installed via `tool_search`. If not:
   - `tool_install({ name: "slack" })` to connect via Composio OAuth
2. **Load config** — Read channel mapping from memory (key: `slack_alert_channels`)
   - Default channel for general alerts
   - Per-sender overrides (e.g., billing@vendor.com -> #finance)
3. **Format** — Build a rich Slack message for each alert:
   - Header: sender name + urgency badge
   - Body: email subject + snippet
   - Footer: timestamp + link to full email (if available)
   - Use priority-based formatting (red for urgent, yellow for normal)
4. **Deliver** — Send formatted message via `SLACK_SEND_MESSAGE` to the appropriate channel
5. **Log** — Record delivery to memory for deduplication:
   - Store message ID to avoid re-alerting on the same email
   - Track delivery count for dashboard metrics
6. **Batching** — If multiple alerts fire at once (>3 in a single check):
   - Bundle into a single digest message instead of flooding the channel
   - Include count and top-priority items first
