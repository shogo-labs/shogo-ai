---
name: news-digest
version: 1.0.0
description: Get latest news and headlines on a topic or in general
trigger: "news|headlines|what's happening|current events|trending"
tools: [web_fetch, memory_write]
---

# News Digest

When the user asks about news or current events:

1. **Fetch headlines** from multiple sources:
   - Hacker News: `web_fetch("https://hacker-news.firebaseio.com/v0/topstories.json")`
   - Or search via web_fetch for the specific topic
2. **Filter** for relevance if the user specified a topic
3. **Summarize** each story in 1-2 sentences
4. **Save** to daily memory for tracking

## Output Format

### News Digest — [Date]

**Top Stories:**
1. **[Headline]** — Brief summary ([source](url))
2. **[Headline]** — Brief summary ([source](url))
3. **[Headline]** — Brief summary ([source](url))

**Trending Topics:** topic1, topic2, topic3
