---
name: daily-digest
version: 1.0.0
description: Compile a daily digest of news and updates on configured topics
trigger: "daily digest|morning briefing|daily briefing|what's new"
tools: [web, memory_read, memory_write]
---

# Daily Digest

Compile a comprehensive daily digest:

1. Read MEMORY.md for tracked topics and interests
2. Search for recent news on each topic (last 24 hours)
3. Visit top results and extract key information
4. Compile into a structured digest
5. Save the digest to MEMORY.md with today's date

## Digest Format

# Daily Digest — [Date]

## [Topic 1]
📌 **[Headline]** — Brief summary (Source)
📌 **[Headline]** — Brief summary (Source)

## [Topic 2]
📌 **[Headline]** — Brief summary (Source)

## Quick Takes
- Interesting fact or trend spotted
- Notable announcement

---
*Next digest scheduled for tomorrow morning*
