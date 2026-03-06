# Contributing to Shogo AI

Contributions are welcome! This guide covers development setup and conventions.

## Development Setup

### Prerequisites

- **Bun 1.2.20+** — Required package manager ([install](https://bun.sh))
- **Node 18+** — Runtime compatibility
- **Git** — Version control

### Quick Start

```bash
git clone <repo-url>
cd shogo-ai
bun install
bun run build
bun run test
```

## Code Style

- **TypeScript** with strict mode enabled
- **ESNext** target and module system
- Package scope: `@shogo/*`
- Modular file organization (e.g., `schematic/`, `meta/`, `persistence/`)

## Testing

Tests use Bun's native test runner.

```bash
# All tests
bun run test

# Single package
bun test --cwd packages/agent-runtime

# Single file
bun test packages/agent-runtime/src/__tests__/example.test.ts
```

Tests live in `src/**/*.test.ts` files. All tests must pass before merging.

## Building

```bash
# All packages (Turbo handles dependency order)
bun run build

# Type check
bun run typecheck

# Lint
bun run lint
```

Build outputs go to `dist/` directories.

## PR Process

Before submitting:

1. Create a feature branch from `main`
2. Make changes
3. Run: `bun run test`
4. Run: `bun run typecheck`
5. Run: `bun run build`
6. All must pass

### PR Guidelines

- Link related issues
- Write clear commit messages
- Include tests for new features
- Update docs if needed

### Commit Messages

Use conventional commits:

```
feat(api): add workspace invitation endpoint
fix(api): handle missing schema error
docs: update ARCHITECTURE.md
```

## Project Structure

| Path | Purpose |
|------|---------|
| `apps/mobile/` | Expo app (web + iOS + Android) |
| `.claude/skills/` | AI skill definitions |
| `docs/` | Documentation |

## Getting Help

- [Getting Started](docs/GETTING_STARTED.md) — Setup guide
- [Architecture](docs/ARCHITECTURE.md) — System design
- [CLAUDE.md](CLAUDE.md) — Project vision
