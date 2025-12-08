# Tests: Test Specifications

The **Tests** skill transforms implementation tasks into Given/When/Then test specifications. These specifications drive the TDD cycle during implementation.

## Role in the Pipeline

```
Discovery → Analysis → Design → Spec → [TESTS] → Implementation
                                          │
                                          ▼
                               TestSpecification entities
                               (Given/When/Then format)
```

**Previous**: Spec creates implementation tasks with acceptance criteria  
**Next**: Implementation uses test specs for RED→GREEN TDD cycle

## When to Invoke

| Trigger | Session Status | Situation |
|---------|---------------|-----------|
| `/platform-feature-tests` | `testing` | After spec defines implementation tasks |
| "create test specs" | `testing` | Tasks have acceptance criteria |
| "define the tests" | `testing` | Ready to create testable specifications |

## Inputs

From **platform-features** schema:
- `PlatformFeatureSession` - Active session
- `Requirement` entities - Original requirements for traceability

From **platform-feature-spec** schema:
- `ImplementationTask` entities - Tasks with acceptance criteria

## What Tests Produces

| Output | Schema | Purpose |
|--------|--------|---------|
| `TestSpecification` entities | platform-feature-spec | Given/When/Then test cases |
| Updated session status | platform-features | Status → ready for implementation |

---

## TestSpecification Structure

Each test specification follows Given/When/Then format:

```javascript
{
  id: "test-001",
  sessionId: "session-auth",
  task: "task-domain-store",
  requirementId: "req-002",  // Traceability to original requirement
  scenario: "Session expiry check returns true for expired token",
  given: [
    "AuthSession entity with expiresAt in the past",
    "Session loaded in store"
  ],
  when: "session.isExpired is accessed",
  then: [
    "Returns true",
    "No side effects occur"
  ],
  testType: "unit",
  targetFile: "packages/state-api/src/auth/__tests__/domain.test.ts"
}
```

---

## Test Types

| Type | When to Use | Focus |
|------|-------------|-------|
| `unit` | Single function/method behavior | Isolated inputs → outputs |
| `integration` | Multiple components working together | Cross-boundary coordination |
| `acceptance` | User-facing feature validation | User action → observable result |

### Unit Test Example

Testing a single function in isolation:

```
Scenario: Password hashing produces valid argon2 hash

Given:
- hashPassword function is available
- Input password "mySecretPassword"

When:
- hashPassword("mySecretPassword") is called

Then:
- Returns string starting with "$argon2"
- Result is different from input
- Result length is greater than 50 characters
```

### Integration Test Example

Testing components working together:

```
Scenario: Auth store syncs session from service

Given:
- MockAuthService configured with test user
- Auth store created with mock service in environment
- store.initialize() called

When:
- authService returns session with user data

Then:
- store.isAuthenticated returns true
- store.currentUser matches service user
- store.currentSession has valid accessToken
```

### Acceptance Test Example

Testing user-facing behavior:

```
Scenario: User can sign in with valid credentials

Given:
- User is on the login page
- User has registered account (test@example.com)
- MockAuthService configured for success

When:
- User enters email "test@example.com"
- User enters password "validPassword"
- User clicks "Sign In" button

Then:
- Loading indicator appears during request
- Success redirects to dashboard
- Navigation shows authenticated state
```

---

## Test Patterns by Component

### Mock Service Tests

For features with service interfaces:

| Test Type | Given Setup | When/Then Pattern |
|-----------|-------------|-------------------|
| Success path | MockService with default config | Action succeeds, state updated |
| Failure path | MockService with `simulateFailure: true` | Error returned, state rolled back |
| Edge case | MockService with specific config | Specific behavior triggered |

Example specifications:

```
Scenario: Sign in succeeds with valid credentials
Given:
- MockAuthService configured
- No current session
When: signIn({ email: "test@example.com", password: "valid" }) called
Then:
- Returns AuthSession with accessToken
- store.isAuthenticated becomes true
- mock.getCalls("signIn") contains the credentials

---

Scenario: Sign in fails with invalid credentials
Given:
- MockAuthService with simulateFailure: true
- No current session
When: signIn({ email: "test@example.com", password: "wrong" }) called
Then:
- Throws error with message "Invalid credentials"
- store.isAuthenticated remains false
- store.authError contains error message
```

### Domain Store Tests

For MST domain stores:

| Test Focus | What to Verify |
|------------|----------------|
| Entity creation | Collection contains entity with correct fields |
| References | Reference fields resolve to entity instances |
| Computed views | Views derive correct values from state |
| Actions | Actions modify state correctly |
| Service integration | getEnv() retrieves service, actions delegate |

Example specifications:

```
Scenario: AuthSession.isExpired returns true for past expiry
Given:
- AuthSession entity with expiresAt "2024-01-01T00:00:00Z"
- Current time is after expiresAt
When: session.isExpired is accessed
Then: Returns true

---

Scenario: AuthSession.userId resolves to AuthUser entity
Given:
- AuthUser entity with id "user-123"
- AuthSession entity with userId referencing "user-123"
When: session.userId is accessed
Then:
- Returns AuthUser instance (not string)
- Returned user.id equals "user-123"
- Returned user.email is accessible
```

### React Component Tests

For React providers and components:

| Test Focus | Setup | Assertion Pattern |
|------------|-------|-------------------|
| Loading state | Render with Provider | Loading indicator visible initially |
| Success state | Pre-seed mock data | `waitFor()` content visible |
| Error state | Mock with failure | Error message displayed |
| Interactions | Render with mock | Click action, verify calls |

Example specifications:

```
Scenario: useAuth throws when used outside provider
Given:
- Component using useAuth hook
- Component NOT wrapped in AuthProvider
When: Component renders
Then:
- Throws error "useAuth must be used within AuthProvider"

---

Scenario: AuthProvider initializes session on mount
Given:
- MockAuthService with existing session
- Component wrapped in AuthProvider
When: Component mounts
Then:
- authService.getSession() is called
- store.isAuthenticated becomes true after initialization
```

---

## Workflow

### Phase 1: Load Context

```
Session: auth-layer
Status: testing
Tasks: 7
Total acceptance criteria: 24

Ready to generate test specifications?
```

### Phase 2: Generate Test Specs

For each task, acceptance criteria are transformed:

```
Task: Create auth domain store
Acceptance Criteria: 6

Generated Tests:
1. [unit] AuthDomain scope exports AuthUser and AuthSession types
2. [unit] AuthSession.isExpired returns true for past expiry
3. [unit] AuthSession.isExpired returns false for future expiry
4. [unit] AuthSession.userId resolves to AuthUser entity
5. [integration] signIn action delegates to auth service
6. [integration] initialize action loads existing session
```

### Phase 3: Coverage Review

```
Test Coverage Summary

| Task | Criteria | Tests | Coverage |
|------|----------|-------|----------|
| task-001 | 2 | 2 | 100% |
| task-002 | 4 | 6 | 100% |
| task-003 | 4 | 5 | 100% |
| task-004 | 4 | 5 | 100% |
| task-005 | 2 | 2 | 100% |
| task-006 | 6 | 8 | 100% |
| task-007 | 4 | 5 | 100% |

Test Types:
- Unit: 22
- Integration: 8
- Acceptance: 3

Total: 33 test specifications
```

### Phase 4: Handoff

```
Test Specifications Complete

Total tests: 33
By type: 22 unit, 8 integration, 3 acceptance

The platform feature is fully specified:
- Requirements: 4
- Design decisions: 3
- Analysis findings: 6
- Integration points: 8
- Implementation tasks: 7
- Test specifications: 33

Ready for implementation.
```

---

## Target File Conventions

| Package | Test Location |
|---------|---------------|
| packages/state-api | `src/{module}/__tests__/{name}.test.ts` |
| packages/mcp | `src/tools/__tests__/{name}.test.ts` |
| apps/web | `src/{component}/__tests__/{name}.test.tsx` |

---

## Mapping Acceptance Criteria to Tests

| Criterion Pattern | Test Approach |
|-------------------|---------------|
| "Returns X when Y" | Unit test with specific input |
| "Throws error when Z" | Unit test expecting exception |
| "Integrates with service" | Integration test with mock |
| "User can perform action" | Acceptance test with component |
| "State updates correctly" | Unit or integration test |

Multiple tests may cover one criterion (success + failure cases).

---

## Auth Example Output

For auth feature, tests skill produced 33 specifications:

| Task | Tests |
|------|-------|
| Dependencies task | 2 (package.json validation) |
| Types interface | 6 (interface structure, method signatures) |
| Supabase service | 5 (delegation, error handling) |
| Mock service | 5 (configurable behavior, call tracking) |
| Environment extension | 2 (type safety, access pattern) |
| Domain store | 8 (views, actions, references, service integration) |
| React context | 5 (provider lifecycle, hook behavior, state sync) |

Each test has explicit Given/When/Then structure and target file path.

---

## What to Look For

**Good test specifications**:
- Every acceptance criterion has corresponding test(s)
- Given conditions are specific and reproducible
- When actions are single, clear operations
- Then assertions are verifiable
- Test types match the scope being tested

**Warning signs**:
- Vague given conditions ("system is set up")
- Multiple actions in When clause
- Assertions that can't be programmatically verified
- Missing error case coverage
- All tests marked as "unit" (integration gaps)

---

## Next Step

With test specifications complete:

→ **Proceed to [Implementation](implementation.md)** to execute TDD cycle

The implementation skill uses these specifications to write failing tests first, then implementation code to make them pass.
