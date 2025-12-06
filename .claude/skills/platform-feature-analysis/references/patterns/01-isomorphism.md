# Pattern 1: Isomorphism (Package Placement)

> Domain logic belongs in `packages/state-api` for reuse across consumers (web, mcp, tests).

## Core Principle

Code that can run outside a web browser should live in `packages/state-api`. Only React-specific code belongs in `apps/web`.

This enables:
- **MCP access**: Tools can use domain logic directly
- **Testing**: Unit tests without React dependencies
- **Reuse**: CLI tools, other apps can import domain logic
- **Separation**: Clear boundary between domain and presentation

---

## The Split

| Component | Package | Path | Why |
|-----------|---------|------|-----|
| `I{Domain}Service` | state-api | `src/{domain}/types.ts` | Interface has no runtime deps, shareable |
| `{Provider}Service` | state-api | `src/{domain}/{provider}.ts` | Implementation swappable per consumer |
| `MockService` | state-api | `src/{domain}/mock.ts` | Enables testing without real provider |
| `domain.ts` | state-api | `src/{domain}/domain.ts` | ArkType scope + MST store, isomorphic |
| `{Domain}Context.tsx` | apps/web | `src/contexts/{Domain}Context.tsx` | React-specific provider |
| `use{Domain}.ts` | apps/web | `src/hooks/use{Domain}.ts` | React hook, web-only |
| UI components | apps/web | `src/components/{Domain}/*.tsx` | React components, web-only |
| Pages | apps/web | `src/pages/{Domain}Page.tsx` | Route pages, web-only |

---

## Decision Checklist

Before recommending package placement in findings, ask:

- [ ] Does this have React imports? → `apps/web`
- [ ] Is this a service interface or implementation? → `state-api`
- [ ] Is this an MST store or ArkType schema? → `state-api`
- [ ] Could MCP or a test use this directly? → `state-api`
- [ ] Is this a UI component or React hook? → `apps/web`
- [ ] Does it manage DOM, events, or rendering? → `apps/web`

**When in doubt**: If it could theoretically work in Node.js without React, it belongs in `state-api`.

---

## Anti-Patterns

### ❌ "Feature X is web-app specific"

**Wrong thinking**: "This feature is only used in the web app, so put it all in apps/web"

**Reality**: The SERVICE is platform-agnostic. Only the UI layer (context, hooks, components) is web-specific.

**Example**: An inventory feature:
- ❌ All in `apps/web/src/inventory/` - can't test without React, can't use from MCP
- ✅ Domain in `packages/state-api/src/inventory/`, UI in `apps/web/src/`

### ❌ "Keep in apps/web for simplicity"

**Wrong thinking**: "It's simpler to keep everything together"

**Reality**: This breaks reuse across consumers and couples domain logic to React.

**Consequence**: When you want MCP tools for the feature, you have to refactor.

### ❌ Provider client in apps/web

**Wrong thinking**: "The Supabase/Stripe/etc client is only used from the web app"

**Reality**: The provider client should be in state-api so MCP and tests can use it.

**Pattern**: Create the client in state-api, pass it to the service implementation.

---

## Example: Correct Package Split

For an "inventory" feature:

```
packages/state-api/src/inventory/
├── types.ts          # IInventoryService interface
├── supabase.ts       # SupabaseInventoryService
├── mock.ts           # MockInventoryService
├── domain.ts         # InventoryDomain scope + createInventoryStore()
├── index.ts          # Barrel exports
└── __tests__/
    ├── mock.test.ts      # Service tests
    └── store.test.ts     # Domain logic tests

apps/web/src/
├── contexts/
│   └── InventoryContext.tsx   # React provider
├── hooks/
│   └── useInventory.ts        # React hook
├── components/
│   └── Inventory/
│       ├── ProductList.tsx
│       └── StockLevel.tsx
└── pages/
    └── InventoryPage.tsx
```

---

## Finding Recommendations

When creating `AnalysisFinding` entities, ensure recommendations include explicit package placement:

**Good recommendation:**
> "Create IInventoryService interface in `packages/state-api/src/inventory/types.ts`. The React context goes in `apps/web/src/contexts/InventoryContext.tsx`."

**Bad recommendation:**
> "Create an inventory service. For now, keep at React layer since it's web-app specific."

Always be explicit about the split between state-api and apps/web.

---

## Checklist for Findings

Before creating a finding with placement recommendations:

- [ ] Service interface → explicitly says `state-api`
- [ ] Service implementations → explicitly says `state-api`
- [ ] Domain store → explicitly says `state-api`
- [ ] React context/hooks → explicitly says `apps/web`
- [ ] Never recommends "keep in web app for simplicity"
