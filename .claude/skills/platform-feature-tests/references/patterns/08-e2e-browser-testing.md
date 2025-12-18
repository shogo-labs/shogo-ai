# Pattern 8: E2E Browser Testing

> Generate E2E test specifications for browser-based proof-of-work verification using Chrome DevTools MCP.

## Concept

E2E browser tests verify the complete integration:
- UI renders correctly in a real browser
- User interactions work as expected
- Services/persistence are real (not mocks)
- Performance is acceptable

Unlike unit/integration tests that generate `.test.ts` files, E2E specs guide browser verification using Chrome DevTools MCP tools during implementation Phase 5.

---

## When to Apply

Generate E2E test specs when:

- [ ] Feature has a proof-of-work demo page
- [ ] Acceptance criteria mention "user can..." or "page shows..."
- [ ] Integration requires real services/persistence verification
- [ ] Visual or interactive validation needed

---

## E2E Test Spec Structure

```javascript
{
  id: "test-e2e-{feature}-{sequence}",
  task: "task-xxx",              // Implementation task this validates
  requirement: "req-xxx",        // Traced to requirement
  scenario: "Descriptive scenario name",
  given: [
    "Environment preconditions",
    "Page/navigation state"
  ],
  when: "User action or trigger",
  then: [
    "Observable outcome 1",
    "Observable outcome 2"
  ],
  testType: "e2e",
  targetFile: null,              // No test file - uses browser tools
  browserTools: ["tool1", "tool2"],  // Chrome DevTools MCP tools needed
  createdAt: Date.now()
}
```

**Key Fields:**
- `testType: "e2e"` - Distinguishes from unit/integration tests
- `targetFile: null` - No test file is generated
- `browserTools: []` - Lists the Chrome DevTools MCP tools required

---

## Given/When/Then Translation for E2E

### Given → Browser State Setup

| Given Statement | Browser Tool | Example |
|-----------------|--------------|---------|
| "Dev server running" | Pre-requisite (manual) | N/A |
| "User on page X" | `navigate_page` | `navigate_page -> http://localhost:5173/teams` |
| "Page loaded" | `wait_for` | `wait_for -> [data-testid="page-container"]` |
| "Form visible" | `wait_for` | `wait_for -> [data-testid="create-form"]` |
| "User logged in" | Prior `fill` + `click` | Login flow first |
| "Entity exists" | Prior create flow | Create entity first |

### When → User Action

| When Statement | Browser Tool | Example |
|----------------|--------------|---------|
| "User clicks button" | `click` | `click -> [data-testid="save-button"]` |
| "User fills form" | `fill` or `fill_form` | `fill_form -> { name: "Test" }` |
| "User types in input" | `fill` | `fill -> [name="email"], "test@example.com"` |
| "User hovers element" | `hover` | `hover -> [data-testid="tooltip-trigger"]` |
| "User presses key" | `press_key` | `press_key -> "Enter"` |
| "User uploads file" | `upload_file` | `upload_file -> [type="file"], "/path/to/file"` |
| "User drags item" | `drag` | `drag -> from, to` |
| "User dismisses dialog" | `handle_dialog` | `handle_dialog -> accept` |

### Then → Verification

| Then Statement | Browser Tool | Example |
|----------------|--------------|---------|
| "Element visible" | `wait_for` | `wait_for -> [data-testid="success-message"]` |
| "Text appears" | `wait_for` + `evaluate_script` | Check text content |
| "No console errors" | `list_console_messages` | Filter for errors |
| "Data persists" | `navigate_page` (refresh) + `wait_for` | Reload and verify |
| "API called" | `list_network_requests` | Check for request |
| "Real service used" | `evaluate_script` | Check service type |
| "Screenshot matches" | `take_screenshot` | Visual comparison |
| "Performance OK" | `performance_analyze_insight` | Check metrics |

---

## Example E2E Specs by Feature Type

### Internal Domain Feature (Teams Management)

**Scenario**: User creates new team

```javascript
{
  id: "test-e2e-teams-001",
  task: "task-006",
  requirement: "req-002",
  scenario: "User creates new team via demo page",
  given: [
    "Dev server running at localhost:5173",
    "User navigated to /teams-demo",
    "Organization already exists in store"
  ],
  when: "User fills team name and clicks Create button",
  then: [
    "New team appears in hierarchy list",
    "Team persists after page refresh",
    "No console errors during flow"
  ],
  testType: "e2e",
  targetFile: null,
  browserTools: ["navigate_page", "wait_for", "fill", "click", "list_console_messages"],
  createdAt: Date.now()
}
```

**Verification sequence:**
```
navigate_page -> http://localhost:5173/teams-demo
wait_for -> [data-testid="teams-container"]
click -> [data-testid="create-team-button"]
wait_for -> [data-testid="team-form"]
fill -> [name="teamName"], "Engineering"
click -> [data-testid="save-button"]
wait_for -> text "Engineering" in list
list_console_messages -> (no errors)
navigate_page -> http://localhost:5173/teams-demo (refresh)
wait_for -> text "Engineering" still visible
```

### External Service Feature (Auth)

**Scenario**: User signs up with real authentication service

```javascript
{
  id: "test-e2e-auth-001",
  task: "task-003",
  requirement: "req-001",
  scenario: "User signs up with real Supabase auth",
  given: [
    "Dev server running with VITE_SUPABASE_URL configured",
    "User navigated to /auth-demo"
  ],
  when: "User enters email/password and clicks Sign Up",
  then: [
    "Network request to supabase.co observed",
    "Success message displayed",
    "User session persists after refresh"
  ],
  testType: "e2e",
  targetFile: null,
  browserTools: ["navigate_page", "fill_form", "click", "list_network_requests", "wait_for", "evaluate_script"],
  createdAt: Date.now()
}
```

**Verification sequence:**
```
navigate_page -> http://localhost:5173/auth-demo
wait_for -> [data-testid="auth-form"]
evaluate_script -> "window.__services?.auth?.constructor?.name !== 'MockAuthService'"
fill_form -> { email: "test@example.com", password: "password123" }
click -> [data-testid="signup-button"]
list_network_requests -> (check for supabase.co request)
wait_for -> [data-testid="success-message"]
```

### Performance-Critical Feature

**Scenario**: Dashboard loads within performance budget

```javascript
{
  id: "test-e2e-dashboard-perf-001",
  task: "task-010",
  requirement: "req-nfr-001",
  scenario: "Dashboard loads within 2 second performance budget",
  given: [
    "Dev server running",
    "Performance trace started"
  ],
  when: "User navigates to /dashboard",
  then: [
    "First Contentful Paint < 2s",
    "No long tasks blocking main thread > 50ms",
    "All above-fold content visible within 2s"
  ],
  testType: "e2e",
  targetFile: null,
  browserTools: ["performance_start_trace", "navigate_page", "wait_for", "performance_stop_trace", "performance_analyze_insight"],
  createdAt: Date.now()
}
```

**Verification sequence:**
```
performance_start_trace
navigate_page -> http://localhost:5173/dashboard
wait_for -> [data-testid="dashboard-loaded"]
performance_stop_trace
performance_analyze_insight -> FCP < 2000ms, no long tasks
```

### Error Handling Feature

**Scenario**: Error state displays correctly on service failure

```javascript
{
  id: "test-e2e-error-001",
  task: "task-008",
  requirement: "req-003",
  scenario: "Error state displays when service fails",
  given: [
    "Dev server running",
    "Network disconnected or service unavailable"
  ],
  when: "User triggers action that calls failing service",
  then: [
    "Error message displayed to user",
    "No unhandled exceptions in console",
    "Retry button available"
  ],
  testType: "e2e",
  targetFile: null,
  browserTools: ["navigate_page", "wait_for", "click", "list_console_messages", "take_screenshot"],
  createdAt: Date.now()
}
```

---

## Coverage Guidance

For each proof-of-work demo page, ensure E2E specs cover:

| Category | Minimum Coverage | Required |
|----------|------------------|----------|
| Render | Page loads without errors | Yes |
| Service | Real service verified (not mock) | Yes |
| Persistence | Data survives refresh | Yes |
| Core Flow | Primary user action works | Yes |
| Error Handling | Error states display correctly | Recommended |
| Performance | Load time acceptable | Optional |

---

## E2E Spec Checklist

When creating E2E test specifications:

- [ ] `testType` is `"e2e"` (not unit/integration)
- [ ] `targetFile` is `null` (no test file generated)
- [ ] `browserTools` array lists all required Chrome DevTools MCP tools
- [ ] `scenario` clearly describes observable behavior
- [ ] `given` includes page/navigation preconditions
- [ ] `when` describes a single user action
- [ ] `then` describes observable outcomes (not implementation details)
- [ ] Each proof-of-work page has at least one E2E spec
- [ ] Persistence verification includes refresh test

---

## Relationship to Other Test Types

| Test Type | What It Validates | Generated File | Execution |
|-----------|-------------------|----------------|-----------|
| Unit | Function behavior | `*.test.ts` | `bun test` |
| Integration | Component interaction | `*.test.ts` | `bun test` |
| Acceptance | User requirement | `*.test.ts` | `bun test` |
| **E2E** | Full browser integration | None | Chrome DevTools MCP |

E2E specs complement (not replace) other test types:
- Unit/integration tests run fast and catch regressions
- E2E specs verify the complete integration works in a real browser

---

## Anti-Patterns

### Generating Test Files for E2E Specs

```javascript
// WRONG: E2E specs don't generate test files
{
  testType: "e2e",
  targetFile: "src/pages/__tests__/demo.e2e.test.ts"  // Should be null!
}

// CORRECT: E2E specs use browser tools
{
  testType: "e2e",
  targetFile: null,
  browserTools: ["navigate_page", "click", "wait_for"]
}
```

### Missing browserTools Field

```javascript
// WRONG: No indication of what tools are needed
{
  testType: "e2e",
  targetFile: null
  // browserTools missing!
}

// CORRECT: Tools explicitly listed
{
  testType: "e2e",
  targetFile: null,
  browserTools: ["navigate_page", "fill_form", "click", "wait_for"]
}
```

### Testing Implementation Details

```javascript
// WRONG: Given/When/Then describe implementation
{
  given: ["MST store initialized", "Collection has observer"],
  when: "collection.insertOne() called",
  then: ["Observer fires", "Entity added to internal array"]
}

// CORRECT: Given/When/Then describe user-observable behavior
{
  given: ["User on teams page", "Page loaded"],
  when: "User clicks Create and fills form",
  then: ["New team appears in list", "Team persists after refresh"]
}
```
