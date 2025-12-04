# Exploration Patterns by Package

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

**Entry points**:
- `src/index.ts` - Public exports
- `src/schematic/` - Schema transformation
- `src/meta/` - Meta-store system
- `src/persistence/` - Storage abstraction

**Patterns to look for**:
- Schema-to-MST transformation pipeline
- Meta-registry patterns
- Persistence provider interface
- Collection mixins

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

**Entry points**:
- `src/App.tsx` - Root component, routing
- `src/units/` - Demo units (1, 2, 3)
- `src/hooks/` - Shared React hooks
- `src/stores/` - MST store instances

**Patterns to look for**:
- How stores are created and provided
- React context patterns
- Component composition
- State management approach per unit

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
- Reference patterns (`x-mst-type`, `x-reference-target`)
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
