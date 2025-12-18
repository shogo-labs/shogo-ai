# Pattern 8: Browser Verification with Chrome DevTools MCP

> Validate proof-of-work demo pages using automated browser testing, live debugging, and performance profiling.

## Concept

After TDD completes (tests pass, typecheck clean, build succeeds), proof-of-work pages require browser-based verification to confirm:

1. Page renders without JavaScript errors
2. Real services/persistence are connected (not mocks)
3. User interactions work as expected
4. Performance meets acceptable thresholds

Chrome DevTools MCP provides 26 tools across 6 categories for comprehensive browser validation.

---

## When to Apply

This pattern applies during Phase 5 (Integration Verification) after:
- [x] Unit tests pass (`bun test`)
- [x] Type check passes (`bun run typecheck`)
- [x] Build succeeds (`bun run build`)

Apply when the feature has a proof-of-work demo page that requires validation.

---

## Available Tools by Category

### Input Tools (8)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `click` | Click elements | Button clicks, navigation, checkboxes |
| `fill` | Fill single input field | Text inputs, search fields |
| `fill_form` | Fill multiple form fields | Complex forms with multiple inputs |
| `hover` | Hover over elements | Tooltips, dropdown menus |
| `press_key` | Keyboard input | Shortcuts, Enter key, Escape |
| `drag` | Drag and drop | Sortable lists, drag-to-upload |
| `upload_file` | File upload | File input testing |
| `handle_dialog` | Handle alerts/confirms/prompts | Modal interactions |

### Navigation Tools (6)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `navigate_page` | Navigate to URL | Initial page load, refresh |
| `new_page` | Open new tab | Multi-tab testing |
| `close_page` | Close tab | Cleanup after tests |
| `select_page` | Switch between tabs | Multi-tab workflows |
| `list_pages` | List open pages | Debugging, verification |
| `wait_for` | Wait for element/condition | Async operations, loading states |

### Debugging Tools (5)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `take_screenshot` | Capture page state | Visual verification, error documentation |
| `take_snapshot` | DOM snapshot | Structure verification |
| `evaluate_script` | Run JavaScript | Custom assertions, state inspection |
| `list_console_messages` | Get all console output | Error detection, warning review |
| `get_console_message` | Get specific message | Targeted debugging |

### Performance Tools (3)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `performance_start_trace` | Start profiling | Performance testing |
| `performance_stop_trace` | Stop profiling | Performance testing |
| `performance_analyze_insight` | Analyze trace | Identify performance issues |

### Network Tools (2)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `list_network_requests` | List all requests | API verification, mock detection |
| `get_network_request` | Get request details | Specific request inspection |

### Emulation Tools (2)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `emulate` | Device emulation | Responsive design testing |
| `resize_page` | Change viewport | Layout testing at different sizes |

---

## Browser Verification Workflow

### Phase 1: Start Dev Server

Before browser testing, start the development server:

```bash
# Start dev server in background
cd apps/web && bun run dev &

# Wait for server to be ready
# Default URL: http://localhost:5173
```

### Phase 2: Basic Render Verification

**Goal**: Confirm page loads without critical errors.

```
1. navigate_page -> http://localhost:5173/{demo-page-path}
2. wait_for -> Main content element visible (e.g., [data-testid="demo-container"])
3. list_console_messages -> Check for errors
4. take_screenshot -> Visual baseline
```

**Expected**:
- No JavaScript errors in console
- No unhandled promise rejections
- Main UI elements visible

### Phase 3: Service Verification

**Goal**: Confirm real services are connected (not mocks).

**For External Service Features:**
```
1. evaluate_script -> Check service type is not MockService
   Example: "window.__services?.auth?.constructor?.name !== 'MockAuthService'"
2. list_network_requests -> Verify real API calls to production endpoints
3. Click action that triggers service call
4. Verify network request goes to real endpoint (not localhost mock)
```

**For Internal Domain Features:**
```
1. evaluate_script -> Check persistence type is not NullPersistence
   Example: "window.__persistence?.constructor?.name !== 'NullPersistence'"
2. Create entity via UI (click + fill_form)
3. navigate_page to same URL (refresh)
4. wait_for -> Verify entity persists after refresh
```

### Phase 4: Interaction Testing

**Goal**: Verify core user flows work.

```
# Example: Create entity flow
1. click -> "Create" button
2. wait_for -> Form modal visible
3. fill_form -> { name: "Test Entity", description: "..." }
4. click -> "Save" button
5. wait_for -> Success indicator or new item in list
6. list_console_messages -> No new errors during flow
```

### Phase 5: Performance Verification (Optional)

**Goal**: Ensure acceptable load times.

```
1. performance_start_trace
2. navigate_page -> demo page URL
3. wait_for -> Page fully loaded
4. performance_stop_trace
5. performance_analyze_insight -> Check for issues
```

**Acceptable thresholds**:
- First Contentful Paint: < 2s
- Largest Contentful Paint: < 4s
- No long tasks > 50ms blocking main thread

### Phase 6: Production Build Verification (Optional)

**Goal**: Catch build-only issues.

```bash
bun run build && bun run preview
```

Then repeat Phases 2-4 against `http://localhost:4173/{demo-page-path}`.

---

## Test Target Priority

1. **Localhost dev server first** (`http://localhost:5173`)
   - Fast feedback loop
   - Easy debugging with HMR
   - Quick iteration on fixes

2. **Production build if dev passes** (`http://localhost:4173`)
   - Catches minification issues
   - Catches missing environment variables in build
   - Verifies production-like behavior

---

## Error Handling

### Console Error Detected

```
If list_console_messages returns errors:
1. Capture screenshot for context
2. Identify error source (React, MST, service call)
3. Report issue with:
   - Error message text
   - Screenshot showing page state
   - Suggested fix location
4. Do NOT mark proof-of-work as complete
```

### Network Request Failure

```
If critical API calls fail:
1. get_network_request -> Inspect failed request
2. Check response status code and body
3. Verify credentials/configuration in env vars
4. Report with request/response details
```

### Element Not Found

```
If wait_for times out:
1. take_screenshot -> Current page state
2. take_snapshot -> DOM structure
3. Check if selector is correct
4. Report with visual evidence
```

### Service Mock Detected

```
If evaluate_script shows MockService or NullPersistence:
1. Verify environment configuration
2. Check DomainProvider service injection
3. Ensure VITE_* env vars are set
4. Report configuration issue
```

---

## Feature Type Verification Matrix

| Feature Type | Must Verify | Tools to Use |
|--------------|-------------|--------------|
| External Service | Real API calls made | `list_network_requests`, `get_network_request` |
| External Service | Real credentials used | `evaluate_script` (check env vars loaded) |
| External Service | Not MockService | `evaluate_script` (check constructor name) |
| Internal Domain | Real persistence | `evaluate_script` (check not NullPersistence) |
| Internal Domain | CRUD round-trip | `click`, `fill`, `wait_for`, refresh test |
| Internal Domain | Data survives refresh | `navigate_page` to same URL, verify data |
| UI Component | Renders correctly | `take_screenshot`, `wait_for` |
| UI Component | Interactions work | `click`, `hover`, `fill`, `wait_for` |
| Performance | Load time acceptable | `performance_*` tools |

---

## Common Verification Scripts

### Check for React Errors

```javascript
// evaluate_script
const errors = Array.from(document.querySelectorAll('[data-reactroot]'))
  .some(el => el.textContent.includes('Error'));
return !errors;
```

### Verify MST Store Initialized

```javascript
// evaluate_script
return typeof window.__mst_store !== 'undefined' &&
       window.__mst_store !== null;
```

### Check Service Type

```javascript
// evaluate_script - External service
const service = window.__services?.myService;
return service && service.constructor.name !== 'MockMyService';
```

### Check Persistence Type

```javascript
// evaluate_script - Internal domain
const persistence = window.__domains?.myDomain?.persistence;
return persistence && persistence.constructor.name !== 'NullPersistence';
```

### Count Entities in Collection

```javascript
// evaluate_script
const store = window.__domains?.myDomain?.store;
return store?.myCollection?.length || 0;
```

---

## Checklist

Before marking proof-of-work complete:

- [ ] Dev server started and accessible
- [ ] Page renders without JavaScript errors
- [ ] No unhandled promise rejections in console
- [ ] Real services connected (not mocks)
- [ ] Real persistence used (not NullPersistence)
- [ ] Core user flow works (create/read/update/delete as applicable)
- [ ] Data persists across page refresh
- [ ] No console warnings about missing dependencies
- [ ] Screenshot captured for documentation
- [ ] (Optional) Performance within acceptable thresholds
- [ ] (Optional) Production build verification passed

---

## Anti-Patterns

### Not Waiting for Async Operations

```
# BAD: Click then immediately check
click -> "Save"
evaluate_script -> "document.querySelector('.success')"  # May not exist yet!

# GOOD: Wait for result
click -> "Save"
wait_for -> ".success" selector visible OR network request completes
evaluate_script -> verify state
```

### Testing Mock Services

```
# BAD: MockService passes but doesn't prove integration
evaluate_script -> "window.service instanceof MockService"  # Should be FALSE!

# GOOD: Verify real service
list_network_requests -> Should show calls to real API endpoints
evaluate_script -> "service.constructor.name !== 'MockService'"
```

### Skipping Refresh Test for Persistence

```
# BAD: Only test in-memory state
fill -> entity data
click -> "Save"
# Assume it worked - WRONG!

# GOOD: Verify persistence
fill -> entity data
click -> "Save"
wait_for -> success indicator
navigate_page -> same URL (triggers full refresh)
wait_for -> entity still visible in list
```

### Not Capturing Evidence on Failure

```
# BAD: Just report "test failed"
# No context, hard to debug

# GOOD: Full evidence
take_screenshot -> current page state
list_console_messages -> all errors/warnings
take_snapshot -> DOM structure
# Then report with all evidence attached
```

### Testing Only Happy Path

```
# BAD: Only test successful flows
fill -> valid data
click -> "Save"
# Done!

# GOOD: Include error states
# Test 1: Valid data succeeds
# Test 2: Invalid data shows error message
# Test 3: Network failure handled gracefully
```

---

## Example Verification Session

```
# 1. Start verification
navigate_page -> http://localhost:5173/teams-demo
wait_for -> [data-testid="teams-container"]
list_console_messages -> (check for errors)
take_screenshot -> "01-initial-load.png"

# 2. Verify persistence is real
evaluate_script -> "window.__domains?.teams?.persistence?.constructor?.name"
# Expected: "MCPPersistence" (NOT "NullPersistence")

# 3. Create entity
click -> [data-testid="create-team-button"]
wait_for -> [data-testid="team-form"]
fill_form -> { name: "Test Team", description: "Browser verification test" }
click -> [data-testid="save-button"]
wait_for -> [data-testid="team-item"]
take_screenshot -> "02-entity-created.png"

# 4. Verify persistence (refresh test)
navigate_page -> http://localhost:5173/teams-demo
wait_for -> [data-testid="teams-container"]
wait_for -> text "Test Team" visible
take_screenshot -> "03-after-refresh.png"

# 5. Check no errors
list_console_messages -> (verify no new errors)

# PASS: All checks succeeded
```
