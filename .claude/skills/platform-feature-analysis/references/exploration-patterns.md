# Exploration Patterns by Package

## Isomorphism Check (Apply to All Features)

Before exploring, determine where code should live based on the [Isomorphism Principle](patterns/01-isomorphism.md):

| Code Type | Package | Test |
|-----------|---------|------|
| Service interface (`I{X}Service`) | state-api | Can MCP use it? |
| Service implementation | state-api | No React imports? |
| Domain store (`domain.ts`) | state-api | Can test without React? |
| React context/provider | apps/web | Has React imports? |
| React hooks | apps/web | Uses `useState/useEffect`? |
| UI components | apps/web | Renders JSX? |

**When analyzing a feature, always identify which parts go where BEFORE exploring.**

---

## packages/mcp

**Entry points**:
- `src/index.ts` - Server setup, tool registration
- `src/tools/` - Tool implementations by namespace

**Patterns to look for**:
- Tool registration: `server.tool("name", schema, handler)`
- Namespace grouping: `schema.*`, `store.*`, `view.*`
- Error handling in tool handlers
- How tools access the meta-store

**Key files**:
```
src/
├── index.ts          # Server setup
├── tools/
│   ├── schema.ts     # schema.* tools
│   ├── store.ts      # store.* tools
│   └── view.ts       # view.* tools
└── transports/       # HTTP/stdio setup
```

**Test patterns**: `tests/*.test.ts` - Look for MockMCPServer usage

---

## packages/state-api

**This is where domain logic lives.** All service interfaces, implementations, and domain stores go here.

**Entry points**:
- `src/index.ts` - Public exports
- `src/schematic/` - Schema transformation
- `src/meta/` - Meta-store system
- `src/persistence/` - Storage abstraction
- `src/{domain}/` - Domain-specific modules (types.ts, domain.ts, {provider}.ts, mock.ts)

**Patterns to look for**:
- Schema-to-MST transformation pipeline
- Meta-registry patterns
- Persistence provider interface
- Collection mixins
- **Service interface pattern** - `I{Domain}Service` in `types.ts`
- **Domain store pattern** - `createStoreFromScope` in `domain.ts`

**Key files**:
```
src/
├── schematic/
│   ├── transform.ts        # ArkType → JSON Schema → MST
│   └── enhanced-schema.ts  # x-mst-type handling
├── meta/
│   ├── meta-registry.ts    # Schema introspection
│   └── meta-store.ts       # Meta-store factory
└── persistence/
    ├── types.ts            # Provider interface
    └── filesystem.ts       # FS implementation
```

**Test patterns**: `tests/*.test.ts` - Integration tests with real schemas

---

## apps/web

**This is where React-specific code lives.** Only contexts, hooks, and UI components go here—NOT domain logic.

**Entry points**:
- `src/App.tsx` - Root component, routing
- `src/contexts/` - React contexts wrapping state-api stores
- `src/hooks/` - React hooks for component access
- `src/components/` - UI components
- `src/pages/` - Route pages

**Patterns to look for**:
- How stores are created and provided (imports from state-api)
- React context patterns (`{Domain}Context.tsx`)
- Custom hooks (`use{Domain}.ts`)
- Component composition
- Route protection patterns

**Key files**:
```
src/
├── App.tsx
├── units/
│   ├── unit-1/    # Direct MST usage
│   ├── unit-2/    # Meta-store pattern
│   └── unit-3/    # Conversational builder
├── hooks/
│   └── useStore.ts
└── stores/
    └── index.ts
```

**Test patterns**: Check for `*.test.tsx` or Playwright tests

---

## .claude/skills

**Structure per skill**:
```
skill-name/
├── SKILL.md           # Required - frontmatter + workflow
└── references/        # Optional - detailed guidance
```

**Patterns to look for**:
- Frontmatter triggers (description field)
- Phase structure in workflow
- Wavesmith operations (schema.*, store.*)
- Handoff patterns between skills

**Key files**: Each `SKILL.md` documents its own workflow

---

## .schemas

**Structure**:
```
.schemas/
├── {schema-name}/
│   ├── schema.json           # Enhanced JSON Schema
│   └── {collection}.json     # Persisted data
```

**Patterns to look for**:
- Entity definitions in `$defs`
- Reference patterns (`x-mst-type`, `x-reference-type`, `x-arktype`)
- Collection naming conventions

---

## Common Exploration Commands

```bash
# Find files matching pattern
glob "packages/mcp/src/**/*.ts"

# Search for pattern usage
grep "registerTool" --type ts

# Find test files
glob "**/*.test.ts"

# Find similar implementations
grep "middleware" --type ts -C 3
```
