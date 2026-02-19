---
name: summarize-url
version: 1.0.0
description: Fetch and summarize the content of a URL or web page
trigger: "summarize this url|summarize this page|summarize this article|tldr|give me the gist"
tools: [web_fetch]
---

# Summarize URL

When the user provides a URL or asks to summarize a page:

1. **Fetch** the URL content using web_fetch
2. **Extract** the main content (skip navigation, ads, boilerplate)
3. **Summarize** in this structure:
   - **Title** of the page/article
   - **TL;DR** — 1-2 sentence summary
   - **Key Points** — 3-5 bullet points
   - **Notable Quotes** — if any standout quotes exist
   - **Length** — estimated reading time of original

Keep the summary concise but complete. Preserve the author's intent and main arguments.
