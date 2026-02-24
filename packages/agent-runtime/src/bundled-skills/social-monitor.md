---
name: social-monitor
version: 1.0.0
description: Monitor social media platforms for mentions, trends, and updates
trigger: "twitter|tweet|reddit|linkedin|social media|trending|mentions|hashtag|subreddit"
tools: [web_fetch, memory_read, memory_write]
---

# Social Media Monitor

Monitor social media platforms for relevant content and trends.

## Supported Platforms

**Twitter/X:** Search for mentions, hashtags, or user activity
**Reddit:** Monitor subreddits, search posts, track discussions
**LinkedIn:** Check for posts, articles, and company updates
**Hacker News:** Monitor front page and search for topics

## Workflow

1. **Identify the platform** and search terms from the user's request
2. **Fetch** content using web_fetch (public feeds, search pages)
3. **Extract** relevant posts, mentions, or trends
4. **Summarize** findings with links, engagement metrics, and sentiment
5. **Save** to memory for tracking changes over time

## Output Format

**Platform:** Twitter/X
**Search:** "AI agents" | **Period:** Last 24h

**Top Mentions:**
- @user: "Post content..." — ❤️ 245 🔄 89 — 3h ago
- @user2: "Post content..." — ❤️ 120 🔄 34 — 6h ago

**Trending Hashtags:** #AIAgents, #MCP, #Automation

**Sentiment:** Mostly positive (72%), Neutral (20%), Negative (8%)

## Guidelines

- Use web_fetch to access public pages and RSS feeds
- For Reddit, fetch from old.reddit.com or JSON APIs (.json suffix)
- Track mentions over time using memory to detect trend changes
- Report engagement metrics when available (likes, shares, comments)
- Flag any negative mentions or potential PR issues

