---
name: ci-cd-status
version: 1.0.0
description: Check CI/CD pipeline status — GitHub Actions, builds, deployments, and test results
trigger: "ci status|pipeline|build status|deploy status|github actions|workflow|tests passing|build failed"
tools: [exec, web_fetch]
---

# CI/CD Pipeline Status

Check the status of CI/CD pipelines, builds, and deployments.

## Supported Platforms

- **GitHub Actions** — via `gh` CLI or web_fetch
- **Generic CI** — via web_fetch to status pages

## Commands

**Pipeline status:** Check current build/deploy status
- Show running, passed, and failed workflows
- Display commit that triggered the build
- Show duration and failure details

**Recent runs:** List recent pipeline executions
- Filter by branch, workflow name, or status
- Show success rate over last N runs

**Test results:** Summarize test outcomes
- Total tests, passed, failed, skipped
- List failing test names if available

**Deploy status:** Check deployment state
- Current deployed version/commit
- Last deployment time
- Environment (staging, production)

## Workflow

1. Try `gh run list` and `gh run view` via exec (preferred)
2. Fall back to web_fetch on GitHub repository actions page
3. Parse and present results in a clear format

## Output Format

**Repository:** owner/repo
**Branch:** main

| Workflow | Status | Duration | Commit | Triggered |
|----------|--------|----------|--------|-----------|
| CI Tests | ✅ Pass | 4m 32s | abc1234 | 2h ago |
| Deploy Prod | ✅ Pass | 2m 15s | abc1234 | 2h ago |
| Nightly E2E | 🔴 Fail | 12m 08s | def5678 | 8h ago |

**Failing:** Nightly E2E
- ❌ `test/e2e/checkout.spec.ts` — Timeout waiting for element
- ❌ `test/e2e/login.spec.ts` — Expected 200, got 503

**Success rate (last 7 days):** 94% (47/50 runs passed)

## Guidelines

- Always show the most recent run first
- Highlight failures prominently with error details
- For GitHub Actions, use `gh` CLI when available (faster, structured data)
- If no CI platform is detected, suggest setting one up

