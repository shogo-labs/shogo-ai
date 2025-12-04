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

- `PlatformFeatureSession` with status="testing"
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
session = store.list("PlatformFeatureSession", "platform-features", { name: "..." })[0]
requirements = store.list("Requirement", "platform-features")

schema.load("platform-feature-spec")
data.loadAll("platform-feature-spec")
tasks = store.list("ImplementationTask", "platform-feature-spec")
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

**Mapping heuristics**:
- Each acceptance criterion → 1+ test specs
- Success cases → unit tests
- Error cases → unit tests with error assertions
- Integration behavior → integration tests
- User flows → acceptance tests

```javascript
store.create("TestSpecification", "platform-feature-spec", {
  id: "test-xxx",
  sessionId: session.id,
  task: "task-xxx",
  requirementId: "req-xxx",  // from task.requirementId
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
store.update(session.id, "PlatformFeatureSession", "platform-features", {
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
