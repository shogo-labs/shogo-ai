---
name: changelog
version: 1.0.0
description: Check what changed in a project, repo, or codebase recently
trigger: "changelog|what changed|recent changes|git log|commit history"
tools: [exec, web]
---

# Changelog

When the user asks about recent changes:

1. **Local git repo** (if available):
   - Recent commits: `exec("git log --oneline -20")`
   - Changed files: `exec("git diff --stat HEAD~5")`
   - Tags/releases: `exec("git tag --sort=-creatordate | head -5")`
2. **Remote repo** (if URL provided):
   - Fetch releases page or changelog via web
3. **Summarize** changes by category

## Output Format

### Changelog — [Project Name]

**Period:** [date range]

**New Features:**
- [Feature description] (commit/PR reference)

**Bug Fixes:**
- [Fix description] (commit/PR reference)

**Other Changes:**
- [Change description]

**Contributors:** @author1, @author2
