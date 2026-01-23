# E2E Staging Test Report

**Test Date:** January 23, 2026  
**Environment:** https://studio-staging.shogo.ai  
**Tester:** Automated Playwright E2E Test

---

## Executive Summary

The staging deployment has **critical performance and reliability issues**. The application is functional but suffers from:
- Extremely slow page loads (25-40+ seconds)
- Multiple 5xx server errors during workspace operations
- API endpoints returning errors or being completely unreachable
- Race conditions in schema loading

---

## Critical Issues (P0)

### 1. API Server Unreachable
**Severity:** Critical  
**Endpoints Affected:** 
- `https://api-staging.shogo.ai/` - Returns HTTP response failure
- `https://api-staging.shogo.ai/health` - Returns HTTP response failure

**Impact:** Direct API access fails completely. The frontend proxies requests, but the API itself appears to be inaccessible or misconfigured.

---

### 2. Templates Page Returns 403 Forbidden
**Severity:** Critical  
**Endpoint:** `/templates`  
**Error:** `403 Forbidden` from `nginx/1.29.4`

**Impact:** Users cannot browse templates via the dedicated templates page. The homepage still shows templates inline, but the `/templates` route is broken.

---

### 3. Subdomain Check Consistently Returns 500
**Severity:** High  
**Endpoints:**
- `/api/subdomains/my-todo-app/check` → 500
- `/api/subdomains/loading/check` → 500

**Impact:** Custom subdomain assignment/publishing appears broken.

---

## High Priority Issues (P1)

### 4. Workspace Cold Start Errors (Multiple 5xx Errors)
**Severity:** High  
**Scenario:** Creating a new project from template

**Errors Observed (in sequence):**
| Endpoint | Status |
|----------|--------|
| `/api/projects/{id}/sandbox/url` | 503 |
| `/api/projects/{id}/files` | 502 |
| `/api/projects/{id}/terminal/commands` | 502 |
| `/api/projects/{id}/tests/list` | 502 |
| `/api/projects/{id}/runtime/stop` | 404 |
| `/api/projects/{id}/database/stop` | 502 |

**Console Error:** `Project {id} did not become ready within 30000ms`

**Impact:** Users see "Starting project runtime..." for extended periods with errors. Eventually loads after retries, but poor UX.

---

### 5. Race Condition: Schema Not Found
**Severity:** High  
**Error Message:** 
```
[AuthGate] Failed to check pending invitations: Error: Query failed: Schema 'studio-core' not found
```

**Location:** Occurs during initial page load while DomainProvider is still ingesting schemas.

**Impact:** AuthGate queries `studio-core` schema before it's loaded into the browser metaStore. This is a timing issue between:
1. Schema ingestion (DomainProvider)
2. Auth checks that depend on those schemas

---

### 6. Database Proxy Missing Font Assets (404s)
**Severity:** Medium  
**Endpoints:**
- `/api/projects/{id}/database/proxy/inter-latin-400-normal.*.woff2` → 404
- `/api/projects/{id}/database/proxy/inter-all-400-normal.*.woff` → 404
- `/api/projects/{id}/database/proxy/jetbrains-mono-*.woff2` → 404

**Impact:** Prisma Studio fonts don't load correctly. Functional but degraded appearance.

---

## Performance Issues (P1)

### 7. Extremely Slow Initial Page Load
**Severity:** High  
**Observed Times:**
| Page | Load Time |
|------|-----------|
| Homepage (first load) | 25-40 seconds |
| Homepage (navigation) | 15-30 seconds |
| Projects list page | ~15 seconds |
| Project workspace (after creation) | 20+ seconds |

**Root Cause Indicators:**
- Multiple sequential MCP POST requests during load
- Schema ingestion happening in browser (9 collections)
- No visible caching of schema data between navigations

---

### 8. Code Explorer 30-Second Timeout
**Severity:** High  
**Message:** `Project {id} did not become ready within 30000ms`

**Behavior:** Code tab shows this error on first load, but "Retry" button works. Suggests the project runtime isn't ready when the UI expects it.

---

## Medium Priority Issues (P2)

### 9. Chat Session ID Shared Incorrectly Between Projects
**Severity:** Medium  
**Observation:** When opening "My Feedback Form" project, the URL included:
```
?chatSessionId=e327af3f-636b-4764-8538-c9fc2a72f3c7
```
And the chat panel displayed content from a different project (Todo App template setup).

**Impact:** User sees wrong chat history when switching between projects.

---

### 10. HMR Disconnected State on Project Load
**Severity:** Medium  
**Observation:** When loading existing projects, preview shows "HMR Disconnected" before eventually connecting.

**Impact:** Brief disconnect indicator visible to users during loading.

---

### 11. `lost+found` Directory in Project Files
**Severity:** Low  
**Observation:** Project file explorer shows a `lost+found` directory.

**Impact:** This is a Linux filesystem recovery directory and shouldn't appear in project files. Indicates raw EBS volume or container filesystem issues.

---

## Console Warnings

### 12. Missing Dialog Accessibility
```
Warning: Missing `Description` or `aria-describedby={undefined}` for {DialogContent}.
```

### 13. Iframe Sandbox Warning
```
An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can...
```

---

## Network Request Analysis

### Successful Endpoints (200)
- `/api/auth/get-session`
- `/api/templates`
- `POST /mcp` (MCP server communication)
- `/api/projects/{id}/chat`

### Problematic Endpoints
| Endpoint | Status | Notes |
|----------|--------|-------|
| `/api/subdomains/*/check` | 500 | Consistent |
| `/api/projects/{id}/sandbox/url` | 503 → 200 | Eventually recovers |
| `/api/projects/{id}/files` | 502 → 200 | Eventually recovers |
| `/api/projects/{id}/terminal/commands` | 502 → 200 | Eventually recovers |
| `/api/projects/{id}/database/url` | 400 | When no Prisma schema |
| `/api/projects/{id}/runtime/stop` | 404 | Endpoint missing? |
| `/templates` (nginx) | 403 | Blocked |

---

## Recommendations

### Immediate (This Sprint)
1. **Fix API server accessibility** - Direct API access returns HTTP failure
2. **Fix /templates 403** - nginx is blocking this route
3. **Fix subdomain check 500s** - Critical for publishing

### Short-Term
4. **Fix race condition** - Ensure schemas are loaded before AuthGate queries
5. **Improve workspace cold start** - Reduce 502/503 errors during startup
6. **Fix chat session isolation** - Don't share session IDs across projects

### Performance Improvements
7. **Cache schema data** - Avoid re-fetching 9 collections on every page load
8. **Increase runtime timeout** - 30s timeout too aggressive for cold starts
9. **Add loading states** - Better UX during the inevitable delays

### Cleanup
10. **Remove lost+found from projects** - Filter this from file listings
11. **Fix database proxy font paths** - Serve static assets correctly

---

## Test Environment Details

- Browser: Playwright (Chromium)
- User: Template (test user)
- Projects tested: My Todo App, My Feedback Form
- Templates tested: Todo App

---

*Report generated from automated E2E testing session*
