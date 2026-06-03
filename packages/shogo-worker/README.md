# @shogo-ai/worker

Run Shogo Cloud Agents on a machine you already own — a laptop, devbox, or CI runner.
Outbound-only: the worker dials Shogo Cloud over HTTPS, never the other way around.

> Licensed **MIT**. The agent runtime it spawns is licensed AGPL-3.0-or-later
> and ships as a separate binary — see [Architecture & licensing](#architecture--licensing) below.

## Install

**macOS / Linux**

```bash
curl -fsSL https://install.shogo.ai | bash
```

**Windows (PowerShell)**

```powershell
irm https://install.shogo.ai/ps | iex
```

The installer drops a single self-contained binary at `~/.shogo/bin/shogo`
(`%USERPROFILE%\.shogo\bin\shogo.exe` on Windows), verifies its SHA-256 against
the published sidecar, and adds the bin dir to `PATH`. No Node or Bun on the
target machine required.

### Installer flags

```bash
curl -fsSL https://install.shogo.ai | bash -s -- [flags]

  --channel <stable|beta>   release channel (default: stable)
  --prefix <dir>            install dir (default: $HOME/.shogo/bin)
  --force                   overwrite existing install
  --no-binary               force npm install even if a prebuilt binary exists
```

### Alternate paths

| Method | When to use |
|--------|-------------|
| `npm i -g @shogo-ai/worker` | Node ≥ 20 already on the machine; you want lockstep with `package.json` in a project repo. |
| `gh release download v<X.Y.Z> -p 'shogo-<target>.tar.gz'` from [github.com/shogo-labs/shogo-ai/releases](https://github.com/shogo-labs/shogo-ai/releases) | Air-gapped / proxy-locked environments where `install.shogo.ai` is blocked. |
| `bash packages/shogo-worker/install.sh` from a repo checkout | Self-mirror; pass `SHOGO_RELEASE_HOST=...` to pull tarballs from your own CDN. |

The single binary, the npm package, and the GitHub Release tarballs all ship
from the same `v*` tag, so the version you get is identical regardless of
install method.

## Quick start

```bash
# 1. Sign in (opens your browser; falls back to --api-key for CI)
shogo login

# 2. Download the AGPL agent-runtime binary into ~/.shogo/runtime/
shogo runtime install

# 3. Start the worker (detached by default)
shogo worker start --name my-devbox

# 4. Confirm it's online
shogo worker status

# 5. Open https://studio.shogo.ai — your machine appears in the
#    environment dropdown next to the desktop entries.
```

### Headless / CI

```bash
# Skip the browser flow with a personal API key from
# https://studio.shogo.ai/api-keys
shogo login --api-key "shogo_sk_..."

# Or skip `login` entirely
SHOGO_API_KEY=shogo_sk_... shogo runtime install
SHOGO_API_KEY=shogo_sk_... shogo worker start --foreground
```

## Commands

| Command | What it does |
|---------|--------------|
| `shogo login` | Browser device-code flow against `studio.shogo.ai`. `--api-key` / `SHOGO_API_KEY` for headless. `--workspace <id>` to pre-select. `--no-browser` to print the URL only. |
| `shogo runtime install` | Download + verify + extract the AGPL agent-runtime tarball into `~/.shogo/runtime/`. Flags: `--channel stable\|beta\|nightly`, `--version`, `--force`, `--base-url`. |
| `shogo runtime version` | Print the installed agent-runtime version. |
| `shogo runtime where` | Print the resolved binary path (priority order: `--runtime-bin` → `$SHOGO_AGENT_RUNTIME_BIN` → `~/.shogo/runtime/agent-runtime` → `$PATH`). |
| `shogo runtime update` | Reinstall the latest in-channel build. |
| `shogo worker start` | Pair this machine with Shogo Cloud. `--foreground` to attach to stdout (e.g. `systemd --user`); default detaches and writes `~/.shogo/worker.pid`. |
| `shogo worker stop` | Kill the running worker via PID file. |
| `shogo worker status` | Online / offline + uptime. |
| `shogo worker logs [-f]` | Tail `~/.shogo/logs/worker.log`. |
| `shogo config show` | Print config (API key masked). |
| `shogo config set <key> <value>` | Edit a single key. |
| `shogo doctor` | Repair a wedged local **Shogo Desktop** database (clears failed migrations so the app can boot). Flags: `--check` (detect only), `--yes` (skip prompt), `--db <path>`, `--bun <path>`, `--no-backup`. See [Repair a wedged local Shogo build](#repair-a-wedged-local-shogo-build). |

## Files & layout

```
~/.shogo/
├── config.json        # API key + cloud URL (mode 0600)
├── device-id          # stable per-machine UUID; dedupes re-logins
├── worker.pid         # lifecycle file for `worker start/stop/status`
├── logs/
│   ├── worker.log
│   └── worker.err.log
├── runtime/
│   ├── agent-runtime    # AGPL binary, downloaded by `shogo runtime install`
│   ├── runtime-template/  # Vite/React/Tailwind scaffolding the runtime seeds
│   │                      # into new project workspaces. MUST live next to the
│   │                      # binary — `getRuntimeTemplatePath()` looks here
│   │                      # second (after the `RUNTIME_TEMPLATE_DIR` env
│   │                      # override). The agent-runtime release tarball
│   │                      # ships binary + this directory together.
│   ├── tree-sitter-wasm/  # Tree-sitter parser core + per-language grammars
│   │                      # (`tree-sitter.wasm` + `tree-sitter-${lang}.wasm`).
│   │                      # `bun build --compile` bakes the build-machine path
│   │                      # for these into the binary; we ship the WASMs
│   │                      # next to the binary so it can dlopen them at
│   │                      # runtime regardless of where the operator put it.
│   │                      # The worker also exports
│   │                      # `TREE_SITTER_WASM_DIR=<this dir>` to the spawned
│   │                      # runtime so the resolved location is observable
│   │                      # via `env | grep TREE_SITTER`.
│   └── version.json
└── projects/<projectId>/  # cloned project workspaces (auto-pulled on first
                           # request, override with `--projects-dir` /
                           # `SHOGO_PROJECTS_DIR`)
```

### Workspace seeding (cli-worker)

When the worker spawns the agent-runtime for a project, it MUST point that
runtime at a real on-disk workspace via `WORKSPACE_DIR` / `PROJECT_DIR`.
Three knobs control where that workspace comes from, in priority order:

1. **Auto-pull (default).** On the first inbound request for a project,
   `WorkerRuntimeManager` clones the cloud snapshot into
   `<projectsDir>/<projectId>/`, watches it via `CloudSyncWatcher`, and
   pushes local edits back. No operator action required.
2. **`--projects-dir <path>` / `SHOGO_PROJECTS_DIR=<path>`.** Override the
   root directory under which workspaces live. Useful when you want
   workspaces on a faster disk or backed-up volume.
3. **`shogo project pull <projectId>` (manual pre-pull).** When you've
   passed `--no-auto-pull` (e.g. slow or metered connection), the worker
   refuses to spawn until the canonical workspace exists at
   `<projectsDir>/<projectId>/`. Pre-pulling is how you get there.

If you disable auto-pull and **don't** pre-pull, the worker fails loudly
with a multi-line error pointing you at all three options instead of
silently falling back to an empty workspace.

## Networking

The worker needs outbound HTTPS (TCP 443) to 3 hosts. **No inbound ports required.**

| Host | Purpose | If blocked |
|------|---------|-----------|
| `studio.shogo.ai` | Sign-in, session, heartbeat, on-demand tunnel WS | **FATAL** — worker can't run |
| `api-direct.shogo.ai` | Direct tunnel fallback (when used) | Graceful — edge routing takes over |
| `github.com` / `objects.githubusercontent.com` | Runtime binary downloads (`shogo runtime install`) | Only `runtime install/update` affected; can be self-mirrored via `--base-url` |

### Corporate proxy

```bash
# HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy all honoured
HTTPS_PROXY=http://proxy.corp:3128 shogo worker start

# Or pass explicitly (overrides env)
shogo worker start --proxy http://proxy.corp:3128

# TLS-inspecting proxy needs your corp root CA
NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem \
  HTTPS_PROXY=http://proxy.corp:3128 \
  shogo worker start --debug
```

`shogo worker start --debug` runs a preflight that includes a proxy-reachability
check when `HTTPS_PROXY` is set.

## Architecture & licensing

The worker is split into two processes that talk over localhost only:

```
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│  shogo (this package)              │    │  agent-runtime                     │
│  ── MIT ────────────────────────── │    │  ── AGPL-3.0-or-later ──────────── │
│                                    │    │                                    │
│  • CLI (login / start / stop)      │    │  • Runs your agents                │
│  • WorkerTunnel: HTTP heartbeat +  ├────►  • Tools, LLM proxy, plans         │
│    on-demand WS to Shogo Cloud     │    │                                    │
│  • WorkerRuntimeManager: spawns    │    │                                    │
│    one runtime per project         │    │                                    │
│                                    │    │                                    │
│  Spawned by you / systemd / etc.   │    │  Spawned by the worker (process    │
│                                    │    │  boundary; not linked as library)  │
└────────────────────────────────────┘    └────────────────────────────────────┘
```

The MIT worker discovers and spawns the AGPL runtime as a separate OS process —
no library link, no dynamic import, no embed. This keeps the licenses cleanly
separated: you may consume `@shogo-ai/worker` from MIT / Apache-2.0 / proprietary
code without AGPL infecting it.

The runtime spawns themselves are managed by `WorkerRuntimeManager`: per-project
port allocation, env injection, restart-with-backoff, idle eviction, and health
checks. The same code path is consumed by Shogo Desktop (`apps/api`) for its own
agent runtimes — so any improvement made here ships to both.

### What the cli-worker tunnel does — and doesn't — handle

A cli-worker is an **execution target**: it forwards `/agent/*` paths to
the per-project agent-runtime and nothing else. Stateful data
(`/api/projects`, `/api/chat-sessions`, etc.) lives in Shogo Cloud and
is served by the cloud backend, not by the worker. Studio's
`SDKDomainProvider` checks `instance.kind` and only tunnels stateful
APIs through the desktop adapter; for cli-workers it reads from cloud
directly.

If a request for a non-`/agent/*` path does reach the cli-worker tunnel
(e.g. an out-of-date Studio client), the worker replies with a
structured 502 body so future debuggers can read the rejection without
log access:

```json
{
  "code": "CLI_WORKER_HAS_NO_DATA_API",
  "message": "cli-worker only serves /agent/* paths; tried: /api/projects",
  "path": "/api/projects?workspaceId=ws-1"
}
```

## Programmatic use

Both core classes are exposed for direct embedding (e.g. building your own
desktop wrapper):

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkerTunnel, WorkerRuntimeManager } from '@shogo-ai/worker'

// `WorkerRuntimeManager` refuses to spawn a runtime unless it knows
// where the workspace lives on disk. For embedders that just want
// the cli-worker default behaviour, set `autoPull` and the manager
// will clone each project's workspace from cloud on first request.
// Embedders that manage workspaces themselves should set `projectDir`
// inside `defaultSpawnConfig` (or via `enrichSpawnConfig`) instead.
const runtimeManager = new WorkerRuntimeManager({
  defaultSpawnConfig: {
    cloudUrl: 'https://studio.shogo.ai',
    apiKey: process.env.SHOGO_API_KEY!,
  },
  autoPull: {
    enabled: true,
    projectsDir: join(homedir(), '.shogo', 'projects'),
  },
})

const tunnel = new WorkerTunnel({
  apiKey: process.env.SHOGO_API_KEY!,
  cloudUrl: 'https://studio.shogo.ai',
  resolver: runtimeManager,         // implements RuntimeResolver
  kind: 'cli-worker',
  onAuthRevoked: (reason) => { /* re-login UX */ },
})
tunnel.start()
```

## External triggers

The worker lets external services (Jira, Linear, Zapier, n8n, your own
HTTP clients) send messages to a Shogo agent **running on this machine**,
without exposing any inbound port. Combine `shogo worker start` with a
project pin in Studio (or via the SDK) and the cloud-side
`/api/projects/:id/agent-proxy/*` becomes a stable public URL routed
through the worker's outbound tunnel:

```
External caller ──HTTPS──▶  Shogo Cloud  ──tunnel──▶  shogo worker  ──▶  agent-runtime
                                                                         (this machine)
```

### Pin a project to this machine

From Studio: open the project → **Channels → Run on** → pick this machine.
From a script (uses `@shogo-ai/sdk`):

```ts
import { createClient } from '@shogo-ai/sdk'

const client = createClient({
  apiUrl: 'https://api.shogo.ai',
  shogoApiKey: process.env.SHOGO_API_KEY!,
})

const machines = await client.machines.list({ workspaceId })
const me = machines.find((m) => m.kind === 'cli_worker' && m.name === 'my-devbox')!

await client.machines.pinProject(projectId, {
  instanceId: me.id,
  policy: 'pinned',   // 503 instance_offline if this machine goes down
                      // (use 'prefer' to fall back to a cloud pod instead)
})
```

### Trigger the agent

```bash
curl -X POST \
  "https://api.shogo.ai/api/projects/$PROJECT_ID/agent-proxy/agent/channels/webhook/incoming" \
  -H "Authorization: Bearer $SHOGO_API_KEY" \
  -H "X-Webhook-Secret: $CHANNEL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message": "Triage Jira ticket ABC-123"}'
```

The cloud verifies the bearer key, looks up the project pin, and relays
the request through this worker's existing outbound WebSocket into the
agent-runtime that the worker spawned on demand. Tool calls (shell, file
I/O, MCP servers) execute on **this machine**.

See [Webhook channel reference](https://docs.shogo.ai/docs/features/external-triggers/webhook-channel)
for the request/response shape, secret handling, and async callback mode.

## Cloning a staging project (`shogo project pull`)

When you pin a staging project to this machine, the worker needs the
project's workspace files on disk to spawn the agent against. By default
the worker **auto-clones** the project on first request:

```bash
shogo worker start                       # auto-pull is ON, git transport by default
shogo worker start --no-auto-pull        # opt out (e.g. for git-backed projects)
shogo worker start --no-git              # force the Files API path even when git is on PATH
shogo worker start --projects-dir /mnt/big-disk/shogo   # override default ~/.shogo/projects
```

You can also clone manually ahead of time:

```bash
# Clones to ~/.shogo/projects/<projectId>/ by default
shogo project pull <projectId>

# Pull-then-watch: keeps a local editor and cloud in sync
shogo project pull <projectId> --watch

# Push local edits back
shogo project push <projectId>
shogo project push <projectId> --delete-remote   # mirror local deletions

# Roll the local workspace back to a specific git checkpoint
shogo project checkout <projectId>                             # fast-forward to remote HEAD
shogo project checkout <projectId> --at "before refactor"      # resolve by checkpoint name
shogo project checkout <projectId> --at <sha> --unshallow      # full history
```

**Two transports.** Auto-pull uses git's smart-HTTP protocol by default
(`git clone --depth=1` against `https://api.shogo.ai/api/projects/<id>/git`)
so the worker gets a full checkpoint history and delta-sized pushes for free.
If `git` isn't available, the worker falls back to the Files API. Manual
`shogo project pull/push` always uses the Files API so `--include` filters
and `.shogo/` SQLite state work the same way. See
[Cloning projects to a paired machine](https://docs.shogo.ai/docs/features/my-machines/project-pull)
and [Checkpoints on the VPS](https://docs.shogo.ai/docs/features/my-machines/checkpoints-on-the-vps)
for the end-to-end walkthrough.

## Troubleshooting

```bash
shogo worker start --debug         # run preflight checks
shogo worker logs --follow         # tail live logs
SHOGO_DEBUG=1 shogo worker status  # verbose errors

# Runtime missing?
shogo runtime where     # see what's resolved
shogo runtime install   # (re)download the latest stable binary
```

### Repair a wedged local Shogo build

The Shogo Desktop app keeps its data in a local SQLite database and applies
schema changes with `prisma migrate deploy` on every launch. If a migration
is interrupted (a crash, a forced quit, or a buggy update), it can leave a
`_prisma_migrations` row in a half-applied state. Prisma's P3009 check then
refuses to run **any** further migrations, and the app gets stuck on startup.

The desktop app surfaces a recovery dialog when it hits this on boot, and you
can trigger the same fix from its **Help → Repair Local Database...** menu. If
the app won't open at all (or you're walking someone through a fix over a call),
run it from a terminal instead:

```bash
shogo doctor              # detect, confirm, back up, then clear the wedge
shogo doctor --check      # diagnose only — never touches the database (exit 1 if wedged)
shogo doctor --yes        # repair without the interactive confirmation
```

What it does:

1. **Detects** stuck migrations in the desktop app's local `shogo.db`.
2. **Backs up** the database to a `shogo.db.bak-<timestamp>` sibling file
   (skip with `--no-backup`, discouraged).
3. **Clears** the failed migration record (equivalent to
   `prisma migrate resolve --rolled-back`).

It does **not** re-run migrations itself — relaunch the Shogo app afterward and
it will re-apply them cleanly on the next boot. Repair only sticks if you're on
an app version where the underlying migration is fixed; otherwise you'll hit the
same state again, but your data is safe in the backup.

```bash
# Point at a non-default database or a specific bun binary
shogo doctor --db "/path/to/shogo.db"
shogo doctor --bun "/Applications/Shogo.app/Contents/Resources/bun/bun"
```

`shogo doctor` finds the desktop database automatically
(`~/Library/Application Support/Shogo/data/shogo.db` on macOS,
`%APPDATA%\Shogo\data\shogo.db` on Windows, `~/.config/Shogo/data/shogo.db` on
Linux) and uses the `bun` shipped inside the app (or one on your `PATH`). This
command is local-only; it never contacts Shogo Cloud.

## Links

- [Cloud Agent: My Machines guide](../../docs/cloud-agent-my-machines.md) — full
  walk-through, security model, deploy patterns
- [Networking & firewall guide](../../docs/my-machines-networking.md)
- Source: [github.com/shogo-labs/shogo-ai](https://github.com/shogo-labs/shogo-ai)
