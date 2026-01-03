# Implementation: TDD Execution

The **Implementation** skill executes the TDD cycle—writing failing tests, implementing code, and verifying passing tests. This is where specifications become working code.

## Role in the Pipeline

```
Discovery → Analysis → Design → Spec → Tests → [IMPLEMENTATION]
                                                      │
                                                      ▼
                                            Actual code files
                                            (types, services, stores, tests)
```

**Previous**: Tests creates Given/When/Then specifications  
**Output**: Working, tested code committed to the codebase

## When to Invoke

| Trigger | Session Status | Situation |
|---------|---------------|-----------|
| `/platform-feature-implementation` | `testing` or `implementation` | Tasks and test specs ready |
| "implement the feature" | `testing` | Full specifications complete |
| "start implementing" | `testing` | Ready for TDD execution |
| "run TDD" | `testing` | Execute RED→GREEN cycle |

## Inputs

From **platform-features** schema:
- `PlatformFeatureSession` - Active session
- `DesignDecision` entities - Enhancement hooks to implement

From **platform-feature-spec** schema:
- `ImplementationTask` entities - Ordered work items
- `TestSpecification` entities - Given/When/Then test cases
- `IntegrationPoint` entities - File locations for changes
- `AnalysisFinding` entities - Patterns to follow, risks to watch

---

## The TDD Cycle

For **every task with test specifications**, the cycle is mandatory:

```
┌─────────────────────────────────────────────────────────┐
│                    Per-Task TDD Cycle                    │
├──────────┬──────────┬──────────┬──────────┬────────────┤
│  WRITE   │   RUN    │  VERIFY  │IMPLEMENT │   VERIFY   │
│  tests   │  tests   │   RED    │   code   │   GREEN    │
├──────────┼──────────┼──────────┼──────────┼────────────┤
│ Generate │ Execute  │ Confirm  │  Write   │  Confirm   │
│ from     │ bun test │ tests    │ actual   │ all tests  │
│ specs    │          │ fail     │ code     │ pass       │
└──────────┴──────────┴──────────┴──────────┴────────────┘
```

**This is not optional.** Every step must occur in order.

| Step | Action | Validation | Cannot Skip |
|------|--------|------------|-------------|
| 1 | Write test file from specs | File exists | ❌ |
| 2 | Run tests | `bun test {file}` executes | ❌ |
| 3 | Verify RED | Tests fail as expected | ❌ |
| 4 | Implement code | Code written to files | ❌ |
| 5 | Run tests again | `bun test {file}` executes | ❌ |
| 6 | Verify GREEN | All tests pass | ❌ |
| 7 | Mark complete | Task status updated | ❌ |

**Exception**: Tasks with no TestSpecifications (e.g., "add dependencies") can skip steps 1-3, 5-6.

---

## Anti-Pattern: Batch Processing

```
❌ WRONG:
  Write test-001, test-002, test-003
  Implement task-001, task-002, task-003
  Run all tests at end

✅ CORRECT (per task):
  Write test-001 → Run (RED) → Implement → Run (GREEN) → Complete
  Write test-002 → Run (RED) → Implement → Run (GREEN) → Complete
  Write test-003 → Run (RED) → Implement → Run (GREEN) → Complete
```

The TDD cycle provides immediate feedback. Batching defeats the purpose.

---

## Implementation Workflow

### Phase 1: Load Context

```
Session: auth-layer
Status: testing

Tasks: 7 (0 complete, 0 in progress, 7 pending)
Test Specs: 33
Integration Points: 8

Key patterns from analysis:
- Service interface pattern with IEnvironment injection
- Enhancement hooks via createStoreFromScope
- React context with useRef for stable store

Risks identified:
- Token storage security requires careful handling

Ready to begin implementation?
```

### Phase 2: Pre-Implementation Verification

Before starting, the skill checks:

1. **Existing run**: Can resume from previous progress
2. **Analysis freshness**: Findings not stale (>7 days warning)
3. **Integration point validity**: Files still exist where expected

```
Analysis Verification:
- Findings age: 2 days
- Integration points: 8/8 valid

Proceeding with implementation...
```

If resuming:
```
Found existing implementation run from 2 days ago.
Completed: 3/7 tasks
Last task: Create MockAuthService

Options:
1. Resume from where we left off
2. Restart from beginning (discards progress)

Which approach?
```

### Phase 3: Task Ordering

Tasks are sorted by dependency (topological sort):

```
Execution Order (dependency-sorted):

Level 0 (no dependencies):
  [task-001] Add auth dependencies
  [task-002] Create IAuthService interface

Level 1:
  [task-003] Implement SupabaseAuthService (depends: task-002)
  [task-004] Implement MockAuthService (depends: task-002)
  [task-005] Extend IEnvironment (depends: task-002)

Level 2:
  [task-006] Create auth domain store (depends: task-002, task-005)

Level 3:
  [task-007] Create AuthProvider (depends: task-006)

Total: 7 tasks across 4 dependency levels

Proceed with implementation?
```

### Phase 4: TDD Loop (Per Task)

For each task in dependency order:

#### 4.1 Task Setup

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: Create auth domain store
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Integration Point: packages/state-api/src/auth/domain.ts
Change Type: add

Acceptance Criteria:
- domain.ts exports AuthDomain ArkType scope
- domain.ts exports createAuthStore() factory
- enhanceModels adds: AuthSession.isExpired
- enhanceRootStore adds: initialize, signIn, signOut

Test Specifications (8):
- test-014: AuthSession.isExpired returns true for past expiry
- test-015: AuthSession.isExpired returns false for future expiry
- test-016: signIn action delegates to auth service
- ...
```

#### 4.2 RED Phase: Write Tests

Tests generated from specifications:

```typescript
/**
 * Generated from TestSpecification: test-014
 * Task: task-006
 * Requirement: req-002
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createAuthStore } from "../domain"
import { MockAuthService } from "../mock"

describe("AuthSession.isExpired", () => {
  // Given: AuthSession entity with expiresAt in the past
  let store: any
  
  beforeEach(() => {
    const authService = new MockAuthService()
    const env = { services: { auth: authService } }
    store = createAuthStore().createStore(env)
  })

  test("returns true when expiresAt is in the past", () => {
    // Setup: Create session with past expiry
    store.authSessionCollection.add({
      id: "session-1",
      userId: "user-1",
      accessToken: "token",
      expiresAt: "2024-01-01T00:00:00Z"
    })
    
    // When: isExpired is accessed
    const session = store.authSessionCollection.get("session-1")
    
    // Then: Returns true
    expect(session.isExpired).toBe(true)
  })
})
```

**Run tests - expect failure:**

```bash
bun test packages/state-api/src/auth/__tests__/domain.test.ts
```

```
Test Status: RED (expected)
Failing: 8 tests
- AuthSession.isExpired: Cannot read property 'isExpired' of undefined

Proceeding to implementation...
```

**Gate Check**:
```
Before implementing domain store:
[✓] Test file created: src/auth/__tests__/domain.test.ts
[✓] Tests executed: bun test src/auth/__tests__/domain.test.ts
[✓] Status: RED (tests failing as expected)

Proceeding to implementation...
```

If tests pass before implementation → **STOP**. Investigate:
- Tests not testing new functionality
- Implementation already exists
- Assertions never fire

#### 4.3 Implement Code

Based on `IntegrationPoint.changeType`:

| changeType | Action |
|------------|--------|
| `add` | Create new file |
| `modify` | Edit existing file |
| `extend` | Add to existing pattern |

**Schema-first implementation** (CRITICAL for domain stores):

```typescript
// domain.ts - Always use createStoreFromScope
import { scope } from "arktype"
import { createStoreFromScope } from "../schematic"

export const AuthDomain = scope({
  AuthUser: {
    id: "string.uuid",
    email: "string",
    emailVerified: "boolean",
    createdAt: "string",
  },
  AuthSession: {
    id: "string.uuid",
    userId: "AuthUser",  // Reference by entity name
    accessToken: "string",
    refreshToken: "string",
    expiresAt: "string",
  },
})

export function createAuthStore() {
  return createStoreFromScope(AuthDomain, {
    // Enhancement hooks add domain behavior
    enhanceModels: (models) => ({
      ...models,
      AuthSession: models.AuthSession.views((self) => ({
        get isExpired(): boolean {
          return Date.now() > new Date(self.expiresAt).getTime()
        },
      })),
    }),
    
    enhanceCollections: (collections) => ({
      ...collections,
    }),
    
    enhanceRootStore: (RootModel) =>
      RootModel
        .volatile(() => ({
          authStatus: "idle" as "idle" | "loading" | "error",
          authError: null as string | null,
        }))
        .views((self) => ({
          get isAuthenticated(): boolean {
            return self.authSessionCollection.all().length > 0
          },
          get currentUser() {
            return self.authUserCollection.all()[0] ?? null
          },
        }))
        .actions((self) => ({
          async signIn(credentials) {
            const env = getEnv(self)
            const session = await env.services.auth.signIn(credentials)
            self.syncFromServiceSession(session)
          },
          // ... more actions
        })),
  })
}
```

#### 4.4 GREEN Phase: Verify Tests Pass

```bash
bun test packages/state-api/src/auth/__tests__/domain.test.ts
```

**If tests pass:**
```
Test Status: GREEN ✅
Passing: 8/8 tests

All acceptance criteria met:
✅ domain.ts exports AuthDomain scope
✅ domain.ts exports createAuthStore factory
✅ enhanceModels adds AuthSession.isExpired
✅ enhanceRootStore adds signIn, signOut, initialize
```

**GREEN Gate Check**:
```
Implementation complete for domain store:
[✓] Tests executed: bun test src/auth/__tests__/domain.test.ts
[✓] Status: GREEN (all tests passing)
[✓] No regressions: bun test (full suite)

Task complete.
```

**If tests fail (retry up to 3x):**
```
Test Status: RED (unexpected)
Failing: 2 tests
- signIn action: Expected mock to be called

Analyzing failure... (attempt 1/3)
```

On persistent failure (3+ attempts):
```
Task blocked after 3 attempts.
Error: Mock service not injected correctly

Options:
1. Skip and continue with non-dependent tasks
2. Pause implementation for manual intervention
3. Discard task changes and retry fresh

Which approach?
```

#### 4.5 Complete Task

```
Task Complete ✅

Progress: 6/7 tasks
Remaining: Create AuthProvider

Continuing to next task...
```

---

## Phase 5: Integration Verification

After all tasks complete:

```bash
# Full test suite
bun test

# Type check
bun run typecheck

# Build
bun run build
```

```
Integration Verification

Tests: 142/142 passing
TypeCheck: ✅ No errors
Build: ✅ Success

Feature integration verified.
```

### Proof-of-Work Verification

For features with external services:

1. Start dev server with real credentials
2. Navigate to demo page (`/auth-demo`)
3. Complete full feature flow
4. Verify real data displays
5. Test error states

```
Proof-of-Work: Auth Demo Page
- Sign up: ✅ Real user created in Supabase
- Sign in: ✅ Session established
- Session display: ✅ User email visible
- Sign out: ✅ Session cleared
- Error handling: ✅ Invalid credentials handled

All scenarios validated with real service.
```

---

## Phase 6: Handoff

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Session: auth-layer
Duration: ~45 minutes

Tasks: 7/7 complete
Tests: 33/33 passing

Files Created/Modified:
- packages/state-api/src/auth/types.ts
- packages/state-api/src/auth/supabase.ts
- packages/state-api/src/auth/mock.ts
- packages/state-api/src/auth/domain.ts
- packages/state-api/src/auth/__tests__/domain.test.ts
- packages/state-api/src/environment/types.ts
- apps/web/src/contexts/AuthContext.tsx
- apps/web/src/pages/AuthDemoPage.tsx

Feature is ready for review.
```

---

## Schema-First Principle (CRITICAL)

**NEVER hand-code MST models.** Always use the schematic pipeline:

1. Domain entities defined in ArkType scope
2. `createStoreFromScope()` generates MST models + collections
3. Enhancement hooks add domain behavior

### The domain.ts Pattern

Every feature MUST have a `domain.ts` that exports:
- `{Feature}Domain` - ArkType scope defining entities
- `create{Feature}Store(options)` - Factory with enhancement hooks

### What NOT to Do

| ❌ Don't | ✅ Do Instead |
|---------|--------------|
| Create `mixin.ts` with hand-coded MST | Use enhancement hooks in domain.ts |
| Use `types.model()` directly | Use `createStoreFromScope()` |
| Create standalone `hooks.ts` | Put all hooks in domain.ts |
| Define MST models in React contexts | Import from domain.ts |

---

## Error Handling

### Task Failure Strategies

| Failure Type | Default Action | Alternatives |
|--------------|----------------|--------------|
| Tests never pass | Mark blocked, skip | Retry different approach, manual fix |
| Dependency failed | Skip dependent tasks | Implement partial, ask user |
| File conflict | Stop and report | Merge manually, retry |
| Build failure | Analyze, fix | Revert, pause |

### Recovery from Partial Progress

The skill tracks progress via `ImplementationRun` entity:

```javascript
const existingRun = store.query("ImplementationRun", "platform-feature-spec", {
  sessionId: session.id,
  status: "in_progress"
})[0]

if (existingRun) {
  const completedIds = new Set(existingRun.completedTasks)
  const remainingTasks = tasks.filter(t => !completedIds.has(t.id))
  // Resume from remaining tasks
}
```

---

## Auth Example: Generated Code

The auth implementation produced:

| File | Lines | Purpose |
|------|-------|---------|
| `types.ts` | 77 | IAuthService interface, type definitions |
| `supabase.ts` | 89 | SupabaseAuthService implementation |
| `mock.ts` | 156 | MockAuthService with configurable behavior |
| `domain.ts` | 253 | AuthDomain scope + createAuthStore factory |
| `domain.test.ts` | 312 | Test suite for domain store |
| `AuthContext.tsx` | 149 | React provider with state sync |
| `AuthDemoPage.tsx` | 87 | Proof-of-work demo page |

**Total**: ~1,123 lines of production code + 312 lines of tests

---

## What to Look For

**Good implementation outputs**:
- Every test written before corresponding implementation
- RED confirmed before writing code
- GREEN confirmed before marking complete
- Full test suite passes at end
- No regressions introduced
- Single domain.ts with all hooks

**Warning signs**:
- Tests written after implementation (not TDD)
- Tests passing before implementation (test is wrong)
- Blocked tasks without resolution
- Domain logic split across multiple files
- Hand-coded MST models

---

## Session Complete

With implementation finished, the feature is production-ready:

- All requirements traced through to working code
- All tests passing
- Integration verified
- Proof-of-work validated (if applicable)

The session status transitions to `complete`. The feature can now be:
- Reviewed by team members
- Deployed to staging/production
- Used as reference for future features
