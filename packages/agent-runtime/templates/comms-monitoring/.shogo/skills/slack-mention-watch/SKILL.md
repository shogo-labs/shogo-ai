---
name: slack-mention-watch
version: 1.0.0
description: Monitor Slack for @mentions, keywords, and important channel activity
trigger: "check mentions|slack mentions|who mentioned me|keyword alert|monitor slack|slack watch"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message]
---

# Slack Mention Watch

Monitor Slack for mentions, keywords, and important activity:

1. **Connect** — Check if Slack integration is installed via `tool_search`. If not:
   - `tool_install({ name: "slack" })` to connect via Composio OAuth
2. **Load rules** — Read watch rules from memory (key: `slack_watch_rules`)
   - @mention detection (always on by default)
   - Keyword patterns (e.g., "production down", "outage", "deploy")
   - Channel watchlist (specific channels to monitor closely)
   - If no rules exist, set up defaults and ask user to customize
3. **Scan** — Search Slack for new activity since last check:
   - `SLACK_SEARCH` for @mentions of the user
   - `SLACK_SEARCH` for each configured keyword
   - `SLACK_READ_MESSAGES` for watched channels (recent messages)
4. **Categorize** — Classify each match:
   - **Urgent:** direct @mention + urgent keywords, DMs from leadership
   - **Normal:** regular @mentions, keyword matches in public channels
   - **FYI:** channel activity in watched channels, thread replies
5. **Update canvas** — Refresh the mention monitor dashboard:
   - KPIs: unread mentions, channels watched, keywords tracked
   - Recent mentions feed with channel, author, timestamp, snippet
   - Urgency breakdown (urgent / normal / FYI counts)
6. **Alert** — For urgent mentions:
   - `send_message` immediately with context and link
7. **Persist** — Save last-check timestamp and mention log to memory
   - Deduplicate: skip already-seen message IDs
