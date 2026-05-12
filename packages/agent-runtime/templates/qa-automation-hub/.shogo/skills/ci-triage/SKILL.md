---
name: ci-triage
version: 1.0.0
description: Classify and triage CI/CD pipeline failures — regressions, flaky tests, infra issues
trigger: "ci failure|build failed|pipeline broken|flaky test|triage|ci broken|tests failing|build red|pipeline failed"
tools: [tool_search, tool_install, memory_read, memory_write, shell_exec]
---

# CI Failure Triage

Systematically diagnose CI/CD failures and classify them by root cause.

## Triage Workflow

### 1. Connect to CI Provider
- Ensure GitHub integration (or relevant CI tool) is installed via `tool_search`
- If not connected: `tool_install({ name: "github" })` for GitHub Actions
- For other providers, ask user for access method

### 2. Pull Failure Logs
- Fetch the latest failed build/workflow run
- Extract: job name, step that failed, exit code, stdout/stderr
- Identify the failing test name(s) and assertion(s)

### 3. Classify Root Cause

| Category | Signals | Action |
|----------|---------|--------|
| **Real regression** | Test was passing in previous runs, now fails consistently | Identify the failing assertion. Correlate with recent commits via `git log`. Suggest which change caused it. |
| **Flaky test** | Test has flipped pass/fail in recent history (check memory) | Check memory for flip count. If 3+ flips in 7 days → confirmed flaky. Suggest stabilization. |
| **Environment issue** | Timeout errors, connection refused, DNS resolution, missing env vars | Not a code problem. Suggest retry, check infra, verify env configuration. |
| **Dependency issue** | `npm install` fails, version conflicts, breaking changes in packages | Check `package-lock.json` changes. Suggest pinning versions or updating. |
| **Build error** | TypeScript errors, lint failures, compilation errors | Not a test failure. Point to the exact file/line with the error. |

### 4. Check Memory for History
- Look up the failing test name in `MEMORY.md`
- If seen before: show flip history and trend
- If new failure: record it as first occurrence

### 5. Suggest Action

**For real regressions:**
1. Identify the exact assertion that fails
2. Find the most recent commit that touched the relevant file
3. Suggest: "This test started failing after commit `abc123` which changed `src/auth.ts`"
4. Recommend: fix the code or update the test if behavior intentionally changed

**For flaky tests:**
1. Show flip history from memory
2. Common stabilization strategies:
   - Replace `waitForTimeout` with `waitForSelector` or `waitForLoadState`
   - Add retry logic for network-dependent assertions
   - Isolate test data — don't share state between tests
   - Add `test.describe.serial` for order-dependent tests
   - Increase timeout for slow CI environments
3. If stabilization isn't feasible: suggest quarantining the test

**For environment issues:**
1. Check if the issue is transient (retry the build)
2. If persistent: check CI runner config, env vars, service health
3. Common fixes: restart CI runner, clear cache, update base image

**For dependency issues:**
1. Check if `package-lock.json` or `yarn.lock` changed recently
2. Check if a dependency released a breaking change
3. Suggest: pin to last known working version, then investigate upgrade path

## Flaky Test Detection

A test is **flaky** if it meets any of these criteria:
- Flipped pass/fail 3+ times in the last 7 days
- Fails only on CI but passes locally
- Fails intermittently without code changes
- Contains timing-dependent assertions

### Flaky Test Memory Schema
```json
{
  "testName": "login flow should redirect to dashboard",
  "file": "tests/auth.spec.ts",
  "flipHistory": [
    { "date": "2024-01-15", "result": "fail", "ci_run": "12345" },
    { "date": "2024-01-15", "result": "pass", "ci_run": "12346" },
    { "date": "2024-01-16", "result": "fail", "ci_run": "12350" }
  ],
  "flipCount7d": 3,
  "status": "flaky",
  "lastStabilizationAttempt": null
}
```

## Reporting Format

When presenting triage results:

```
## CI Triage Report — Build #12345

**Status:** ❌ Failed
**Failed at:** Test step — `npm run test:e2e`
**Duration:** 4m 32s

### Failures (2)

1. **`auth.spec.ts` → "should redirect after login"**
   - Classification: 🔴 Real Regression
   - Assertion: `Expected URL to contain '/dashboard', got '/login'`
   - Likely cause: Commit `abc123` changed the auth redirect logic
   - Suggested fix: Check `src/middleware/auth.ts` line 42

2. **`checkout.spec.ts` → "should calculate tax"**
   - Classification: 🟡 Flaky (seen 4x in 7 days)
   - Flip history: pass → fail → pass → fail
   - Suggested fix: Replace `waitForTimeout(2000)` with `waitForSelector('.total-amount')`

### Passing (47/49)
```

## Proactive Monitoring

During heartbeat cycles:
- Check for new failed builds since last check
- Auto-triage any new failures
- Update flaky test scores in memory
- Alert user only for real regressions (don't spam about known flaky tests)
