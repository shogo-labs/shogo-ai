---
name: topic-tracker
version: 2.0.0
description: Track topics over time — daily digest of new developments from web sources
trigger: "daily digest|morning briefing|what's new|topic update|news update"
tools: [web, memory_read, memory_write, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed]
---

# Topic Tracker

Compile a daily digest of developments on tracked topics:

1. **Recall** — Read memory for tracked topics and previous findings
2. **Search** — For each topic, search for news/developments from the last 24 hours
3. **Filter** — Skip articles already in memory, focus on genuinely new information
4. **Build canvas** — Create or update a digest dashboard:
   - Date badge at top
   - Card per topic with latest headlines and summaries
   - Table of all new articles with source, date, and summary
5. **Persist** — Save the digest to memory with today's date
6. **Notify** — If a channel is configured, send a summary via `send_message`

If no topics are configured yet, ask the user what they want to track and save to memory.
