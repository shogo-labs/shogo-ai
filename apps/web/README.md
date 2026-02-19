# @shogo/web

> React demo app showing Shogo AI integration patterns

Three progressive demo units demonstrating direct MST integration, the meta-system pipeline, and conversational app building.

## Quick Start

```bash
cd apps/web
bun run dev     # Start at http://localhost:5173
```

## Scripts

```bash
bun run dev        # Vite dev server
bun run build      # Production build
bun run preview    # Preview build
bun run typecheck  # Type check
```

## Demo Units

### Unit 1: Direct MST Integration

**Route**: `/unit1`

Raw MobX-State-Tree observer pattern in React. Shows reactive updates when MST state changes without abstraction layers.

### Unit 2: Shogo Meta-System

**Route**: `/unit2`

Complete transformation pipeline in browser:
1. ArkType schema definition
2. Enhanced JSON Schema extraction
3. MST model generation
4. Runtime store with CRUD

All state-api TypeScript files loaded via Vite `?raw` imports. Pure browser execution with Sandpack.

### Unit 3: Conversational Builder

**Route**: `/unit3`

Multi-turn chat with Claude for application generation:
- Describe requirements in natural language
- AI generates schemas and working CRUD UIs
- Real-time app generation with validation

## Architecture

```
src/
├── pages/          # Route components (Unit1Page, Unit2Page, Unit3Page)
├── components/     # Demo implementations
├── contexts/       # State providers
├── hooks/          # useAgentChat, useMCPAgent
└── persistence/    # Browser storage adapters
```

## Documentation

- [Architecture](../../docs/ARCHITECTURE.md)
- [Getting Started](../../docs/GETTING_STARTED.md)
