---
name: platform-feature-tests
description: >
  Generate test specifications from implementation tasks. Use after
  platform-feature-spec when tasks have acceptance criteria and you need
  to define test cases. Transforms acceptance criteria into Given/When/Then
  test specifications. Invoke when ready to "create test specs", "define the
  tests", "generate test cases", or after spec handoff indicates status=testing.
---

# Platform Feature Tests

Transform implementation tasks into test specifications.

## Input

- `FeatureSession` with status="testing"
- `ImplementationTask` entities with acceptance criteria
- `Requirement` entities for traceability

## Output

- `TestSpecification` entities in Given/When/Then format
- Session status updated to "complete"

## Workflow

### Phase 1: Load Context

```javascript
schema.load("platform-features")
data.loadAll("platform-features")
session = store.list("FeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features", { session: session.id })
tasks = store.list("ImplementationTask", "platform-features", { session: session.id })
```

Present summary:
```
Session: {name}
Tasks: {count}
Total acceptance criteria: {count}

Ready to generate test specifications?
```

### Phase 2: Generate Test Specs

For each task, transform acceptance criteria into test specifications:

**Mock Service Test Patterns** - For Service/Hybrid features:

| Test Type | Given Setup | When/Then Pattern |
|-----------|-------------|-------------------|
| Success | MockService with default config | Action succeeds, state updated, mock.getCalls() verified |
| Failure | MockService with `simulateFailure: true` | Action fails, error returned, state rolled back |
| Edge case | MockService with specific config (e.g., `declineCardNumbers`) | Specific behavior triggered |

See [patterns/05-mock-service-testing.md](references/patterns/05-mock-service-testing.md) for mock structure and test setup.

**React Component Test Patterns** - For UI components:

| Test Type | Setup | Assertion Pattern |
|-----------|-------|-------------------|
| Loading state | Render with Provider | Loading indicator visible initially |
| Success state | Pre-seed mock data | `waitFor()` content visible |
| Error state | Mock with `simulateFailure: true` | Error message displayed |
| Interaction | Render with mock | Click action, verify mock.getCalls() |

See [patterns/07-react-context-integration.md](references/patterns/07-react-context-integration.md) for component testing patterns.

**Mapping heuristics**:
- Each acceptance criterion → 1+ test specs
- Success cases → unit tests
- Error cases → unit tests with error assertions
- Integration behavior → integration tests
- User flows → acceptance tests

```javascript
store.create("TestSpecification", "platform-features", {
  id: "test-xxx",
  task: "task-xxx",
  requirement: "req-xxx",  // from task.requirement
  scenario: "Brief description of what's being tested",
  given: ["Precondition 1", "Precondition 2"],
  when: "Action being tested",
  then: ["Expected outcome 1", "Expected outcome 2"],
  testType: "unit|integration|acceptance",
  targetFile: "path/to/test/file.test.ts",
  createdAt: Date.now()
})
```

### Phase 3: Coverage Review

After generating specs, verify coverage:

```
Test Coverage Summary

| Task | Criteria | Tests | Coverage |
|------|----------|-------|----------|
| task-001 | 4 | 4 | 100% |
| task-002 | 6 | 8 | 100% |
...

Test Types:
- Unit: {count}
- Integration: {count}
- Acceptance: {count}

Any gaps or additional tests needed?
```

### Phase 4: Handoff

1. Update session:
```javascript
store.update(session.id, "FeatureSession", "platform-features", {
  status: "complete",
  updatedAt: Date.now()
})
```

2. Present final summary:
```
Test Specifications Complete

Total tests: {count}
By type: {unit}, {integration}, {acceptance}

The platform feature is fully specified:
- Requirements: {count}
- Design decisions: {count}
- Analysis findings: {count}
- Integration points: {count}
- Implementation tasks: {count}
- Test specifications: {count}

Ready for implementation.
```

## Test Type Guidelines

| Type | When to Use | Given/When/Then Focus |
|------|-------------|----------------------|
| unit | Single function behavior | Isolated inputs → outputs |
| integration | Component interaction | Multiple components working together |
| acceptance | User-facing requirement | User action → observable result |

## Given/When/Then Patterns

**Unit test (function behavior)**:
```
Given: hashPassword function is available
When: hashPassword("mypassword") is called
Then: Returns a string starting with "$argon2"
Then: Result is different from input
```

**Unit test (error case)**:
```
Given: User with email "test@example.com" exists
When: auth.register is called with email "test@example.com"
Then: Returns error with message "Email already registered"
Then: No new User entity is created
```

**Integration test**:
```
Given: User is registered with email "test@example.com"
Given: User has valid refresh token
When: auth.refresh is called with the refresh token
Then: Returns new access token
Then: Access token contains correct userId
```

**Acceptance test**:
```
Given: User is on the login page
Given: User has a registered account
When: User enters valid credentials and submits
Then: User is redirected to home page
Then: Navigation shows logged-in state
```

## Target File Conventions

| Package | Test Location |
|---------|---------------|
| packages/mcp | src/tools/__tests__/{name}.test.ts |
| packages/state-api | src/{module}/__tests__/{name}.test.ts |
| apps/web | src/{component}/__tests__/{name}.test.tsx |

## References

- [test-patterns.md](references/test-patterns.md) - Common test patterns by component type
- [patterns/05-mock-service-testing.md](references/patterns/05-mock-service-testing.md) - Mock service implementation patterns
- [patterns/07-react-context-integration.md](references/patterns/07-react-context-integration.md) - React component testing patterns
