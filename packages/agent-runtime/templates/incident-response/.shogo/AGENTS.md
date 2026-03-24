# Agent Strategy

## Canvas Surfaces

{{AGENT_NAME}} manages the following canvas surfaces:

1. **Incident Timeline** — Per-incident canvas showing severity card, event timeline, root cause analysis, and next steps. Created fresh for each new incident.
2. **Live Status Page** — Persistent dashboard showing real-time health of all configured services, response time charts, and per-service status badges.
3. **Escalation Log** — Running record of all P0/P1 escalations with timestamps, resolution status, and postmortem links.
4. **Incident History** — Searchable list of past incidents with severity, duration, root cause, and outcome.
5. **Health Trend Charts** — Response time and uptime trends over time per service.

## Core Workflow

1. **Receive trigger** — Incident reported via message, or heartbeat detects anomaly during health check.
2. **Assess severity** — Determine P0/P1/P2/P3 based on impact scope and service criticality.
3. **Gather signals** — Query Sentry for error spikes, GitHub for recent deploys, Datadog for infra metrics. Fall back to public status pages via web search.
4. **Correlate timeline** — Align error onset with deploy times, config changes, and metric shifts.
5. **Build incident canvas** — Render timeline, root cause card, impact summary, and action items.
6. **Notify** — Post structured incident report to the configured alert channel.
7. **Persist** — Log incident to memory with full context for postmortem.
8. **Follow up** — On next heartbeat, check resolution status and post update.

## Skill Workflow

### `incident-triage`
Triggered when a production incident is reported. Runs the full investigation loop: gather → correlate → canvas → notify → persist. Use this skill whenever an engineer reports something is broken or when health checks detect a failure.

### `escalation-alert`
Triggered when triage confirms P0 or P1 severity. Composes a structured alert message and posts it immediately to the incident channel. Logs the escalation and follows up on resolution. Do not use for P2/P3 — batch those into the daily digest instead.

### `health-check`
Runs on every heartbeat. Checks all configured service endpoints, updates the Live Status Page canvas, and triggers `escalation-alert` if any endpoint is non-200. Tracks historical response times for trend analysis.

## Recommended Integrations

Search for and connect these integrations to unlock full capability:

- `tool_search("sentry")` — Error tracking and issue spikes
- `tool_search("datadog")` — Infrastructure metrics and APM
- `tool_search("github")` — Recent deploys and commit history
- `tool_search("pagerduty")` — On-call routing and escalation policies
- `tool_search("slack")` — Incident channel notifications and team alerts

## Canvas Patterns

- **Metric grid** — KPIs at the top of status page: services up, services down, avg response time, incidents today
- **DataList / Timeline** — Ordered sequence of incident events with timestamps and descriptions
- **Badge components** — Per-service health status: green "Healthy", red "Down", yellow "Degraded"
- **Bar chart** — Response time over recent health checks per service
- **Tabs** — Separate views for Active Incidents, Service Status, and Incident History
- **Alert card** — Prominent severity/impact summary at the top of each incident canvas
