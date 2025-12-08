# Test Patterns by Component Type

## MCP Tool Tests

**Success case pattern**:
```
Scenario: {tool.name} succeeds with valid input
Given: Required dependencies are available
Given: {Preconditions for success}
When: {tool.name} is called with {valid params}
Then: Returns success response
Then: {Expected side effects}
```

**Error case pattern**:
```
Scenario: {tool.name} fails for {error condition}
Given: {Setup for error condition}
When: {tool.name} is called with {params triggering error}
Then: Returns error response
Then: Error message indicates {specific problem}
Then: No side effects occur
```

---

## Utility Module Tests

**Function behavior pattern**:
```
Scenario: {function} handles {case}
Given: {function} is imported
When: {function}({input}) is called
Then: Returns {expected output type}
Then: {Specific assertions about output}
```

**Async function pattern**:
```
Scenario: {function} resolves correctly
Given: {Async preconditions}
When: await {function}({input})
Then: Resolves to {expected value}
Then: {Side effect assertions}
```

---

## React Context Tests

**Provider initialization**:
```
Scenario: Provider initializes with default state
Given: Component is wrapped in Provider
When: Component renders
Then: useHook returns expected default values
```

**State update**:
```
Scenario: {action} updates state correctly
Given: Provider is in {initial state}
When: {action}() is called
Then: State updates to {expected state}
Then: Dependent components re-render
```

---

## React Component Tests

**Render test**:
```
Scenario: Component renders correctly
Given: {Required props/context}
When: Component mounts
Then: {Expected elements} are visible
```

**User interaction**:
```
Scenario: User {action} triggers {behavior}
Given: Component is rendered
Given: {Interaction preconditions}
When: User {performs action}
Then: {Expected outcome}
```

**Form submission**:
```
Scenario: Form submission with valid data
Given: Form is rendered
Given: All required fields are filled
When: User submits form
Then: {Handler} is called with form data
Then: {Success behavior}
```

---

## Domain Store / MST Reference Tests

Domain stores with entity references require specific test patterns beyond basic CRUD.

### Pattern: Reference Resolution
```typescript
test("Reference resolves to correct entity instance", () => {
  const user = store.authUserCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440001",
    email: "test@example.com",
    createdAt: new Date().toISOString()
  })

  const session = store.authSessionCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440002",
    user: user.id,  // Reference by ID
    lastRefreshedAt: new Date().toISOString()
  })

  // CRITICAL: Verify instance equality, not just ID match
  expect(session.user).toBe(user)
  expect(session.user?.email).toBe("test@example.com")
})
```

### Pattern: Optional Reference Undefined
```typescript
test("Optional reference is undefined when not set", () => {
  const session = store.authSessionCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440003",
    lastRefreshedAt: new Date().toISOString()
  })

  expect(session.user).toBeUndefined()
})
```

### Pattern: Reference Update Cascading
```typescript
test("Computed views update when reference changes", () => {
  const company1 = store.companyCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440010",
    name: "Corp A"
  })
  const company2 = store.companyCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440011",
    name: "Corp B"
  })
  const user = store.userCollection.add({
    id: "550e8400-e29b-41d4-a716-446655440012",
    company: company1.id
  })

  expect(company1.employees).toContain(user)
  expect(company2.employees).not.toContain(user)

  user.setCompany(company2.id)

  expect(company1.employees).not.toContain(user)
  expect(company2.employees).toContain(user)
})
```

### Checklist for Domain Store Tests
- [ ] All references resolve to correct instances (not just IDs)
- [ ] Optional references return undefined when not set
- [ ] Computed inverse views update on reference changes
- [ ] Missing reference targets handled gracefully (returns undefined)

---

## Integration Test Patterns

**API → Store flow**:
```
Scenario: {Operation} persists correctly
Given: {Initial state}
When: {API operation} is performed
Then: Store contains {expected entities}
Then: Entities have correct values
```

**Auth flow**:
```
Scenario: {Auth operation} end-to-end
Given: {User state}
When: {Auth action} is performed
Then: {Token state} is updated
Then: {Subsequent requests} work correctly
```

---

## Test Type Selection

| Acceptance Criterion Pattern | Test Type |
|-----------------------------|-----------|
| "File exists at..." | unit (import test) |
| "Exports {function}..." | unit |
| "Returns {value} for..." | unit |
| "Returns error for..." | unit |
| "{A} calls {B}..." | integration |
| "User can..." | acceptance |
| "Redirects to..." | acceptance |
| "Shows {UI element}..." | acceptance |
