---
name: summarize-url
version: 1.0.0
description: Fetch a URL and provide a concise summary of the content
trigger: "summarize|tldr|summarise|sum up"
tools: [web_fetch]
---

# Summarize URL

When the user provides a URL to summarize:

1. Fetch the page content using web_fetch
2. Extract the main content (ignore navigation, ads, footers)
3. Provide a structured summary:
   - **TL;DR:** 1-2 sentence overview
   - **Key Points:** 3-5 bullet points
   - **Notable Details:** Anything particularly interesting or important
4. Keep the total summary under 200 words
