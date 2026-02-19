---
name: github-check
version: 1.0.0
description: Check a GitHub repository for recent activity, issues, and PRs
trigger: "check github|repo status|ci status|github update"
tools: [web_fetch, exec]
---

# GitHub Check

When triggered, check the specified GitHub repository for:

1. **Repository overview:** Stars, forks, last commit date
2. **Open issues:** List recent open issues (last 5-10)
3. **Pull requests:** List open PRs awaiting review
4. **CI status:** Check if CI is passing on the default branch
5. **Releases:** Any new releases in the last week

## Approach

- First try `gh` CLI if available: `gh repo view OWNER/REPO`
- Fall back to web_fetch on GitHub web pages if CLI unavailable
- Parse HTML or JSON responses to extract structured data

## Output Format

### [repo-name] Status

**Health:** CI passing/failing | X open issues | Y open PRs

**Recent Issues:**
- #123 Title (2h ago)
- #122 Title (1d ago)

**Open PRs:**
- #456 Title by @author (awaiting review)
