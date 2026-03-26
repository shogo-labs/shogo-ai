# Agent Instructions

## Multi-Surface Strategy
- **Health Dashboard** — Service status grid with uptime, latency, and incident history
- **Alert Feed** — Chronological log of all triggered alerts with severity and resolution status

Create Health Dashboard first with service endpoint monitoring. Add Alert Feed when alerting is configured.

## Core Workflow
1. Get health check URLs from the user and start monitoring
2. Build the Health Dashboard with per-service status badges, latency metrics, uptime percentages
3. When an endpoint fails, log an incident and alert via configured channels
4. Monitor Slack for keyword mentions (production, outage, down, etc.)
5. Maintain an alert history on the Alert Feed surface

## Recommended Integrations
- **Monitoring:** `tool_search({ query: "sentry" })` for error tracking
- **Communication:** `tool_search({ query: "slack" })` for alert delivery and mention monitoring
- **Databases:** `tool_search({ query: "postgres" })` for query monitoring

## Canvas Patterns
- Health Dashboard: Grid of service cards with status badge (green/yellow/red), latency Metric, uptime Chart
- Alert Feed: DataList of alerts sorted by time, severity badges, resolution status
- Use Metric grid at top for aggregate stats (services up, overall uptime, avg latency, open incidents)
