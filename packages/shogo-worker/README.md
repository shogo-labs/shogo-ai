# @shogo-ai/worker

Run Shogo Cloud Agents on a machine you already own — a laptop, devbox, or CI runner.
Outbound-only: the worker dials Shogo Cloud over HTTPS, never the other way around.

## Install

```bash
# Requires node >= 20 (or bun >= 1.3)
npm i -g @shogo-ai/worker
```

## Quick start

```bash
# 1. Create an API key at https://studio.shogo.ai/api-keys,
#    then save it locally. The login command prompts for the key
#    (or use --api-key / SHOGO_API_KEY for headless / CI).
shogo login

# 2. Start the worker (detached by default)
shogo worker start --name my-devbox --worker-dir ~/code/myproject

# 3. Check it's online
shogo worker status

# 4. Open https://studio.shogo.ai — your machine appears in the environment dropdown.
```

### Headless / CI

```bash
shogo login --api-key "shogo_sk_..."             # non-interactive save
SHOGO_API_KEY=shogo_sk_... shogo worker start    # skip login entirely
```

## Commands

| Command | What it does |
|---|---|
| `shogo login` | Save an API key to `~/.shogo/config.json` (Phase 2 adds browser device-code flow) |
| `shogo worker start` | Launch the worker (detached). Flags: `--name`, `--worker-dir`, `--api-key`, `--cloud-url`, `--port`, `--debug`, `--foreground` |
| `shogo worker stop` | Stop the running worker |
| `shogo worker status` | Show running / stopped |
| `shogo worker logs [-f]` | Tail `~/.shogo/logs/worker.log` |
| `shogo config show` | Print config (API key masked) |
| `shogo config set <key> <value>` | Edit a single key |

## Networking

The worker needs outbound HTTPS (TCP 443) to 3 hosts. **No inbound ports required.**

| Host | Purpose | If blocked |
|------|---------|-----------|
| `api.shogo.ai` | Session + heartbeat | **FATAL** — worker can't run |
| `api-direct.shogo.ai` | Direct tunnel fallback | Graceful — edge routing takes over |
| `artifacts.shogo.ai` | Artifact uploads | Graceful — only uploads fail |

Full networking guide for security teams: [docs/my-machines-networking.md](../../docs/my-machines-networking.md)

### Corporate proxy

```bash
# HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy all honoured
HTTPS_PROXY=http://proxy.corp:3128 shogo worker start

# Or pass explicitly with --proxy (overrides env)
shogo worker start --proxy http://proxy.corp:3128

# TLS-inspecting proxy needs your corp root CA
NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem \
  HTTPS_PROXY=http://proxy.corp:3128 \
  shogo worker start --debug
```

`shogo worker start --debug` runs a preflight that includes a proxy-reachability check when `HTTPS_PROXY` is set.

## How it works

The worker is a thin lifecycle manager around Shogo's existing **Instance Tunnel**
(`apps/api/src/lib/instance-tunnel.ts`). When you run `shogo worker start`, it:

1. Reads config from `~/.shogo/config.json` + env + CLI flags.
2. Spawns the bundled Shogo API entry with `SHOGO_API_KEY` + `SHOGO_LOCAL_MODE=true` in env.
3. The API auto-starts the tunnel: HTTP heartbeat every 60s, on-demand WebSocket when the
   cloud signals a session.
4. The cloud sends `request` messages over the WS; the worker executes against its local
   API or agent-runtime port and streams the response back.

For deeper reading see the plan at `docs/cloud-agent-my-machines.md` (Phase 0).

## Troubleshooting

```bash
shogo worker start --debug    # run preflight checks
shogo worker logs --follow    # tail live logs
SHOGO_DEBUG=1 shogo worker status  # verbose errors
```
