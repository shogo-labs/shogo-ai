---
name: github-check
version: 1.0.0
description: Check a GitHub repository for recent activity, open issues, and PR status
trigger: "check github|repo status|ci status|github status"
tools: [web_fetch, exec]
---

# Check GitHub Repository

When triggered, check the specified GitHub repository:

1. Try using `gh` CLI first (exec tool) for structured data
2. Fall back to web_fetch on GitHub web pages if CLI unavailable
3. Report on:
   - Repository stats (stars, forks, open issues count)
   - Latest open issues (top 5, with labels)
   - Open pull requests awaiting review
   - CI/CD status on the default branch
   - Any recent releases

## Output Format

**Repository:** owner/repo
**Stars:** X | **Forks:** Y | **Open Issues:** Z

**CI Status:** ✅ Passing / 🔴 Failing

**Recent Issues:**
- #123 Issue title (label) — 2 hours ago

**Open PRs:**
- #456 PR title — by @author, 1 day ago
