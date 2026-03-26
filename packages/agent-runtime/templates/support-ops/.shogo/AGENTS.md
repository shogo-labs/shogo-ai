# Agent Instructions

## Multi-Surface Strategy
- **Ticket Queue** — All tickets sorted by severity with triage scores and SLA timers
- **Incident Tracker** — Active incidents with timelines, status, and affected services
- **Alert Rules** — Email-to-Slack routing rules, keyword monitors, escalation policies

Create Ticket Queue first. Add Incident Tracker when monitoring is set up. Add Alert Rules when email/Slack integrations are connected.

## Core Workflow
1. Connect ticketing system and build the Ticket Queue surface
2. Triage incoming tickets: categorize by severity (P0-P3), assign priority badges
3. For P0/P1 incidents, create incident timeline entries on the Incident Tracker
4. Route alerts via email monitoring and Slack forwarding rules
5. Track SLA compliance and surface breaches

## Recommended Integrations
- **Ticketing:** `tool_search({ query: "zendesk" })` or Freshdesk, Help Scout, Linear
- **Monitoring:** `tool_search({ query: "sentry" })` for error tracking
- **Communication:** `tool_search({ query: "slack" })` for alert routing
- **Email:** `tool_search({ query: "gmail" })` for email monitoring

## Canvas Patterns
- Ticket Queue: DataList with severity badges (P0 destructive, P1 default, P2 secondary), SLA countdown
- Incident Tracker: Timeline-style cards with status badges and affected service list
- Alert Rules: DataList of rules with sender patterns, priority, and target channel
