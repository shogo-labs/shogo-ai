# Test Templates Reference

Templates for generating tests from TestSpecification entities.

## Basic Test Structure

```typescript
/**
 * Generated from TestSpecification: {testSpec.id}
 * Task: {task.id}
 * Requirement: {requirementId}
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"

describe("{testSpec.scenario}", () => {
  // Setup from Given statements
  beforeEach(() => {
    // {given[0]}
    // {given[1]}
  })

  // Cleanup if needed
  afterEach(() => {
    // Reset mocks, clear state
  })

  test("{when} -> {then[0]}", () => {
    // When: {when}
    const result = /* action */

    // Then: {then[0]}
    expect(result)./* assertion */
  })
})
```

## Template by Test Type

### Unit Test (Service)

```typescript
/**
 * Unit test for {serviceName}
 * TestSpecification: {id}
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { {ServiceName} } from "../{service}"
import { Mock{Dependency} } from "../{dependency}/mock"

describe("{scenario}", () => {
  let service: {ServiceName}
  let mock{Dependency}: Mock{Dependency}

  beforeEach(() => {
    mock{Dependency} = new Mock{Dependency}()
    service = new {ServiceName}(mock{Dependency})
  })

  test("{when} -> {then}", async () => {
    // Given: {given statements as setup}
    mock{Dependency}.{setupMethod}({setupArgs})

    // When: {when}
    const result = await service.{method}({args})

    // Then: {then}
    expect(result).{matcher}({expected})
  })
})
```

### Unit Test (Store/Model)

```typescript
/**
 * Unit test for {ModelName} model
 * TestSpecification: {id}
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { createTestStore } from "../test-utils"

describe("{scenario}", () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  test("{when} -> {then}", () => {
    // Given: {given}
    const entity = store.{collection}.create({
      // initial data
    })

    // When: {when}
    entity.{action}({args})

    // Then: {then}
    expect(entity.{property}).{matcher}({expected})
  })
})
```

### Unit Test (Reference Resolution) - REQUIRED for Domain Stores

```typescript
/**
 * Reference resolution test for {Domain}Store
 * Verifies MST references resolve to entity instances
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { create{Domain}Store } from "../domain"
import { Mock{Domain}Service } from "../mock"
import { NullPersistence } from "../../persistence/null"

describe("{Domain}Store reference resolution", () => {
  let store: ReturnType<typeof create{Domain}Store>

  beforeEach(() => {
    const env = {
      services: {
        persistence: new NullPersistence(),
        {domain}: new Mock{Domain}Service(),
      },
      context: { schemaName: "test-{domain}" },
    }
    store = create{Domain}Store(env)
  })

  test("{parent}.{reference} resolves to {Target} instance", () => {
    const target = store.{targetCollection}.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      // ... required fields
    })

    const parent = store.{parentCollection}.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      {reference}: target.id,
    })

    // CRITICAL: Instance equality - NOT just ID comparison
    expect(parent.{reference}).toBe(target)
    expect(parent.{reference}?.{property}).toBe(target.{property})
  })

  test("optional reference is undefined when not set", () => {
    const parent = store.{parentCollection}.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      // {reference} not provided
    })

    expect(parent.{reference}).toBeUndefined()
  })
})
```

### Integration Test

```typescript
/**
 * Integration test for {feature}
 * TestSpecification: {id}
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createTestEnvironment } from "../test-utils"

describe("{scenario}", () => {
  let env: ReturnType<typeof createTestEnvironment>

  beforeEach(async () => {
    env = await createTestEnvironment()
  })

  afterEach(async () => {
    await env.cleanup()
  })

  test("{when} -> {then}", async () => {
    // Given: {given}
    await env.{setupMethod}({setupArgs})

    // When: {when}
    const result = await env.{method}({args})

    // Then: {then}
    expect(result).{matcher}({expected})
  })
})
```

### Acceptance Test (React Component)

```typescript
/**
 * Acceptance test for {ComponentName}
 * TestSpecification: {id}
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { {ComponentName} } from "../{component}"
import { TestProviders } from "../test-utils"

describe("{scenario}", () => {
  beforeEach(() => {
    // {given}
  })

  test("{when} -> {then}", async () => {
    // Given: render component
    render(
      <TestProviders>
        <{ComponentName} />
      </TestProviders>
    )

    // When: {when}
    fireEvent.click(screen.getByRole("button", { name: "{buttonText}" }))

    // Then: {then}
    await waitFor(() => {
      expect(screen.getByText("{expectedText}")).toBeInTheDocument()
    })
  })
})
```

## Given/When/Then Translation

### Given → Setup

| Given Statement | Code Pattern |
|-----------------|--------------|
| "a mock auth service" | `mockAuth = new MockAuthService()` |
| "user with email X" | `mockAuth.setUser({ email: "X" })` |
| "empty collection" | `store.{collection}.clear()` |
| "existing entity" | `store.{collection}.create({...})` |
| "service returns error" | `mockService.setError(new Error(...))` |

### When → Action

| When Statement | Code Pattern |
|----------------|--------------|
| "user calls signup" | `await service.signup(...)` |
| "user clicks button" | `fireEvent.click(button)` |
| "store loads data" | `await store.loadAll()` |
| "entity is updated" | `entity.update({...})` |

### Then → Assertion

| Then Statement | Code Pattern |
|----------------|--------------|
| "returns user object" | `expect(result).toEqual({...})` |
| "throws error" | `expect(action).toThrow(...)` |
| "collection has N items" | `expect(collection.size).toBe(N)` |
| "shows error message" | `expect(screen.getByText(...)).toBeInTheDocument()` |
| "calls service method" | `expect(mockService.{method}).toHaveBeenCalled()` |

## Common Matchers

```typescript
// Equality
expect(value).toBe(expected)           // strict equality
expect(value).toEqual(expected)        // deep equality
expect(value).toMatchObject(partial)   // partial match

// Truthiness
expect(value).toBeTruthy()
expect(value).toBeFalsy()
expect(value).toBeNull()
expect(value).toBeDefined()

// Numbers
expect(value).toBeGreaterThan(n)
expect(value).toBeLessThan(n)

// Strings
expect(value).toMatch(/regex/)
expect(value).toContain("substring")

// Arrays
expect(array).toHaveLength(n)
expect(array).toContain(item)

// Errors
expect(() => fn()).toThrow()
expect(() => fn()).toThrow(ErrorType)
expect(() => fn()).toThrow("message")

// Async
await expect(promise).resolves.toBe(value)
await expect(promise).rejects.toThrow()
```

## Mock Patterns

### Service Mock

```typescript
export class MockAuthService implements IAuthService {
  private users: Map<string, User> = new Map()
  private error: Error | null = null
  public calls: { method: string; args: any[] }[] = []

  setUser(user: User) {
    this.users.set(user.id, user)
  }

  setError(error: Error) {
    this.error = error
  }

  clear() {
    this.users.clear()
    this.error = null
    this.calls = []
  }

  async signup(email: string, password: string): Promise<User> {
    this.calls.push({ method: "signup", args: [email, password] })
    if (this.error) throw this.error
    const user = { id: crypto.randomUUID(), email }
    this.users.set(user.id, user)
    return user
  }

  // ... other methods
}
```

### Environment Mock

```typescript
export function createMockEnvironment(): IAuthEnvironment {
  return {
    authService: new MockAuthService(),
    persistenceService: new NullPersistenceService(),
    // ... other services
  }
}
```

## File Naming

| Test Type | File Pattern |
|-----------|--------------|
| Unit (service) | `src/{domain}/__tests__/{service}.test.ts` |
| Unit (model) | `src/{domain}/__tests__/{model}.test.ts` |
| Integration | `src/{domain}/__tests__/{feature}.integration.test.ts` |
| Acceptance | `src/components/__tests__/{component}.test.tsx` |

## Test Organization

```
src/auth/
├── __tests__/
│   ├── auth-service.test.ts      # Unit tests for service
│   ├── auth-store.test.ts        # Unit tests for store
│   └── auth.integration.test.ts  # Integration tests
├── types.ts
├── supabase.ts
├── mock.ts
└── domain.ts
```
