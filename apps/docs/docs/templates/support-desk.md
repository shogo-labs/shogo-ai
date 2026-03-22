---
title: Support Desk
slug: /templates/support-desk
---

# Support Desk

Your support operations hub. Triages support tickets, tracks KPIs, and escalates urgent issues. Connects to Zendesk, Linear, or any ticketing tool.

**Category:** Business
**Heartbeat:** Every 30 minutes
**Skills:** `ticket-triage`, `escalation-alert`

## What this agent does

- Connects to your ticketing tool (Zendesk, Linear, etc.) via Composio
- Categorizes tickets by severity and impact
- Builds a support dashboard with KPIs and ticket tables
- Escalates P0/P1 issues immediately via connected channels
- Identifies patterns across tickets (recurring issues, volume trends)
- Tracks resolution times for trend analysis

## Canvas dashboard

The Support Desk agent builds dashboards with:
- **KPIs** — open tickets, resolved (7 days), average response time, CSAT score
- **Charts** — ticket volume by day, breakdown by priority
- **CRUD table** — tickets with subject, priority, status, and created date

## Heartbeat behavior

On each heartbeat cycle, the agent:
1. Scans for new tickets since last check
2. Categorizes by severity
3. Alerts on P0/P1 tickets immediately via `send_message`
4. Updates dashboard KPIs
5. Runs daily pattern analysis (recurring categories, volume trends, SLA breaches)

## Escalation priorities

1. **P0 Critical** (service outage, data loss) — immediate alert + escalation
2. **P1 High** (major feature broken) — alert within 15 minutes
3. **P2 Medium** (partially broken feature) — batched in daily digest
4. **P3 Low** (cosmetic, edge case) — weekly summary

## Recommended integrations

- **Zendesk** or **Linear** — for ticket data
- **Slack** or **Discord** — for escalation alerts

## Customization ideas

- "Connect Zendesk and build a support dashboard with ticket volume trends"
- "Alert me on Slack immediately when any P0 ticket comes in"
- "Track average resolution time by category"
- "Send a weekly report of recurring issue patterns"
