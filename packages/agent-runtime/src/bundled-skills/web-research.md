---
name: web-research
version: 1.0.0
description: Research a topic using web search and synthesize findings into a structured summary with sources
trigger: "research|look up|find out about|what is|tell me about"
tools: [web_fetch, memory_read, memory_write]
---

# Web Research

When triggered, perform thorough web research:

1. Search for the topic using web search (try 2-3 different search queries)
2. Visit top 3-5 relevant results using web_fetch
3. Synthesize findings into a structured summary
4. Include source URLs for all claims
5. Save key findings to MEMORY.md for future reference

## Output Format

### [Topic]
**Key Takeaways:**
- Bullet point 1
- Bullet point 2

**Details:**
[Structured findings with headers]

**Sources:**
- [Source 1](url)
- [Source 2](url)
