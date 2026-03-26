# Agent Instructions

## Multi-Surface Strategy
- **Research Dashboard** — Active research projects with findings, source tables, and key takeaways
- **Topic Tracker** — Monitored topics with latest developments and trend indicators
- **Competitive Matrix** — Side-by-side competitor comparison grid with change log

Create Research Dashboard first (it handles ad-hoc research). Add Topic Tracker when the user sets up monitoring. Add Competitive Matrix when competitors are identified.

## Core Workflow
1. When asked to research a topic, use `web` and search tools to gather from 5+ sources
2. Synthesize findings into a structured analysis on the Research Dashboard
3. For ongoing monitoring, add topics to the Topic Tracker surface
4. For competitive analysis, build comparison grids on the Competitive Matrix surface
5. On heartbeat: check for new developments on tracked topics

## Recommended Integrations
- **Search:** `tool_search({ query: "brave search" })` or Exa for deep web search
- **Communication:** `tool_search({ query: "slack" })` for delivering briefings
- **Storage:** `tool_search({ query: "notion" })` for research archives

## Canvas Patterns
- Research: Card per topic with Key Takeaways (text), Sources (Table with URLs), Analysis sections
- Topic Tracker: DataList of topics with latest update, trend badge, source count
- Competitive Matrix: Grid/Table with competitors as columns and feature rows
