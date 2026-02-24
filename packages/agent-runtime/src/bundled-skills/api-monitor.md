---
name: api-monitor
version: 1.0.0
description: Monitor API endpoints for uptime, response time, and health status
trigger: "api status|check endpoint|uptime|is it up|health check|monitor url|ping|status page"
tools: [web_fetch, memory_read, memory_write]
---

# API & Endpoint Monitor

Check API endpoints for availability, response time, and health.

## Commands

**Check endpoint:** Test a single URL
- Send a request and report status code, response time, and body preview
- Flag errors (timeouts, 4xx, 5xx)

**Bulk check:** Test multiple endpoints at once
- Read a list of URLs from a config or memory
- Report status for all endpoints in a table

**Set up monitoring:** Save endpoints for regular heartbeat checks
- Store URL list in memory
- Check on every heartbeat tick and alert on failures

**History:** Show uptime history for monitored endpoints
- Read from memory logs
- Calculate uptime percentage

## Workflow

1. **Fetch** each endpoint using web_fetch
2. **Record** status code and response time
3. **Compare** to previous checks (from memory) to detect changes
4. **Alert** on status changes (was up, now down — or vice versa)
5. **Save** results to memory for trend tracking

## Output Format

**API Health Dashboard** — Checked at 14:30 UTC

| Endpoint | Status | Response | Change |
|----------|--------|----------|--------|
| api.example.com/health | ✅ 200 OK | 145ms | — |
| api.example.com/v2/users | ✅ 200 OK | 230ms | — |
| payments.example.com | 🔴 503 Error | timeout | ⚠️ Was OK 1h ago |
| cdn.example.com/assets | ✅ 200 OK | 45ms | — |

**Uptime (24h):** 97.5% | **Incidents:** 1 (payments API)

## Guidelines

- Default timeout: 10 seconds
- Report both status code and response time
- Use memory to track status over time
- On heartbeat, only alert if status CHANGED (avoid spam)
- Include helpful next steps when an endpoint is down

