# Pattern 6: React Context Integration (Testing)

> Test React components that use MST stores via DomainProvider.

## Concept

When testing React components that consume stores via `useDomains()`, tests need:

1. Test wrapper with DomainProvider and mock environment
2. Ability to control store state for different scenarios
3. Reactive assertion support (wait for state changes)

---

## Test Setup Pattern

### Component Test with DomainProvider

```typescript
// __tests__/Dashboard.test.tsx

import { render, screen, waitFor } from '@testing-library/react'
import { describe, test, expect, beforeEach } from 'bun:test'
import { EnvironmentProvider, createEnvironment } from '../contexts/EnvironmentContext'
import { DomainProvider } from '../contexts/DomainProvider'
import { PaymentDashboard } from '../components/PaymentDashboard'
import { paymentDomain, MockPaymentService, NullPersistence } from '@shogo/state-api'

describe('PaymentDashboard', () => {
  let mockPayment: MockPaymentService

  beforeEach(() => {
    mockPayment = new MockPaymentService()
  })

  // Test wrapper helper
  function renderWithProviders(ui: React.ReactElement, options?: { payment?: MockPaymentService }) {
    const env = createEnvironment({
      persistence: new NullPersistence(),
      services: {
        payment: options?.payment ?? mockPayment
      }
    })

    return render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ payment: paymentDomain }}>
          {ui}
        </DomainProvider>
      </EnvironmentProvider>
    )
  }

  test('renders loading state initially', () => {
    renderWithProviders(<PaymentDashboard />)
    expect(screen.getByText('Loading...')).toBeDefined()
  })

  test('renders transactions after initialization', async () => {
    // Pre-seed mock data
    const seededMock = new MockPaymentService({
      existingCharges: new Map([
        ['tx-1', { transactionId: 'tx-1', amount: 1000, success: true }]
      ])
    })

    renderWithProviders(<PaymentDashboard />, { payment: seededMock })

    // Wait for DomainProvider to load collections
    await waitFor(() => {
      expect(screen.getByText('$10.00')).toBeDefined()
    })
  })

  test('displays error on initialization failure', async () => {
    const failingMock = new MockPaymentService({
      simulateFailure: true,
      failureMessage: 'Connection refused'
    })

    renderWithProviders(<PaymentDashboard />, { payment: failingMock })

    await waitFor(() => {
      expect(screen.getByText(/Connection refused/)).toBeDefined()
    })
  })
})
```

### Test Wrapper Component

For cleaner test setup, create a reusable wrapper:

```typescript
// __tests__/helpers/TestProviders.tsx

import { ReactNode } from 'react'
import { EnvironmentProvider, createEnvironment } from '../../contexts/EnvironmentContext'
import { DomainProvider } from '../../contexts/DomainProvider'
import { paymentDomain, teamsDomain, NullPersistence } from '@shogo/state-api'
import type { IPaymentService, ITeamsService } from '@shogo/state-api'

interface TestProvidersProps {
  children: ReactNode
  services?: {
    payment?: IPaymentService
    teams?: ITeamsService
  }
}

export function TestProviders({ children, services }: TestProvidersProps) {
  const env = createEnvironment({
    persistence: new NullPersistence(),
    services,
  })

  // Only include domains you need for the test
  const domains = {
    payment: paymentDomain,
    teams: teamsDomain,
  }

  return (
    <EnvironmentProvider env={env}>
      <DomainProvider domains={domains}>
        {children}
      </DomainProvider>
    </EnvironmentProvider>
  )
}
```

### Direct Store Testing (No React)

For unit testing domain logic without React:

```typescript
// __tests__/payment-domain.test.ts

import { describe, test, expect, beforeEach } from 'bun:test'
import { paymentDomain, MockPaymentService, NullPersistence } from '@shogo/state-api'

describe('PaymentDomain', () => {
  let store: any
  let mockPayment: MockPaymentService

  beforeEach(() => {
    mockPayment = new MockPaymentService()

    const env = {
      services: {
        persistence: new NullPersistence(),
        payment: mockPayment
      },
      context: { schemaName: 'test-payment' }
    }

    // Use named domain export with createStore method
    store = paymentDomain.createStore(env)
  })

  test('processes payment through service', async () => {
    const result = await store.processPayment({
      amount: 1000,
      method: 'card'
    })

    expect(result.success).toBe(true)
    expect(store.transactionCollection.all().length).toBe(1)
  })

  test('persists transaction after payment', async () => {
    await store.processPayment({ amount: 1000, method: 'card' })

    // Transaction should be in collection
    const transactions = store.transactionCollection.all()
    expect(transactions[0].amount).toBe(1000)
  })
})
```

---

## Given/When/Then Test Patterns

### Loading State

```
Given: DomainProvider wraps component
When: Component mounts
Then: DomainProvider triggers loadAll() on collections
Then: Loading indicator visible until data loaded
```

### Data Loaded

```
Given: Mock service returns pre-seeded data
Given: DomainProvider wraps component
When: Collections finish loading
Then: Component renders data from store
```

### User Interaction

```
Given: Store initialized with test data
Given: Component rendered within TestProviders
When: User clicks "Process Payment" button
Then: Store action is called
Then: UI updates to reflect new state
```

### Error Handling

```
Given: Mock service configured with simulateFailure: true
When: Component triggers store action
Then: Error state is captured
Then: UI displays error message
```

---

## Checklist

- [ ] Test wrapper provides EnvironmentProvider + DomainProvider
- [ ] Mock services injected via environment, not provider props
- [ ] NullPersistence used for unit tests (no disk I/O)
- [ ] Tests wait for async operations with `waitFor()`
- [ ] Components wrapped with `observer()` for reactivity
- [ ] Domain logic tests don't need React (use `domain.createStore()` directly)

---

## Key Differences from Old Pattern

| Old Pattern | New Pattern |
|-------------|-------------|
| Custom Provider per domain | Shared `DomainProvider` |
| `testServices` prop on Provider | Services via `EnvironmentProvider` |
| `createXStore()` factory | `xDomain.createStore(env)` |
| Manual store creation in tests | Same pattern, just different API |

The main change is that **you no longer need custom context providers per domain**. The shared `DomainProvider` handles all domains, and you configure test services through `EnvironmentProvider`.
