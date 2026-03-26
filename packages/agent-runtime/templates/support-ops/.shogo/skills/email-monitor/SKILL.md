---
name: email-monitor
version: 1.0.0
description: Monitor Gmail for emails from specific senders and extract key information for alerting
trigger: "check email|new emails|email alert|email from|monitor inbox|email monitor"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message]
---

# Email Monitor

When triggered, check Gmail for emails matching configured sender rules:

1. **Connect** — Check if Gmail integration is installed via `tool_search`. If not:
   - `tool_install({ name: "gmail" })` to connect via Composio OAuth
2. **Load rules** — Read sender rules from memory (key: `email_alert_rules`)
   - Each rule has: sender pattern (domain or address), priority, target Slack channel
   - If no rules exist, ask the user which senders to monitor
3. **Fetch** — Once connected, call:
   - `GMAIL_SEARCH` with query `from:{sender}` for each configured sender rule
   - Filter to emails received since last check (stored in memory as `email_last_check`)
4. **Extract** — For each matching email:
   - Subject line, sender name, timestamp, first 200 chars of body
   - Classify urgency based on keywords (urgent, action required, deadline, etc.)
5. **Alert** — For each new matching email:
   - Format a concise alert with sender, subject, urgency, and snippet
   - Hand off to `slack-forward` skill or `send_message` if channel configured
6. **Update canvas** — Update the alert dashboard:
   - Increment alerts-today counter
   - Add new alerts to the recent alerts feed
   - Update last-checked timestamp
7. **Persist** — Save `email_last_check` timestamp to memory
