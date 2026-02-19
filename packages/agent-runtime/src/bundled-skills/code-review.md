---
name: code-review
version: 1.0.0
description: Review code snippets or files for quality, security, and best practices
trigger: "review code|check code|code review|review this"
tools: [read_file, exec]
---

# Code Review

When asked to review code:

1. Read the provided code (from message or file)
2. Analyze for:
   - **Security:** SQL injection, XSS, hardcoded secrets, auth issues
   - **Correctness:** Logic errors, edge cases, error handling
   - **Performance:** N+1 queries, unnecessary allocations, blocking calls
   - **Style:** Naming, structure, readability
3. Provide actionable feedback

## Output Format

### Code Review Summary

**Overall:** ✅ Looks good / ⚠️ Needs changes / 🔴 Critical issues

**Security:**
- [Finding with severity and suggestion]

**Correctness:**
- [Finding with explanation]

**Suggestions:**
- [Improvement ideas]
