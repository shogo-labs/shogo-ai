---
name: slack-notify
version: 1.0.0
description: Send formatted notifications and messages to Slack channels
trigger: "notify slack|slack message|send to slack|post to slack|slack alert|slack channel"
tools: [web_fetch, read_file]
---

# Slack Notifications

Send formatted notifications and messages to Slack channels via webhooks or the Slack API.

## Commands

**Send message:** Post a message to a Slack channel
- Support plain text and formatted messages
- Include emoji, mentions, and links

**Send alert:** Post an urgent notification
- Use red/warning formatting
- Mention specific users or @channel/@here

**Send report:** Post a structured report
- Format data as Slack blocks (tables, sections, dividers)
- Include action buttons if supported

## Workflow

1. **Format** the message content with Slack markdown
2. **Send** via Slack webhook URL (if configured) using web_fetch
3. **Confirm** delivery status

## Message Format (Slack Webhook)

```json
{
  "text": "Fallback text for notifications",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "📊 Daily Report" }
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Revenue:* $12,450\n*Orders:* 89\n*Active users:* 1,234" }
    }
  ]
}
```

## Output Format

✅ Message sent to #general
- Content: "Daily Report — Revenue up 12%..."
- Timestamp: 2026-02-24 14:30:00 UTC

## Guidelines

- Use Slack mrkdwn format (*bold*, _italic_, `code`, >quote)
- Keep messages concise — Slack truncates long messages
- Use @channel sparingly (only for urgent alerts)
- If no webhook URL is configured, provide instructions to set one up
- Respect rate limits (1 message per second per webhook)

