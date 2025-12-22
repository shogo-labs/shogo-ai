# Pattern 6: React Context Integration

> Use `DomainProvider` and `useDomains()` for React-MST integration — no per-domain context needed.

## Concept

React components need access to MST stores with:

1. Single store instance (not recreated on re-render)
2. Automatic data loading on mount
3. Reactive updates when store state changes
4. Type-safe access to multiple domains

The `DomainProvider` + `useDomains()` pattern handles all of this centrally — **do not create custom context providers per domain**.

---

## When to Apply

Apply this pattern when:

- [ ] Feature has React UI components
- [ ] Multiple components need access to domain stores
- [ ] Store needs data loading from persistence on mount
- [ ] Feature adds a new domain to the app

**Key Point**: You only need to add your domain to the existing `DomainProvider` — never create a new context file.

---

## Structure

### Two-Layer Provider Stack

```
EnvironmentProvider     ← Services (persistence, auth) + workspace
        ↓
   DomainProvider       ← Map of domain results → stores
        ↓
      App/Routes        ← Components use useDomains()
```

### App Setup (One-Time)

The app sets up both providers once in `App.tsx`:

```tsx
// App.tsx
import { EnvironmentProvider, createEnvironment } from './contexts/EnvironmentContext'
import { DomainProvider } from './contexts/DomainProvider'
import { teamsDomain, createBackendRegistry } from '@shogo/state-api'
import { MCPPersistence } from './persistence/MCPPersistence'
import { MCPBackend } from './query/MCPBackend'
import { mcpService } from './services/mcp'

// Create MCP-backed backend registry for SQL query execution
const mcpBackend = new MCPBackend(mcpService, import.meta.env.VITE_WORKSPACE)
const backendRegistry = createBackendRegistry({
  default: 'postgres',
  backends: { postgres: mcpBackend }
})

// Create environment with services
const env = createEnvironment({
  persistence: new MCPPersistence(mcpService),  // For schema loading
  backendRegistry,  // For SQL query execution
  workspace: import.meta.env.VITE_WORKSPACE,
})

// Register all domains (add new domains here)
const domains = {
  teams: teamsDomain,
  // inventory: inventoryDomain,  ← Add new domains as needed
} as const

export function App() {
  return (
    <EnvironmentProvider env={env}>
      <DomainProvider domains={domains}>
        <Routes>
          <Route path="/teams-demo" element={<TeamsDemoPage />} />
          {/* ... */}
        </Routes>
      </DomainProvider>
    </EnvironmentProvider>
  )
}
```

### Component Usage

```tsx
// pages/TeamsDemoPage.tsx
import { observer } from 'mobx-react-lite'
import { useDomains } from '../contexts/DomainProvider'

export const TeamsDemoPage = observer(function TeamsDemoPage() {
  // Destructure domains from hook — type-safe!
  const { teams } = useDomains()

  // Collections are already loaded by DomainProvider
  const orgs = teams.organizationCollection.all()

  // Use query methods from enhancements.collections
  const myMemberships = teams.membershipCollection.findByUserId(userId)

  // Use domain actions from enhancements.rootStore
  const handleCreateOrg = async () => {
    await teams.createOrganization({ name: 'New Org' })
  }

  return (
    <div>
      <h1>Organizations ({orgs.length})</h1>
      <ul>
        {orgs.map(org => (
          <li key={org.id}>{org.name}</li>
        ))}
      </ul>
      <button onClick={handleCreateOrg}>Create Organization</button>
    </div>
  )
})
```

---

## Adding a New Domain

When implementing a new domain feature, you only need to:

### 1. Create domain.ts with domain() API

```typescript
// packages/state-api/src/inventory/domain.ts
import { scope } from "arktype"
import { domain } from "@shogo/state-api"

export const InventoryDomain = scope({ /* entities */ })

// CRITICAL: name must match schema name from design skill
export const inventoryDomain = domain({
  name: "inventory",  // Must match .schemas/inventory/schema.json
  from: InventoryDomain,
  enhancements: { /* ... */ }
})
```

### 2. Add to DomainProvider domains map

```tsx
// App.tsx
import { inventoryDomain } from '@shogo/state-api'

const domains = {
  teams: teamsDomain,
  inventory: inventoryDomain,  // ← Add here
} as const
```

### 3. Use in components

```tsx
const { inventory } = useDomains()
const products = inventory.productCollection.all()
```

**That's it!** No context file, no provider, no custom hook.

---

## Task Template for Demo Page

When creating a demo page task, use these acceptance criteria:

```javascript
store.create("ImplementationTask", "platform-features", {
  id: "task-demo-page",
  name: "demo-page",
  session: session.id,
  description: "Create {domain} demo page with useDomains()",
  acceptanceCriteria: [
    // DomainProvider Integration
    "Domain added to App.tsx DomainProvider domains map",
    "Page uses useDomains() to access store (NOT custom context)",

    // Demo Functionality
    "Demonstrates CRUD operations for primary entities",
    "Shows computed views from enhancements.models",
    "Shows query methods from enhancements.collections",
    "Shows domain actions from enhancements.rootStore",

    // Persistence
    "Data survives page refresh (SQL backend hydration via query().toArray())",
    "Environment includes backendRegistry with MCPBackend",

    // Routing
    "Accessible at /{domain}-demo route"
  ],
  dependencies: ["task-domain-store"],
  status: "planned",
  createdAt: Date.now()
})
```

---

## How DomainProvider Works

The provider handles:

1. **Store Creation**: Creates store from each domain result with environment injection
2. **Collection Discovery**: Finds all `*Collection` properties on the root store
3. **Auto Loading**: Calls `query().toArray()` on each collection on mount (uses backendRegistry)
4. **Stable References**: Uses `useRef` to maintain single store instances

```tsx
// Simplified DomainProvider implementation
function DomainProvider<T extends Record<string, DomainResult>>({
  domains,
  children,
}: {
  domains: T
  children: ReactNode
}) {
  const env = useEnv()
  const storesRef = useRef<Map<string, any>>()

  // Create stores once
  if (!storesRef.current) {
    storesRef.current = new Map()
    for (const [key, domain] of Object.entries(domains)) {
      const store = domain.createStore({
        ...env,
        context: { ...env.context, schemaName: domain.name }
      })
      storesRef.current.set(key, store)
    }
  }

  // Auto-load all collections on mount using query() API
  useEffect(() => {
    const loadCollections = async () => {
      for (const store of storesRef.current!.values()) {
        // Find all *Collection properties and call query().toArray()
        for (const key of Object.keys(store)) {
          if (key.endsWith('Collection') && store[key].query) {
            // query().toArray() routes through backendRegistry
            // Results auto-sync to MST via syncFromRemote callback
            await store[key].query().toArray()
          }
        }
      }
    }
    loadCollections()
  }, [])

  return (
    <DomainContext.Provider value={Object.fromEntries(storesRef.current)}>
      {children}
    </DomainContext.Provider>
  )
}
```

---

## Anti-Patterns

### ❌ Creating Custom Context Per Domain

```tsx
// BAD: Custom context for each domain
export const InventoryContext = createContext<Store | null>(null)
export function InventoryProvider({ children }) { ... }
export function useInventory() { ... }

// GOOD: Use shared DomainProvider
const domains = {
  inventory: inventoryDomain,  // Just add to map
}
```

### ❌ Manual Data Loading in Components

```tsx
// BAD: Loading in component
useEffect(() => {
  teams.organizationCollection.loadAll()
}, [])

// GOOD: DomainProvider handles loading automatically
const { teams } = useDomains()
const orgs = teams.organizationCollection.all()  // Already loaded!
```

### ❌ Missing Observer Wrapper

```tsx
// BAD: Component doesn't react to changes
function Dashboard() {
  const { teams } = useDomains()
  return <div>{teams.organizationCollection.all().length}</div>  // Never updates!
}

// GOOD: observer enables reactivity
const Dashboard = observer(function Dashboard() {
  const { teams } = useDomains()
  return <div>{teams.organizationCollection.all().length}</div>
})
```

### ❌ Missing Backend Registry in Demo Pages

```tsx
// BAD: No query execution - data won't load/save via SQL
const env = createEnvironment({
  persistence: new MCPPersistence(mcpService),
  // Missing backendRegistry!
})

// GOOD: Include backendRegistry for SQL operations
const mcpBackend = new MCPBackend(mcpService, workspace)
const backendRegistry = createBackendRegistry({
  default: 'postgres',
  backends: { postgres: mcpBackend }
})

const env = createEnvironment({
  persistence: new MCPPersistence(mcpService),  // For schema loading
  backendRegistry,  // For SQL query execution
  workspace,
})
```

---

## Backend Configuration by Context

| Context | Backend Registry | Reason |
|---------|-----------------|--------|
| Client-side demos (`apps/web`) | `MCPBackend` registered as 'postgres' | Routes SQL to MCP server |
| Server/CLI contexts | `PostgresExecutor` or `SqliteExecutor` | Direct database access |
| Unit tests | `createBackendRegistry({ default: 'memory' })` | Fast, isolated, in-memory |

**Client demos MUST configure backendRegistry** to prove the full SQL persistence pipeline works.

---

## Checklist

Before considering React integration complete:

- [ ] Domain added to `DomainProvider` domains map in `App.tsx`
- [ ] NO custom context/provider created for this domain
- [ ] Components use `useDomains()` hook to access store
- [ ] Components wrapped with `observer()` for reactivity
- [ ] Environment includes `backendRegistry` (with MCPBackend for demos)
- [ ] Data survives page refresh (verifies SQL persistence pipeline)
- [ ] Route added for demo page (`/{domain}-demo`)
