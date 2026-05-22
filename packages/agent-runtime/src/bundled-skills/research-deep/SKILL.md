---
name: research-deep
version: 2.0.0
description: Deep research on a topic — search multiple sources, build a canvas dashboard with findings
trigger: "research|look up|find out about|deep dive|analyze|compare"
tools: [web, write_file]
---

# Deep Research

When triggered, perform thorough multi-source research and present on canvas:

1. **Search** — Use `web` to search 2-3 different queries on the topic
2. **Gather** — Visit top 3-5 relevant results, extract key data
3. **Synthesize** — Identify key takeaways, trends, and data points
4. **Build canvas** — Create a research dashboard:
   - Metric components for key stats
   - "Key Takeaways" card at top with bullet points
   - Table of articles/sources (title, source, summary, link)
   - Topic breakdown (categories or comparison table)
5. **Persist** — Save findings to MEMORY.md for future reference via `write_file`

Always include source URLs. Clearly label facts vs opinions.
