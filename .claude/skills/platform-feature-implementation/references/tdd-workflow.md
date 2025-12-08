# TDD Workflow Reference

Detailed guide for the RED → GREEN cycle.

## The Cycle

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   1. RED                                                │
│      Write test that fails                              │
│      └─ Verifies test is meaningful                     │
│                                                         │
│   2. GREEN                                              │
│      Write minimal code to pass                         │
│      └─ Focus on making test pass, not perfection       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Phase 1: RED

### Goal
Write a failing test that defines the expected behavior.

### Steps

1. **Read TestSpecification** from Wavesmith:
   ```javascript
   testSpec = store.get(testSpecId, "TestSpecification", "platform-feature-spec")
   ```

2. **Generate test file** at `targetFile` location:
   - Import test framework (`bun:test`)
   - Import module being tested (will fail initially - that's expected)
   - Translate Given/When/Then to test structure

3. **Run test** to verify it fails:
   ```bash
   bun test {targetFile}
   ```

4. **Verify failure is meaningful**:
   - Should fail because code doesn't exist or doesn't implement behavior
   - NOT because of syntax errors or missing imports (fix these first)

### Expected Output
```
FAIL  src/auth/__tests__/auth-service.test.ts
  ✗ signup with valid credentials -> returns user (1ms)
    Error: Cannot find module '../types' from 'src/auth/__tests__/auth-service.test.ts'
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Import error before test runs | Create minimal stub file with exports |
| Test passes unexpectedly | Test may be wrong, or code already exists |
| Syntax error in test | Fix test code before proceeding |

## Phase 2: GREEN

### Goal
Write the minimum code to make the test pass.

### Steps

1. **Implement only what's needed**:
   - Don't over-engineer
   - Don't add features beyond what test requires
   - Follow existing patterns from analysis findings

2. **Run test** to verify it passes:
   ```bash
   bun test {targetFile}
   ```

3. **If test fails, iterate**:
   - Read error message carefully
   - Make targeted fix
   - Re-run test
   - Max 3 attempts before marking blocked

### Expected Output
```
PASS  src/auth/__tests__/auth-service.test.ts
  ✓ signup with valid credentials -> returns user (5ms)

Test Files: 1 passed
Tests:      1 passed
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Test still fails after 3 attempts | Mark task blocked, skip to next |
| Test passes but behavior wrong | Test spec may be incomplete |
| Side effects in tests | Ensure proper test isolation |

## Handling Failures

### Test Won't Pass (3 attempts)

1. Update TaskExecution:
   ```javascript
   store.update(execId, "TaskExecution", "platform-feature-spec", {
     status: "failed",
     errorMessage: "Test failed after 3 attempts: {error}",
     retryCount: 3
   })
   ```

2. Mark task blocked:
   ```javascript
   store.update(taskId, "ImplementationTask", "platform-feature-spec", {
     status: "blocked"
   })
   ```

3. Add to failed tasks in run:
   ```javascript
   run.failedTasks.push(taskId)
   ```

4. Skip to next task (if no dependency)

### Dependency Blocked

If task-A is blocked and task-B depends on task-A:
- Automatically skip task-B
- Log: "Skipping task-B: depends on blocked task-A"

### Build/TypeCheck Failure

After GREEN but before COMMIT:
1. Run `bun run typecheck`
2. If fails, fix type errors
3. Run `bun run build`
4. If fails, analyze and fix
5. Only commit after both pass

## Retry Strategies

| Attempt | Strategy |
|---------|----------|
| 1 | Direct implementation from spec |
| 2 | Review patterns, try different approach |
| 3 | Simplify implementation, check assumptions |
| Blocked | Mark blocked, document issue, move on |

## Task Completion

After GREEN, update records:
```javascript
store.update(execId, "TaskExecution", "platform-feature-spec", {
  status: "test_passing",
  completedAt: Date.now()
})

store.update(task.id, "ImplementationTask", "platform-feature-spec", {
  status: "complete",
  updatedAt: Date.now()
})
```

## Test Isolation

Each test should:
- Set up own fixtures in `beforeEach`
- Clean up in `afterEach` if needed
- Not depend on other tests
- Not depend on external state

```typescript
describe("AuthService", () => {
  let mockService: MockAuthService

  beforeEach(() => {
    mockService = new MockAuthService()
    mockService.clear() // Reset state
  })

  test("...", () => {
    // Test uses fresh mockService
  })
})
```
