# Pattern 6: React Context Integration

> Wrap MST store in React context with proper lifecycle management.

## Concept

React components need access to MST stores with:

1. Single store instance (not recreated on re-render)
2. Proper initialization sequence (async setup before UI)
3. Subscription cleanup on unmount
4. Reactive updates when store state changes

---

## When to Apply

Apply this pattern when:

- [ ] Feature has React UI components
- [ ] Multiple components need access to the same store
- [ ] Store has async initialization (Pattern 5)
- [ ] Store has subscriptions that need cleanup

---

## Structure

### Component Breakdown

#### 1. Context + Provider

```typescript
// contexts/{Domain}Context.tsx

import { createContext, useContext, useRef, useState, useEffect, ReactNode } from 'react'
import { create{Domain}Store, {Provider}{Domain}Service, NullPersistence } from '@shogo/state-api'

type {Domain}Store = ReturnType<ReturnType<typeof create{Domain}Store>['createStore']>

const {Domain}Context = createContext<{Domain}Store | null>(null)

export function {Domain}Provider({ children }: { children: ReactNode }) {
  // useRef (not useState) for stable store reference
  const storeRef = useRef<{Domain}Store | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Create store synchronously (not in useEffect)
  if (!storeRef.current) {
    const service = new {Provider}{Domain}Service(/* config */)
    const env = {
      services: { persistence: new NullPersistence(), {serviceName}: service },
      context: { schemaName: '{domain}' }
    }
    const { createStore } = create{Domain}Store()
    storeRef.current = createStore(env)
  }

  // Initialize and subscribe
  useEffect(() => {
    const store = storeRef.current
    if (!store) return

    let unsubscribe: (() => void) | undefined

    store.initialize()
      .then(result => {
        if (!result.success) {
          setError(result.error?.message || 'Init failed')
          return
        }
        unsubscribe = store.setup{Domain}Subscription()
        setReady(true)
      })
      .catch(err => setError(err.message))

    // Cleanup on unmount
    return () => unsubscribe?.()
  }, [])

  if (error) return <div>Error: {error}</div>
  if (!ready) return <div>Loading...</div>

  return (
    <{Domain}Context.Provider value={storeRef.current}>
      {children}
    </{Domain}Context.Provider>
  )
}
```

#### 2. Custom Hook

```typescript
export function use{Domain}Store(): {Domain}Store {
  const store = useContext({Domain}Context)
  if (!store) {
    throw new Error('use{Domain}Store must be within {Domain}Provider')
  }
  return store
}
```

#### 3. Observer Components

```typescript
import { observer } from 'mobx-react-lite'
import { use{Domain}Store } from '../contexts/{Domain}Context'

export const {Domain}Dashboard = observer(function {Domain}Dashboard() {
  const store = use{Domain}Store()

  // Reactive: re-renders when these change
  const items = store.{entity}Collection.all()

  return (
    <ul>
      {items.map(item => <li key={item.id}>{item.name}</li>)}
    </ul>
  )
})
```

---

## Task Template

When creating tasks for React Context integration:

| Task | Acceptance Criteria |
|------|---------------------|
| Create {Domain}Context | Context file exports Provider, hook; useRef for store |
| Add loading/error states | Provider renders loading during init, error on failure |
| Setup subscription cleanup | useEffect returns unsubscribe function |
| Create observer components | Components wrapped with `observer()` |
| Wire into app routing | Provider wraps page/feature component tree |

---

## Anti-Patterns

### ❌ useState for Store Reference

```typescript
// BAD: Store recreated on state updates
const [store] = useState(() => createStore(env))

// GOOD: useRef maintains single instance
const storeRef = useRef<Store | null>(null)
```

### ❌ Missing Observer Wrapper

```typescript
// BAD: Component doesn't react to changes
function Dashboard() {
  const store = useStore()
  return <div>{store.items.length}</div>  // Never updates!
}

// GOOD: observer enables reactivity
const Dashboard = observer(function Dashboard() {
  const store = useStore()
  return <div>{store.items.length}</div>
})
```

### ❌ Not Cleaning Up Subscription

```typescript
// BAD: Memory leak
useEffect(() => {
  store.setupSubscription()  // No cleanup!
}, [])

// GOOD: Return cleanup function
useEffect(() => {
  const unsubscribe = store.setupSubscription()
  return () => unsubscribe?.()
}, [])
```

---

## Checklist

- [ ] useRef used for store (not useState)
- [ ] Store created synchronously (not in useEffect)
- [ ] initialize() called in useEffect
- [ ] Subscription cleanup returned from useEffect
- [ ] Loading and error states handled
- [ ] Custom hook throws if used outside provider
- [ ] Components wrapped with observer()
