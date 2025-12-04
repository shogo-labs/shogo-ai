# Pattern 6: React Context Integration (Testing)

> Test React components that use MST stores via context.

## Concept

When testing React components that consume stores via context, tests need:

1. Provider wrapper with mock environment
2. Ability to control store state for different scenarios
3. Reactive assertion support (wait for state changes)

---

## Test Setup Pattern

### Component Test with Provider

```typescript
// __tests__/Dashboard.test.tsx

import { render, screen, waitFor } from '@testing-library/react'
import { describe, test, expect, beforeEach } from 'bun:test'
import { PaymentProvider } from '../contexts/PaymentContext'
import { PaymentDashboard } from '../components/PaymentDashboard'
import { MockPaymentService } from '@shogo/state-api'

describe('PaymentDashboard', () => {
  let mockPayment: MockPaymentService

  beforeEach(() => {
    mockPayment = new MockPaymentService()
  })

  test('renders loading state initially', () => {
    render(
      <PaymentProvider testServices={{ payment: mockPayment }}>
        <PaymentDashboard />
      </PaymentProvider>
    )

    expect(screen.getByText('Loading...')).toBeDefined()
  })

  test('renders transactions after initialization', async () => {
    // Pre-seed mock data
    mockPayment = new MockPaymentService({
      existingCharges: new Map([
        ['tx-1', { transactionId: 'tx-1', amount: 1000, success: true }]
      ])
    })

    render(
      <PaymentProvider testServices={{ payment: mockPayment }}>
        <PaymentDashboard />
      </PaymentProvider>
    )

    // Wait for initialization
    await waitFor(() => {
      expect(screen.getByText('$10.00')).toBeDefined()
    })
  })

  test('displays error on initialization failure', async () => {
    mockPayment = new MockPaymentService({
      simulateFailure: true,
      failureMessage: 'Connection refused'
    })

    render(
      <PaymentProvider testServices={{ payment: mockPayment }}>
        <PaymentDashboard />
      </PaymentProvider>
    )

    await waitFor(() => {
      expect(screen.getByText(/Connection refused/)).toBeDefined()
    })
  })
})
```

### Provider with Test Support

```typescript
// contexts/PaymentContext.tsx

type PaymentProviderProps = {
  children: ReactNode
  // Allow injecting test services
  testServices?: {
    payment?: IPaymentService
  }
}

export function PaymentProvider({
  children,
  testServices
}: PaymentProviderProps) {
  // Use test services if provided, otherwise create real ones
  if (!storeRef.current) {
    const paymentService = testServices?.payment
      ?? new StripePaymentService(config)

    const env = {
      services: {
        persistence: new NullPersistence(),
        payment: paymentService
      },
      context: { schemaName: 'payment' }
    }

    const { createStore } = createPaymentStore()
    storeRef.current = createStore(env)
  }

  // ... rest of provider
}
```

---

## Given/When/Then Test Patterns

### Loading State

```
Given: Provider wraps component
When: Component mounts
Then: Loading indicator is visible
Then: After initialization completes, content is visible
```

### Error State

```
Given: Mock service configured with simulateFailure: true
Given: Provider wraps component
When: Initialization fails
Then: Error message is displayed
```

### User Interaction

```
Given: Store initialized with test data
Given: Component rendered within Provider
When: User clicks "Process Payment" button
Then: mockPayment.getChargeCalls() has 1 entry
Then: Success message is displayed
```

### Reactive Updates

```
Given: Component rendered and observing store.items
When: Store action adds new item
Then: Component re-renders with new item visible
```

---

## Anti-Patterns

### ❌ Testing Without Provider

```typescript
// BAD: Hook throws outside provider
render(<PaymentDashboard />)  // Error: must be within PaymentProvider
```

### ❌ Not Waiting for Async State

```typescript
// BAD: Assertion runs before initialization
render(<PaymentProvider><Dashboard /></PaymentProvider>)
expect(screen.getByText('Data')).toBeDefined()  // Fails - still loading!

// GOOD: Wait for state change
await waitFor(() => {
  expect(screen.getByText('Data')).toBeDefined()
})
```

### ❌ Shared Mock Between Tests

```typescript
// BAD: State leaks between tests
const mockService = new MockService()

// GOOD: Fresh mock per test
beforeEach(() => {
  mockService = new MockService()
})
```

---

## Checklist

- [ ] Provider accepts testServices prop for DI
- [ ] Tests use fresh mock instances (beforeEach)
- [ ] Async state changes use waitFor()
- [ ] Loading, error, and success states tested
- [ ] User interactions tested with mock assertions
