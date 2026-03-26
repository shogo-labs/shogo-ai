---
name: incident-triage
version: 2.0.0
description: Investigate production incidents — correlate errors, deploys, and metrics into a timeline
trigger: "incident|something broke|production issue|outage|error spike|investigate|postmortem"
tools: [tool_search, tool_install, web, canvas_create, canvas_update, memory_write, send_message]
---

# Incident Triage

When a production incident is reported, investigate and build a timeline:

1. **Gather data** — Check available integrations via `tool_search`, then:
   - **Sentry** (if installed): `SENTRY_LIST_ISSUES` for recent error spikes
   - **GitHub** (if installed): `GITHUB_LIST_RECENT_DEPLOYS` for recent deploys
   - **Datadog** (if installed): `DATADOG_QUERY_METRICS` for infra metrics
   - If tools aren't installed, suggest connecting them:
     `tool_search("sentry")`, `tool_search("datadog")`
   - Fall back to `web` to check public status pages
2. **Correlate** — Build a timeline:
   - When did errors start spiking?
   - Was there a deploy around that time?
   - What changed in the deploy?
   - What's the impact (error rate, latency, affected users)?
3. **Build canvas** — Incident timeline:
   - Alert card: severity, impact summary, start time
   - Timeline: sequence of events (deploys, error spikes, metric changes)
   - Root cause card: likely cause with evidence
   - Action items: what to do next (rollback, fix, monitor)
4. **Notify** — Post findings to incident channel via `send_message`:
   ```
   🔴 **Incident Report**
   **Impact:** [description]
   **Root Cause:** [likely cause]
   **Timeline:** [key events]
   **Next Steps:** [actions]
   ```
5. **Persist** — Log incident details to memory for postmortem
