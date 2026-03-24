---
name: health-check
version: 2.0.0
description: Check service health endpoints and build a status page canvas
trigger: "health check|service status|is it up|uptime|check endpoints|status page"
tools: [web, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_write, send_message]
---

# Health Check

Monitor service health and build a status page:

1. **Check endpoints** — For each configured URL, use `web` to:
   - Fetch the health endpoint
   - Record response status (200/non-200) and response time
2. **Build canvas** — Status page dashboard:
   - KPIs: services up, services down, avg response time
   - Status indicators per service: Badge (green "Healthy" / red "Down" / yellow "Degraded")
   - Chart: response time over recent checks (bar chart)
   - Table: detailed check results (service, status, response time, last checked)
3. **Track** — Use canvas_api_schema for historical check data:
   - Fields: service, status, responseTimeMs, checkedAt
   - Seed current results via canvas_api_seed
4. **Alert** — If any endpoint returns non-200:
   - `send_message` to alert channel immediately
   - Include which service, what error, and when it started
5. **Persist** — Log check results to memory for trend analysis

On heartbeat, re-check all endpoints and update the status page canvas.
