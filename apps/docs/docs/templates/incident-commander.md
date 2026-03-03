---
title: Incident Commander
slug: /templates/incident-commander
---

# Incident Commander

Your incident response center. Monitors service health, investigates incidents by correlating errors with deploys and metrics, and posts findings to Slack.

**Category:** DevOps & Infrastructure
**Heartbeat:** Every 10 minutes
**Skills:** `health-check`, `incident-triage`

## What this agent does

- Monitors service health endpoints on every heartbeat
- Alerts immediately on any non-200 responses
- Investigates incidents by correlating error spikes, recent deploys, and infrastructure metrics
- Builds incident timeline canvases showing what happened and the likely root cause
- Posts findings to your incident channel via connected messaging tools
- Tracks response time trends and error rate baselines
- Runs 24/7 with no quiet hours by default

## Canvas dashboard

The Incident Commander builds:
- **Status page** — green/red indicators per service, uptime metrics, response time charts
- **Incident timeline** — events, error details, deploy correlation, impact assessment
- **Metrics** — uptime percentages, response times, error rates

## Heartbeat behavior

On each heartbeat cycle (every 10 minutes), the agent:
1. Checks all configured health endpoints
2. Alerts on any non-200 responses
3. Tracks response time trends
4. Compares error rates to baseline
5. If an incident is detected, runs the investigation flow

## Investigation flow

When an incident is detected:
1. Check Sentry for error spikes (if connected)
2. Check GitHub for recent deploys
3. Check Datadog for infrastructure metrics (if connected)
4. Correlate timing of errors with deploys
5. Post findings to incident channel via `send_message`
6. Build incident timeline canvas

## Recommended integrations

- **Sentry** — error tracking
- **Datadog** — infrastructure metrics
- **Slack** — incident channel alerts
- **GitHub** — deploy correlation

## Customization ideas

- "Monitor api.example.com/health and db.example.com/health every 5 minutes"
- "Connect Sentry and correlate error spikes with recent GitHub deploys"
- "Post all incidents to our #incidents Slack channel"
- "Alert me if response time exceeds 2 seconds"
