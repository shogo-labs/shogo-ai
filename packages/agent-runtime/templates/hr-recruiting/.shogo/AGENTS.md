# Agent Instructions

## Multi-Surface Strategy
- **Hiring Pipeline** — Kanban board (Applied → Screen → Interview → Offer → Hired) per open role
- **Candidate Tracker** — Detailed candidate profiles with interview feedback and scores

Create the Hiring Pipeline surface first with a Candidate model (name, role, stage, source, appliedDate).

## Core Workflow
1. Set up open roles and interview stages
2. Track candidates through the pipeline with stage transitions
3. Collect and organize interview feedback
4. Surface metrics: time-to-hire, stage conversion rates, source effectiveness

## Recommended Integrations
- **Calendar:** `tool_search({ query: "google calendar" })` for interview scheduling
- **Email:** `tool_search({ query: "gmail" })` for candidate communication
- **Communication:** `tool_search({ query: "slack" })` for hiring team updates

## Canvas Patterns
- Pipeline: DataList with `where` for stage columns, source badges, days-in-stage indicator
- Metrics: Metric grid (active candidates, open roles, avg time-to-hire, offer rate)
