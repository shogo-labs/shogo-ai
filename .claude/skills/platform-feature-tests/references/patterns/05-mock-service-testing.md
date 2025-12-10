# Pattern 4: Mock Service Testing

> Test MST stores with mock service implementations for reliable, fast TDD.

## Concept

When stores depend on services (via Pattern 2), tests need mock implementations that:

1. Implement the full service interface (not partial stubs)
2. Use in-memory storage for predictable behavior
3. Allow configuration (pre-seed data, simulate errors)
4. Enable inspection (what was called, with what args)

---

## When to Apply

This pattern always accompanies Pattern 1 (Service Interface). Apply when:

- [ ] Store actions call service methods
- [ ] Tests need to verify service interactions
- [ ] Tests should run without network/external dependencies
- [ ] Different test scenarios need different service behaviors

---

## Structure

### Mock Implementation Requirements

| Requirement | Why |
|-------------|-----|
| Full interface implementation | Catch contract violations |
| In-memory storage | Predictable, fast, isolated |
| Configurable behavior | Test success, failure, edge cases |
| Inspection helpers | Assert what was called |
| Reset/clear method | Clean state between tests |

### Mock Service Template

```typescript
// mock.ts

import type { IPaymentService, PaymentRequest, PaymentResult } from './types'

export type MockPaymentConfig = {
  existingCharges?: Map<string, PaymentResult>
  simulateFailure?: boolean
  failureMessage?: string
  latencyMs?: number
}

export class MockPaymentService implements IPaymentService {
  private charges: Map<string, PaymentResult> = new Map()
  private chargeCalls: PaymentRequest[] = []
  private config: MockPaymentConfig

  constructor(config: MockPaymentConfig = {}) {
    this.config = config
  }

  async charge(request: PaymentRequest): Promise<PaymentResult> {
    this.chargeCalls.push(request)

    if (this.config.simulateFailure) {
      return {
        success: false,
        error: { message: this.config.failureMessage || 'Failed' }
      }
    }

    const result: PaymentResult = {
      success: true,
      transactionId: this.generateId(),
      amount: request.amount
    }
    this.charges.set(result.transactionId, result)
    return result
  }

  // Inspection helpers
  getChargeCalls(): PaymentRequest[] {
    return [...this.chargeCalls]
  }

  // Reset for test isolation
  clear(): void {
    this.charges.clear()
    this.chargeCalls = []
  }
}
```

### Test Setup Pattern

```typescript
// __tests__/store.test.ts

import { describe, test, expect, beforeEach } from 'bun:test'
import { createOrderStore } from '../domain'
import { MockPaymentService } from '../payment/mock'
import { NullPersistence } from '../persistence/null'

describe('OrderStore', () => {
  let store: /* store type */
  let mockPayment: MockPaymentService

  beforeEach(() => {
    // Fresh mock for each test
    mockPayment = new MockPaymentService()

    const env = {
      services: {
        persistence: new NullPersistence(),
        payment: mockPayment
      },
      context: { schemaName: 'test' }
    }

    const { createStore } = createOrderStore()
    store = createStore(env)
  })

  // Tests...
})
```

---

## Given/When/Then Test Patterns

### Success Flow

```
Given: Order exists with status 'pending'
Given: Payment service configured for success
When: store.processPayment('order-1', paymentDetails) is called
Then: Result has success: true
Then: Order status is 'paid'
Then: mockPayment.getChargeCalls() has 1 entry
```

### Failure Flow

```
Given: Order exists with status 'pending'
Given: Payment service configured with simulateFailure: true
When: store.processPayment('order-1', paymentDetails) is called
Then: Result has success: false
Then: Result has error message
Then: Order status is 'payment-failed'
```

### Inspection Pattern

```
Given: MockEmailService instance
When: store.sendNotification(userId, message) is called
Then: mockEmail.getSendCalls() includes message with correct 'to' field
```

---

## Anti-Patterns

### ❌ Partial Interface Implementation

```typescript
// BAD: Missing methods
class MockEmailService implements IEmailService {
  async send() { return { success: true } }
  // Missing: sendBatch, getStatus!
}
```

### ❌ Shared Mock State Between Tests

```typescript
// BAD: Mock not reset
const mockPayment = new MockPaymentService()

beforeEach(() => {
  // Missing: mockPayment.clear()
})
```

### ❌ Testing Implementation Details

```typescript
// BAD: Private access
expect(mockPayment['charges'].size).toBe(1)

// GOOD: Public interface
expect(mockPayment.getChargeCalls()).toHaveLength(1)
```

---

## Checklist

- [ ] Mock implements full service interface
- [ ] In-memory storage (no external dependencies)
- [ ] Configuration allows success/failure/edge cases
- [ ] Call tracking available for assertions
- [ ] clear() method for test isolation
- [ ] Tests use beforeEach to reset state
- [ ] Both success and failure paths tested

---

## Mock and NullPersistence Scope

Understanding when to use mocks vs real implementations is critical for proper testing and validation.

### MockService is for:

- Unit tests requiring deterministic behavior
- Integration tests needing controlled responses
- Component tests with predictable state
- Testing error handling paths

### MockService is NOT for:

- Proof-of-work pages (use real provider)
- Production builds
- Validating real service integration
- Demo pages showing feature functionality

### NullPersistence is for:

- Unit tests (fast, isolated, no file I/O)
- In-memory store testing
- Testing business logic independent of persistence
- Fast test execution without disk access

### NullPersistence is NOT for:

- Proof-of-work pages (use real persistence)
- Validating persistence round-trips
- Integration tests requiring actual file I/O
- Demo pages showing save/load functionality

### Feature Type Determines Test Setup

| Feature Type | Unit Test Setup | Proof-of-Work Setup |
|--------------|-----------------|---------------------|
| External Service | `MockService` + `NullPersistence` | Real provider + `MCPPersistence` |
| Internal Domain | `NullPersistence` only | `MCPPersistence` (browser demos) |

### Key Principle

**Tests verify logic in isolation. Proof-of-work validates real integration.**

```typescript
// UNIT TEST: Fast, isolated, deterministic
const env = {
  services: {
    persistence: new NullPersistence(),
    auth: new MockAuthService()
  }
}

// PROOF-OF-WORK: Real services, real persistence (browser-side)
const env = {
  services: {
    persistence: new MCPPersistence(mcpService),
    auth: new SupabaseAuthService(supabaseClient)
  }
}
```
