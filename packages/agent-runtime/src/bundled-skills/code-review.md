---
name: code-review
version: 1.0.0
description: Review code files for bugs, style issues, and improvements
trigger: "review this code|code review|check this code|audit code"
tools: [read_file]
---

# Code Review

When the user asks for a code review:

1. **Read** the specified file(s)
2. **Analyze** for:
   - **Bugs:** Logic errors, off-by-one, null safety, race conditions
   - **Security:** Injection risks, exposed secrets, insecure defaults
   - **Performance:** N+1 queries, unnecessary allocations, missing caches
   - **Style:** Naming conventions, code organization, dead code
   - **Best practices:** Error handling, typing, documentation
3. **Prioritize** findings by severity (Critical > High > Medium > Low)

## Output Format

### Code Review: [filename]

**Overall:** [Good / Needs Work / Critical Issues]

**Critical:**
- Line X: [description of issue]

**Suggestions:**
- Line Y: [improvement suggestion]

**Positive:**
- [What's done well]
