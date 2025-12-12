# Getting Started

This guide walks you through setting up the Shogo AI monorepo for development.

## Prerequisites

- **Bun 1.2.20+** — Package manager and runtime ([install](https://bun.sh))
- **Node 18+** — Runtime compatibility
- **Git** — Version control

Verify Bun is installed:

```bash
bun --version  # Should show 1.2.20 or higher
```

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd shogo-ai

# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test
```

All tests should pass on a fresh clone.

## Development Workflows

### MCP Server Development

```bash
cd packages/mcp

# FastMCP inspector (interactive debugging UI)
bun run dev

# Stdio transport (for Claude Code integration)
bun run start

# HTTP transport (for browser/web clients)
bun run start:http
```

The FastMCP inspector opens in your browser with a UI for testing all 16 MCP tools.

### Web App Development

```bash
cd apps/web
bun run dev
```

Opens at http://localhost:3001 with three integration demos:
- Unit 1: Direct MST store usage
- Unit 2: Meta-store with Sandpack
- Unit 3: Conversational builder

### Full Monorepo

From the root directory:

```bash
bun run dev  # Runs all packages via Turbo
```

## Root Commands

| Command | Description |
|---------|-------------|
| `bun install` | Install all dependencies |
| `bun run build` | Build all packages (topologically sorted) |
| `bun run test` | Run all tests |
| `bun run dev` | Run all dev servers |
| `bun run typecheck` | Type check all packages |
| `bun run lint` | Lint all packages |

## Project Structure

| Path | Package | Purpose |
|------|---------|---------|
| `packages/state-api/` | @shogo/state-api | Schema-to-MST transformation |
| `packages/mcp/` | @shogo/mcp | MCP server with 16 tools |
| `apps/web/` | @shogo/web | React demo app |
| `.claude/skills/` | — | AI skill definitions |
| `.schemas/` | — | Persisted schema storage |

## First Steps

1. **Verify setup**: `bun run test` should pass
2. **Run web demo**: `cd apps/web && bun run dev`
3. **Explore MCP tools**: `cd packages/mcp && bun run dev`
4. **Read architecture**: [Architecture](ARCHITECTURE.md)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `bun: command not found` | Install: `curl -fsSL https://bun.sh/install \| bash` |
| Build failures | `bun install` then `bun run build` |
| Port in use | Kill process on port 5173 or 6274 |

## Next Steps

- [Architecture](ARCHITECTURE.md) — System design
- [Concepts](CONCEPTS.md) — Key abstractions
- [MCP Tools Reference](api/MCP_TOOLS.md) — All 16 tools
