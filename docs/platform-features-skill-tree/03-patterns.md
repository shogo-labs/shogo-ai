# Architectural Patterns

The platform-feature pipeline generates code following 7 architectural patterns. These patterns ensure consistency, testability, and maintainability across all features.

## Why Patterns Matter

Patterns provide:
- **Consistency**: Every feature follows the same structure
- **Testability**: Mock services enable isolated unit tests
- **Maintainability**: Clear boundaries between layers
- **Reuse**: Domain logic works across web, MCP, tests

When reviewing generated code, these patterns help you understand:
- Why files are organized a certain way
- Where different types of logic belong
- How components connect

---

## Pattern Overview

| # | Pattern | Purpose | Key Insight |
|---|---------|---------|-------------|
| 1 | Isomorphism | Package placement | Domain logic ≠ React code |
| 2 | Service Interface | Abstraction | External APIs behind domain types |
| 3 | Environment Extension | Dependency injection | Services via `getEnv()` |
| 4 | Enhancement Hooks | Domain logic | Views/actions on MST models |
| 5 | Mock Service Testing | TDD enablement | In-memory service implementations |
| 6 | Provider Synchronization | External state | Sync external data into MST |
| 7 | React Context Integration | UI connection | Wrap stores for React access |

---

## Pattern 1: Isomorphism (Package Placement)

> Domain logic belongs in `packages/state-api` for reuse across consumers.

### The Split

Code that can run outside a browser lives in `packages/state-api`. Only React-specific code lives in `apps/web`.

| Component | Package | Path |
|-----------|---------|------|
| `I{Domain}Service` | state-api | `src/{domain}/types.ts` |
| `{Provider}Service` | state-api | `src/{domain}/{provider}.ts` |
| `MockService` | state-api | `src/{domain}/mock.ts` |
| `domain.ts` | state-api | `src/{domain}/domain.ts` |
| `{Domain}Context.tsx` | apps/web | `src/contexts/{Domain}Context.tsx` |
| UI Components | apps/web | `src/components/{Domain}/*.tsx` |

### Why This Matters

- **MCP access**: Tools can use domain logic directly
- **Testing**: Unit tests without React dependencies
- **Reuse**: CLI tools, other apps can import domain logic

### Decision Checklist

Before placing code, ask:
- Does this have React imports? → `apps/web`
- Is this a service interface or implementation? → `state-api`
- Is this an MST store or ArkType schema? → `state-api`
- Could MCP or a test use this directly? → `state-api`

### Anti-Pattern

❌ "This feature is only used in web app, so put it all in apps/web"

Reality: The SERVICE is platform-agnostic. Only the UI layer is web-specific.

### Auth Example

```
packages/state-api/src/auth/
├── types.ts          # IAuthService interface
├── supabase.ts       # SupabaseAuthService
├── mock.ts           # MockAuthService
└── domain.ts         # AuthDomain + createAuthStore()

apps/web/src/
├── contexts/AuthContext.tsx   # React provider
└── pages/AuthDemoPage.tsx     # UI components
```

---

## Pattern 2: Service Interface

> Abstract external providers behind domain-focused interfaces.

### Structure

```
packages/state-api/src/{domain}/
├── types.ts        # Interface + domain types (NO runtime imports)
├── {provider}.ts   # Production implementation
├── mock.ts         # Mock implementation
└── index.ts        # Barrel exports
```

### Requirements

**types.ts**:
- Pure TypeScript types only
- NO imports from provider SDKs
- NO runtime code
- Methods return domain types (not provider types)

**{provider}.ts**:
- Implements the interface
- Maps provider types ↔ domain types
- Contains all provider-specific logic

**mock.ts**:
- Full interface implementation (not stubs)
- In-memory storage
- Configurable behavior

### Anti-Patterns

❌ Leaking provider types:
```typescript
// BAD: Provider types in interface
import { SupabaseSession } from '@supabase/supabase-js'
export interface IAuthService {
  getSession(): Promise<SupabaseSession>
}
```

✅ Domain types only:
```typescript
// GOOD: Domain types
export interface AuthSession {
  accessToken: string
  user: AuthUser
}
export interface IAuthService {
  getSession(): Promise<AuthSession | null>
}
```

### Auth Example

```typescript
// types.ts - NO runtime imports
export interface IAuthService {
  signUp(credentials: AuthCredentials): Promise<AuthSession>
  signIn(credentials: AuthCredentials): Promise<AuthSession>
  signOut(): Promise<void>
  getSession(): Promise<AuthSession | null>
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void
}
```

---

## Pattern 3: Environment Extension

> Inject services into MST stores via environment for dependency injection.

### Structure

```typescript
// environment/types.ts
export interface IEnvironment {
  services: {
    persistence: IPersistenceService
  }
  context: {
    schemaName: string
    location?: string
  }
}

// Extend for domain-specific services
export interface IAuthEnvironment extends IEnvironment {
  services: IEnvironment['services'] & {
    auth: IAuthService
  }
}
```

### Accessing Services in MST

```typescript
import { getEnv } from 'mobx-state-tree'

.actions(self => ({
  async signIn(credentials: AuthCredentials) {
    const env = getEnv<IAuthEnvironment>(self)
    const authService = env.services.auth
    const session = await authService.signIn(credentials)
    self.syncFromServiceSession(session)
  }
}))
```

### Creating Store with Environment

```typescript
const env: IAuthEnvironment = {
  services: {
    persistence: new NullPersistence(),
    auth: new SupabaseAuthService(supabaseClient)
  },
  context: { schemaName: 'auth' }
}

const store = createAuthStore().createStore(env)
```

### Anti-Patterns

❌ Direct service import:
```typescript
// BAD: Not using DI
import { supabaseClient } from '@supabase/supabase-js'
.actions(self => ({
  async signIn() {
    await supabaseClient.auth.signIn(...)  // Direct import!
  }
}))
```

✅ Environment access:
```typescript
// GOOD: DI via environment
.actions(self => ({
  async signIn(credentials) {
    const env = getEnv<IAuthEnvironment>(self)
    await env.services.auth.signIn(credentials)
  }
}))
```

---

## Pattern 4: Enhancement Hooks

> Add domain-specific views and actions to auto-generated MST models.

### The Three Hooks

| Hook | Level | Purpose |
|------|-------|---------|
| `enhanceModels` | Entity | Computed views on entities |
| `enhanceCollections` | Collection | Query methods, persistence |
| `enhanceRootStore` | Store | Domain actions, initialization |

### Hook Execution Order

```
ArkType Scope
    ↓
createStoreFromScope(scope, options)
    ↓
1. enhanceModels(models)         ← Add views to entities
    ↓
2. enhanceCollections(collections) ← Add methods, compose mixins
    ↓
3. enhanceRootStore(RootModel)   ← Add domain actions
    ↓
{ createStore }
```

### enhanceModels Example

```typescript
enhanceModels: (models) => ({
  ...models,  // Always spread all models!
  AuthSession: models.AuthSession.views((self) => ({
    get isExpired(): boolean {
      return Date.now() > new Date(self.expiresAt).getTime()
    }
  }))
})
```

### enhanceRootStore Example

```typescript
enhanceRootStore: (RootModel) => RootModel
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
    }
  }))
  .actions((self) => ({
    async initialize() {
      const env = getEnv<IAuthEnvironment>(self)
      const session = await env.services.auth.getSession()
      if (session) {
        self.syncFromServiceSession(session)
      }
    },
    async signIn(credentials) {
      const env = getEnv<IAuthEnvironment>(self)
      const session = await env.services.auth.signIn(credentials)
      self.syncFromServiceSession(session)
    }
  }))
```

### Anti-Patterns

❌ Forgetting to return all models:
```typescript
// BAD: Lost other models
enhanceModels: (models) => ({
  AuthSession: models.AuthSession.views(...)
  // AuthUser is now undefined!
})
```

❌ Side effects in views:
```typescript
// BAD: View with side effect
.views(self => ({
  get isExpired() {
    self.lastChecked = Date.now()  // Side effect!
    return ...
  }
}))
```

---

## Pattern 5: Mock Service Testing

> Test MST stores with mock service implementations for reliable TDD.

### Mock Requirements

| Requirement | Purpose |
|-------------|---------|
| Full interface | Catch contract violations |
| In-memory storage | Predictable, fast, isolated |
| Configurable behavior | Test success/failure/edge cases |
| Inspection helpers | Assert what was called |
| Reset method | Clean state between tests |

### Mock Template

```typescript
export class MockAuthService implements IAuthService {
  private sessions: Map<string, AuthSession> = new Map()
  private calls: { method: string; args: any[] }[] = []
  
  constructor(private config: {
    simulateFailure?: boolean
    initialSession?: AuthSession
  } = {}) {}

  async signIn(credentials: AuthCredentials): Promise<AuthSession> {
    this.calls.push({ method: 'signIn', args: [credentials] })
    
    if (this.config.simulateFailure) {
      throw new Error('Invalid credentials')
    }
    
    const session = createMockSession(credentials.email)
    this.sessions.set(session.accessToken, session)
    return session
  }

  // Inspection helpers
  getCalls(method?: string) {
    return method 
      ? this.calls.filter(c => c.method === method)
      : this.calls
  }

  clear() {
    this.sessions.clear()
    this.calls = []
  }
}
```

### Test Setup

```typescript
describe('AuthStore', () => {
  let store: any
  let mockAuth: MockAuthService

  beforeEach(() => {
    mockAuth = new MockAuthService()
    const env = {
      services: { persistence: new NullPersistence(), auth: mockAuth },
      context: { schemaName: 'test' }
    }
    store = createAuthStore().createStore(env)
  })

  test('signIn delegates to auth service', async () => {
    await store.signIn({ email: 'test@example.com', password: 'pass' })
    
    expect(mockAuth.getCalls('signIn')).toHaveLength(1)
    expect(store.isAuthenticated).toBe(true)
  })
})
```

---

## Pattern 6: Provider Synchronization

> Sync external provider state into MST store reactively.

### Sync Flow

```
INITIALIZATION
store.initialize() → provider.getState()
                    ↓
              _syncFromProvider(data)

EXTERNAL CHANGES
provider.onStateChange() → callback
                          ↓
                    _syncFromProvider(data)
```

### Implementation

```typescript
.actions(self => ({
  // Internal sync method
  syncFromServiceSession(session: ServiceAuthSession) {
    self.authUserCollection.clear()
    self.authSessionCollection.clear()
    
    const user = self.authUserCollection.add({
      id: session.user.id,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
    })
    
    self.authSessionCollection.add({
      id: crypto.randomUUID(),
      userId: user.id,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    })
  },

  // Initialize from provider
  async initialize() {
    const env = getEnv<IAuthEnvironment>(self)
    const session = await env.services.auth.getSession()
    if (session) {
      self.syncFromServiceSession(session)
    }
  }
}))
```

### Subscription Cleanup

```typescript
// In React context
useEffect(() => {
  const unsubscribe = authService.onAuthStateChange((session) => {
    if (session) {
      store.syncFromServiceSession(session)
    } else {
      store.clearAuthState()
    }
  })
  
  return () => unsubscribe()  // Cleanup on unmount
}, [])
```

---

## Pattern 7: React Context Integration

> Wrap MST store in React context with proper lifecycle management.

### Key Requirements

| Requirement | How |
|-------------|-----|
| Single store instance | `useRef` (not `useState`) |
| Async initialization | `useEffect` with loading state |
| Subscription cleanup | Return cleanup from `useEffect` |
| Reactive updates | `observer()` wrapper on components |

### Provider Template

```typescript
export function AuthProvider({ authService, children }: AuthProviderProps) {
  const contextRef = useRef<{ store: any } | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Create store synchronously (not in useEffect)
  if (!contextRef.current) {
    const env = {
      services: { persistence: new NullPersistence(), auth: authService },
      context: { schemaName: 'auth' }
    }
    const store = createAuthStore().createStore(env)
    contextRef.current = { store }
  }

  // Initialize and subscribe
  useEffect(() => {
    const store = contextRef.current?.store
    if (!store) return

    unsubscribeRef.current = authService.onAuthStateChange((session) => {
      if (session) {
        store.syncFromServiceSession(session)
      } else {
        store.clearAuthState()
      }
    })

    store.initialize()

    return () => {
      unsubscribeRef.current?.()
    }
  }, [authService])

  return (
    <AuthContext.Provider value={contextRef.current}>
      {children}
    </AuthContext.Provider>
  )
}
```

### Custom Hook

```typescript
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context.store
}
```

### Observer Components

```typescript
import { observer } from 'mobx-react-lite'

const AuthStatus = observer(function AuthStatus() {
  const auth = useAuth()
  
  if (auth.isAuthenticated) {
    return <div>Welcome, {auth.currentUser.email}</div>
  }
  
  return <button onClick={() => auth.signIn(credentials)}>Sign In</button>
})
```

### Anti-Patterns

❌ `useState` for store:
```typescript
// BAD: Store may be recreated
const [store] = useState(() => createStore(env))
```

❌ Missing `observer()`:
```typescript
// BAD: Won't react to changes
function Status() {
  const auth = useAuth()
  return <div>{auth.isAuthenticated}</div>  // Never updates!
}
```

---

## Auth Example: Pattern Mapping

Here's where each pattern appears in the generated auth feature:

| Pattern | Auth Files |
|---------|------------|
| 1. Isomorphism | Domain in state-api, Context in apps/web |
| 2. Service Interface | `types.ts` (IAuthService), `supabase.ts`, `mock.ts` |
| 3. Environment Extension | `getEnv<IEnvironment>()` in domain.ts actions |
| 4. Enhancement Hooks | `enhanceModels`, `enhanceRootStore` in domain.ts |
| 5. Mock Service Testing | `MockAuthService` with configurable behavior |
| 6. Provider Synchronization | `syncFromServiceSession()`, `onAuthStateChange()` |
| 7. React Context Integration | `AuthContext.tsx` with `useRef`, `useEffect` cleanup |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        apps/web                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │  AuthContext.tsx │  │ AuthDemoPage.tsx │  │  Components   │ │
│  │  (Pattern 7)     │  │                  │  │               │ │
│  └────────┬─────────┘  └──────────────────┘  └───────────────┘ │
│           │ useAuth()                                           │
└───────────┼─────────────────────────────────────────────────────┘
            │
            │ imports
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/state-api                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  src/auth/domain.ts                                       │  │
│  │  ├─ AuthDomain (ArkType scope)                           │  │
│  │  └─ createAuthStore()                                    │  │
│  │      ├─ enhanceModels (Pattern 4)                        │  │
│  │      ├─ enhanceCollections (Pattern 4)                   │  │
│  │      └─ enhanceRootStore (Pattern 4)                     │  │
│  │           └─ getEnv() (Pattern 3)                        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │   types.ts     │  │  supabase.ts   │  │    mock.ts     │   │
│  │  IAuthService  │  │SupabaseAuth... │  │MockAuthService │   │
│  │  (Pattern 2)   │  │  (Pattern 2)   │  │  (Pattern 5)   │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  src/environment/types.ts                                 │  │
│  │  IEnvironment + extensions (Pattern 3)                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
            │
            │ integrates with
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Provider                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Supabase Auth API                                        │  │
│  │  ├─ onAuthStateChange() (Pattern 6)                      │  │
│  │  └─ signIn(), signOut(), getSession()                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Pattern Applicability by Feature Type

| Feature Archetype | Required Patterns | Optional Patterns |
|-------------------|-------------------|-------------------|
| **Service** (external integration) | 1, 2, 3, 4, 5, 6, 7 | — |
| **Domain** (business logic) | 1, 4 | 7 |
| **Infrastructure** (internal services) | 1, 2, 3, 5 | 4 |
| **Hybrid** (service + complex domain) | All | — |

Auth is a **Service** archetype, so all 7 patterns apply.
