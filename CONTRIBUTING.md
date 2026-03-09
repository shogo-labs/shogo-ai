# Contributing to Shogo AI

Contributions are welcome. This guide covers development setup, review
expectations, and the legal requirements for contributing to the open source
repository.

## Before You Contribute

### Contributor License Agreement

Because Shogo is offered under both open source and commercial licensing
models, all external contributors must agree to the project's Contributor
License Agreement before a pull request can be merged.

By contributing, you confirm that:

- You wrote the contribution yourself or have the right to submit it
- You are allowed to license the contribution to Shogo Technologies, Inc.
- You agree that your contribution may be redistributed under the repository
  license and used in commercial editions of Shogo

The agreement text lives in `CLA.md`. Pull requests may be blocked until the
required CLA check is satisfied.

### Community Expectations

Please keep contributions focused, well-scoped, and documented. Security issues
should be reported privately according to `SECURITY.md`, not filed as public
issues.

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

Before opening a pull request, make sure you have read:

- `LICENSE`
- `CLA.md`
- `SECURITY.md`
- `TRADEMARK.md`

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
3. Ensure the CLA requirement is satisfied
4. Run: `bun run test`
5. Run: `bun run typecheck`
6. Run: `bun run build`
7. All must pass

### PR Guidelines

- Link related issues
- Write clear commit messages
- Include tests for new features
- Update docs if needed
- Keep pull requests narrowly scoped
- Describe any schema, env, or deployment changes
- Confirm whether the change affects self-hosting, cloud-only behavior, or the SDK

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
- [Security Policy](SECURITY.md)
- [Trademark Policy](TRADEMARK.md)
