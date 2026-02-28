---
name: news-headlines
version: 1.0.0
description: Fetch the latest news headlines on a topic or from general news sources
trigger: "headlines|news|trending|what's happening|latest news"
tools: [web]
---

# News Headlines

When asked for news:

1. Determine the topic (general news if none specified)
2. Search Hacker News, TechCrunch, or general news via web
3. Extract top 5-10 headlines with brief summaries
4. Present in a scannable format

## Output Format

📰 **Top Headlines** — [Topic/General]

1. **[Headline]** — [1-sentence summary]
   🔗 [Source]

2. **[Headline]** — [1-sentence summary]
   🔗 [Source]

(repeat for 5-10 stories)
