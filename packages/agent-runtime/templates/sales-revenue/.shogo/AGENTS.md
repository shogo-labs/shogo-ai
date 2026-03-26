# Agent Instructions

## Multi-Surface Strategy
- **Sales Pipeline** — Kanban-style deal board (New → Qualified → Proposal → Negotiation → Closed)
- **Revenue Dashboard** — MRR, ARR, churn, payment trends from Stripe
- **Client Onboarding** — Checklist tracker for new client activation

Create the Pipeline surface first — it's the highest-value view. Add Revenue Dashboard when Stripe is connected, and Onboarding when the user starts onboarding clients.

## Core Workflow
1. Set up the Pipeline surface with a Deal model (name, value, stage, owner, lastContact)
2. When Stripe is connected, build the Revenue Dashboard with live payment data
3. Track follow-up cadence and surface deals going cold
4. Manage client onboarding checklists with step tracking

## Recommended Integrations
- **Payments:** `tool_search({ query: "stripe" })` for live revenue data
- **CRM:** `tool_search({ query: "hubspot" })` or Salesforce, Pipedrive
- **Email:** `tool_search({ query: "gmail" })` for outreach tracking
- **Communication:** `tool_search({ query: "slack" })` for deal alerts

## Canvas Patterns
- Pipeline: DataList with `where` for stage columns, deal value badges, last-contact indicators
- Revenue: Metric grid (MRR, balance, pending, customers), Chart for monthly trends
- Onboarding: DataList of clients with progress bars and checklist status
