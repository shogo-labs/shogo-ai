# Pattern 5: Provider Synchronization

> Sync external provider state into MST store reactively.

## Concept

When a feature integrates with an external provider that maintains its own state, the MST store needs to:

1. Initialize by fetching current provider state
2. Sync changes from local actions back to provider
3. React to external state changes (webhooks, polling, subscriptions)
4. Keep local and provider state consistent

---

## When to Apply

Apply this pattern when:

- [ ] External provider is source of truth for some data
- [ ] Provider state can change without local action (other clients, background jobs)
- [ ] Real-time sync is needed (not just request/response)
- [ ] Local store caches provider data for UI reactivity

Do NOT apply when:

- Provider is stateless (just computation)
- Simple request/response with no local caching
- All state changes originate locally

---

## Structure

### What to Look For in Codebase

When exploring for this pattern, search for:

| Pattern Element | What to Grep/Glob |
|-----------------|-------------------|
| Internal sync methods | `_syncFromProvider` |
| Initialize actions | `async initialize()` |
| Subscription setup | `setupSubscription`, `onStateChange` |
| Connection status | `connectionStatus`, `isConnected` |

### Sync Flow

```
┌────────────────────────────────────────────────┐
│ INITIALIZATION                                 │
│ store.initialize() → provider.getState()       │
│                      ↓                         │
│                _syncFromProvider(data)         │
└────────────────────────────────────────────────┘
                      ↓
┌────────────────────────────────────────────────┐
│ EXTERNAL CHANGES                               │
│ store.setupSubscription() → provider.onChange()│
│                      ↓                         │
│ External Event → _syncFromProvider(data)       │
└────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Internal Sync Method

```typescript
.actions(self => ({
  // Internal: underscore prefix
  _syncFromProvider(items: Item[] | null, timestamp: number | null) {
    if (items !== null) {
      self.itemCollection.clear()
      for (const item of items) {
        self.itemCollection.add(item)
      }
    }
    if (timestamp !== null) {
      self.lastSyncTime = timestamp
    }
  }
}))
```

#### 2. Initialize Action

```typescript
.actions(self => ({
  async initialize() {
    const env = getEnv<IEnv>(self)

    try {
      const state = await env.services.provider.getCurrentState()
      self._syncFromProvider(state.items, state.timestamp)
      return { success: true }
    } catch (error) {
      return { success: false, error }
    }
  }
}))
```

#### 3. Subscription Setup

```typescript
.actions(self => ({
  setupProviderSubscription(): () => void {
    const env = getEnv<IEnv>(self)

    const unsubscribe = env.services.provider.onStateChange(
      (event, data) => {
        switch (event) {
          case 'ITEM_UPDATED':
            self._syncFromProvider([data.item], data.timestamp)
            break
          case 'ITEM_DELETED':
            self.itemCollection.remove(data.itemId)
            break
          case 'FULL_SYNC':
            self._syncFromProvider(data.items, data.timestamp)
            break
        }
      }
    )

    return unsubscribe  // Return cleanup function
  }
}))
```

---

## Anti-Patterns

### ❌ Sync Without Clearing Stale Data

```typescript
// BAD: Duplicates accumulate
_syncFromProvider(items: Item[]) {
  for (const item of items) {
    self.itemCollection.add(item)
  }
}

// GOOD: Clear before full sync
_syncFromProvider(items: Item[] | null) {
  if (items !== null) {
    self.itemCollection.clear()
    for (const item of items) {
      self.itemCollection.add(item)
    }
  }
}
```

### ❌ Not Handling Subscription Cleanup

```typescript
// BAD: Memory leak
useEffect(() => {
  store.setupSubscription()
}, [])

// GOOD: Cleanup on unmount
useEffect(() => {
  const unsubscribe = store.setupSubscription()
  return unsubscribe
}, [])
```

### ❌ Subscribing Before Initialize

```typescript
// BAD: Events reference unknown entities
store.setupSubscription()
store.initialize()

// GOOD: Initialize first
await store.initialize()
store.setupSubscription()
```

---

## Checklist

- [ ] `_syncFromProvider()` handles both full and partial updates
- [ ] `initialize()` fetches and syncs initial state
- [ ] `setupSubscription()` returns unsubscribe function
- [ ] Connection status tracked for UI feedback
- [ ] Error handling in all sync paths
