---
name: web-research
version: 1.0.0
description: Research a topic using web search and provide a structured summary with sources
trigger: "research|look up|find info|find out about|what do you know about"
tools: [web_fetch, memory_write]
---

# Web Research

When this skill is triggered, perform thorough web research on the user's topic:

1. **Search:** Use web_fetch to search for the topic (try Google, Bing, or DuckDuckGo)
2. **Deep dive:** Visit the top 3-5 most relevant results
3. **Synthesize:** Combine findings into a structured summary with:
   - Key facts and figures
   - Different perspectives if applicable
   - Timeline of events if relevant
4. **Cite sources:** Always include URLs for every claim
5. **Save:** Store key findings in daily memory for future reference

## Output Format

### [Topic Name]

**Summary:** 2-3 sentence overview

**Key Findings:**
- Finding 1 ([source](url))
- Finding 2 ([source](url))

**Sources:**
1. [Title](url) - brief description
