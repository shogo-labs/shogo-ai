---
name: ticket-triage
version: 2.0.0
description: Triage support tickets — categorize by severity, identify patterns, build dashboard
trigger: "triage tickets|support tickets|ticket status|check tickets|new tickets"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, canvas_api_bind, memory_write]
---

# Ticket Triage

When triggered, pull and triage support tickets:

1. **Connect** — Search for a ticketing integration via `tool_search`. If none installed:
   - `tool_search("zendesk")` or `tool_search("linear")` to find options
   - `tool_install` with the chosen toolkit for Composio OAuth
   - Use autoBind to connect ticket data to canvas
2. **Fetch** — Pull recent tickets via the connected tool (e.g. ZENDESK_LIST_TICKETS)
3. **Categorize** — Classify each ticket by:
   - Severity: P0 Critical, P1 High, P2 Medium, P3 Low
   - Category: login/auth, performance, billing, feature request, bug
4. **Build canvas** — Support dashboard:
   - KPIs: open tickets, resolved (7d), avg response time, CSAT
   - Chart: ticket volume by day (bar chart)
   - Chart: breakdown by priority (horizontal bar)
   - CRUD Table: tickets with subject, priority, status, created date
5. **Identify patterns** — Group tickets by category, note recurring issues
6. **Persist** — Log triage summary to memory

If no ticketing tool is available, use canvas_api_schema to create a standalone ticket tracking system.
