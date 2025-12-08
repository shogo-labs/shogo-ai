# Spec: Task Breakdown

The **Spec** skill transforms integration points into ordered implementation tasks with acceptance criteria. This creates the execution plan that drives TDD implementation.

## Role in the Pipeline

```
Discovery → Analysis → Design → [SPEC] → Tests → Implementation
                                  │
                                  ▼
                        ImplementationTask entities
                        with acceptance criteria
```

**Previous**: Design creates schema and enhancement hooks decision  
**Next**: Tests skill creates test specifications per task

## When to Invoke

| Trigger | Session Status | Situation |
|---------|---------------|-----------|
| `/platform-feature-spec` | `spec` | After analysis identifies integration points |
| "create the implementation plan" | `spec` | Integration points are clear |
| "define the tasks" | `spec` | Ready to break work into executable units |

## Inputs

From **platform-features** schema:
- `PlatformFeatureSession` - Active session
- `Requirement` entities - What must be accomplished
- `DesignDecision` entities - Key design choices (especially enhancement hooks)

From **platform-feature-spec** schema:
- `AnalysisFinding` entities - Patterns, gaps, risks
- `IntegrationPoint` entities - Where code changes are needed

## What Spec Produces

| Output | Schema | Purpose |
|--------|--------|---------|
| `ImplementationTask` entities | platform-feature-spec | Ordered work items with acceptance criteria |
| Updated session status | platform-features | Status → `testing` |

---

## Task Creation Principles

### Dependency-Ordered Execution

Tasks are ordered by dependency:

```
Level 0 (no dependencies)
├── Add dependencies to package.json
└── Create types.ts with interface

Level 1 (depends on Level 0)
├── Implement SupabaseAuthService
└── Implement MockAuthService

Level 2 (depends on Level 1)
├── Create domain.ts store
└── Extend IEnvironment

Level 3 (depends on Level 2)
├── Create AuthContext provider
└── Create demo page
```

Each task explicitly declares its `dependencies` array.

### Package Placement Enforcement

The spec skill **enforces isomorphism** regardless of what analysis suggested:

| Component | MUST be in | Path |
|-----------|------------|------|
| `types.ts` (interface) | state-api | `src/{domain}/types.ts` |
| `{provider}.ts` | state-api | `src/{domain}/{provider}.ts` |
| `mock.ts` | state-api | `src/{domain}/mock.ts` |
| `domain.ts` | state-api | `src/{domain}/domain.ts` |
| `{Domain}Context.tsx` | apps/web | `src/contexts/{Domain}Context.tsx` |
| Components | apps/web | `src/components/{Domain}/*.tsx` |

If analysis recommended placing domain logic in apps/web, spec **overrides** this.

### Task Granularity

| Granularity | Integration Points per Task | When to Use |
|-------------|----------------------------|-------------|
| Fine | 1 IP | Complex changes, precise tracking needed |
| Medium | 2-3 IPs | Related changes in same module |
| Coarse | 4+ IPs | Simple, mechanical changes |

Default to **medium** granularity.

---

## Task Templates

### Service Interface Task

```javascript
{
  id: "task-service-interface",
  description: "Create IAuthService interface and type definitions",
  integrationPoint: "ip-types",
  acceptanceCriteria: [
    "types.ts exports IAuthService interface",
    "Interface defines signUp, signIn, signOut, getSession methods",
    "AuthCredentials, AuthUser, AuthSession types exported",
    "NO runtime imports - pure type definitions only"
  ],
  dependencies: [],
  status: "planned"
}
```

### Service Implementation Task

```javascript
{
  id: "task-supabase-service",
  description: "Implement SupabaseAuthService provider",
  integrationPoint: "ip-supabase",
  acceptanceCriteria: [
    "SupabaseAuthService implements IAuthService",
    "Constructor accepts SupabaseClient instance",
    "All methods delegate to Supabase Auth API",
    "Errors wrapped in AuthError type"
  ],
  dependencies: ["task-service-interface"],
  status: "planned"
}
```

### Domain Store Task (CRITICAL)

This is the most important task template. **Never split into multiple tasks:**

```javascript
{
  id: "task-domain-store",
  description: "Create auth domain store with enhancement hooks",
  integrationPoint: "ip-domain",
  acceptanceCriteria: [
    // Schema structure
    "All entity identifier fields use 'string.uuid' type",
    "domain.ts exports AuthDomain ArkType scope",
    "Entity relationships use entity name directly",
    "Domain schema contains only business state",
    
    // Factory and hooks (from DesignDecision)
    "domain.ts exports createAuthStore() factory",
    "enhanceModels adds: AuthSession.isExpired",
    "enhanceCollections required (even if minimal)",
    "enhanceRootStore adds: initialize, signIn, signOut, isAuthenticated, currentUser",
    
    // Integration
    "Store integrates with IAuthService via getEnv()",
    
    // Reference integrity
    "Tests verify reference fields resolve to entity instances"
  ],
  dependencies: ["task-service-interface", "task-environment-extension"],
  status: "planned"
}
```


### React Context Task

```javascript
{
  id: "task-react-context",
  description: "Create AuthProvider and useAuth hook",
  integrationPoint: "ip-context",
  acceptanceCriteria: [
    "AuthProvider creates store via createAuthStore()",
    "Store instance stable via useRef",
    "Subscribes to auth state changes via onAuthStateChange",
    "Cleanup function returned from useEffect",
    "useAuth throws if used outside provider"
  ],
  dependencies: ["task-domain-store"],
  status: "planned"
}
```

### Proof-of-Work Page Task

For features with external service integration:

```javascript
{
  id: "task-proof-of-work",
  description: "Create auth demo page with real Supabase",
  integrationPoint: "ip-demo-page",
  acceptanceCriteria: [
    "Page demonstrates complete auth flow with real credentials",
    "Shows sign up, sign in, sign out end-to-end",
    "Displays real user data from Supabase",
    "Includes loading states and error handling",
    "Accessible at /auth-demo route"
  ],
  dependencies: ["task-react-context"],
  status: "planned"
}
```

---

## Acceptance Criteria Patterns

### For New Files

```
- File exists at {path}
- Exports {functions/components}
- {Function} accepts {params} and returns {type}
```

### For Modifications

```
- {Existing function} now {new behavior}
- {New parameter} is handled correctly
- Backward compatibility maintained for {existing callers}
```

### For Integrations

```
- {Component A} successfully calls {Component B}
- Error from {B} is handled by {A} with {behavior}
- {Flow} works end-to-end
```

---

## Spec Workflow

### Phase 1: Load Context

```
Session: auth-layer
Status: spec
Requirements: 4
Analysis Findings: 6
Integration Points: 8

Design Decisions:
- Collection pattern for auth entities
- Enhancement hooks: AuthSession.isExpired, signIn/signOut/initialize

Ready to create implementation tasks?
```

### Phase 2: Group Integration Points

The skill analyzes integration points and groups by:
- Same module/feature area
- Shared dependencies
- Same package when tightly coupled

### Phase 3: Create Tasks (Review Gate)

Tasks presented for approval:

```
Implementation Tasks (7)

1. [task-001] Add auth dependencies
   - Acceptance: package.json includes @supabase/supabase-js
   - Dependencies: none

2. [task-002] Create IAuthService interface
   - Acceptance: types.ts exports interface with signUp, signIn, signOut, getSession
   - Dependencies: task-001

3. [task-003] Implement SupabaseAuthService
   - Acceptance: supabase.ts implements IAuthService
   - Dependencies: task-002

4. [task-004] Implement MockAuthService
   - Acceptance: mock.ts implements IAuthService with in-memory state
   - Dependencies: task-002

5. [task-005] Extend IEnvironment
   - Acceptance: environment/types.ts includes auth?: IAuthService
   - Dependencies: task-002

6. [task-006] Create auth domain store
   - Acceptance: domain.ts exports AuthDomain scope and createAuthStore factory
   - Dependencies: task-002, task-005

7. [task-007] Create AuthProvider and useAuth
   - Acceptance: AuthContext.tsx creates store, subscribes to auth changes
   - Dependencies: task-006

Does this task breakdown look correct?
```

### Phase 4: Handoff

After approval:
- All tasks created as `ImplementationTask` entities
- Session status updated to `testing`
- Ready for tests skill

```
Spec Complete

Tasks: 7
Dependency levels: 4

Coverage:
- All 8 integration points assigned to tasks
- All 4 requirements traceable to tasks

Ready for platform-feature-tests to create test specifications.
```

---

## Auth Example Output

For the auth feature, spec produced 7 tasks across 4 dependency levels:

| Level | Tasks |
|-------|-------|
| 0 | Add dependencies |
| 1 | Types interface, Mock service |
| 2 | Supabase service, Environment extension, Domain store |
| 3 | React context, Demo page |

Each task has:
- Clear description
- Testable acceptance criteria
- Explicit dependencies
- Traced to integration point

---

## What to Look For

**Good spec outputs**:
- Single domain store task (not split into mixin/hooks)
- Clear dependency ordering
- Acceptance criteria are testable
- Package placement enforces isomorphism
- All integration points assigned to tasks

**Warning signs**:
- Multiple tasks for domain logic (mixin.ts, hooks.ts)
- Domain logic tasks in apps/web
- Circular dependencies
- Vague acceptance criteria ("works correctly")

---

## DesignDecision → Task Mapping

The spec skill reads DesignDecision entities from design phase:

| DesignDecision | Task Impact |
|----------------|-------------|
| Enhancement hooks decision | Domain store task acceptance criteria |
| Collection pattern | All entities use collection access |
| Service interface | Creates types.ts and provider tasks |
| Reference relationships | Domain task includes reference integrity tests |

This traceability ensures design decisions flow into implementation.

---

## Next Step

With implementation tasks defined:

→ **Proceed to [Tests](tests.md)** to create test specifications for each task

The tests skill creates Given/When/Then specifications that drive TDD.
