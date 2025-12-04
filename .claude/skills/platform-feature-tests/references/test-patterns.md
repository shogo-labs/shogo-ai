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
