# @shogo-ai/worker

Run Shogo Cloud Agents on a machine you already own — a laptop, devbox, or CI runner.
Outbound-only: the worker dials Shogo Cloud over HTTPS, never the other way around.

> Licensed **MIT**. The agent runtime it spawns is licensed AGPL-3.0-or-later
> and ships as a separate binary — see [Architecture & licensing](#architecture--licensing) below.

## Install

```bash
# Requires node >= 20 (or bun >= 1.3)
npm i -g @shogo-ai/worker
```

> Prefer a single self-contained binary? Grab the prebuilt tarball for your
> OS / arch from the [latest worker release](https://github.com/shogo-ai/shogo-ai/releases?q=worker-v)
> — it has no Node / Bun dependency.

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

## Files & layout

```
~/.shogo/
├── config.json        # API key + cloud URL (mode 0600)
├── device-id          # stable per-machine UUID; dedupes re-logins
├── worker.pid         # lifecycle file for `worker start/stop/status`
├── logs/
│   ├── worker.log
│   └── worker.err.log
└── runtime/
    ├── agent-runtime  # AGPL binary, downloaded by `shogo runtime install`
    └── version.json
```

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

## Programmatic use

Both core classes are exposed for direct embedding (e.g. building your own
desktop wrapper):

```ts
import { WorkerTunnel, WorkerRuntimeManager } from '@shogo-ai/worker'

const runtimeManager = new WorkerRuntimeManager({
  defaultSpawnConfig: { cloudUrl: 'https://studio.shogo.ai', apiKey: process.env.SHOGO_API_KEY! },
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

## Troubleshooting

```bash
shogo worker start --debug         # run preflight checks
shogo worker logs --follow         # tail live logs
SHOGO_DEBUG=1 shogo worker status  # verbose errors

# Runtime missing?
shogo runtime where     # see what's resolved
shogo runtime install   # (re)download the latest stable binary
```

## Links

- [Cloud Agent: My Machines guide](../../docs/cloud-agent-my-machines.md) — full
  walk-through, security model, deploy patterns
- [Networking & firewall guide](../../docs/my-machines-networking.md)
- Source: [github.com/shogo-ai/shogo-ai](https://github.com/shogo-ai/shogo-ai)
