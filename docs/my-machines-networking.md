<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# Shogo Worker — Networking & Outbound Allowlist

This page is for **platform / security / network engineers** who need to allow-list Shogo Worker traffic on a corporate firewall. Share it with them directly.

## TL;DR

- **Protocol:** HTTPS (TCP 443) **outbound only**.
- **Inbound ports required:** none.
- **Hosts to allow:** 3 (listed below).

## Required outbound hosts

> **Operational note (Apr 2026):** the canonical host split is rolling out. All traffic currently flows through `studio.shogo.ai`. The table below is the target end-state; during migration the listed hostnames resolve to the same edge that serves `studio.shogo.ai`, so allow-listing them now is forward-compatible.

| # | Host | Purpose | If blocked |
|---|------|---------|-----------|
| 1 | `api.shogo.ai` | Session control plane — auth, heartbeat, agent API calls | **FATAL** — worker cannot pair or run any agent session |
| 2 | `api-direct.shogo.ai` | Direct-tunnel fallback — bypasses CDN/edge for WebSocket pinning | Graceful — tunnel falls back to edge routing through host #1 |
| 3 | `artifacts.shogo.ai` | Artifact uploads — thumbnails, voice clips, publish assets | Graceful — only artifact uploads fail; chat + tool calls continue |

Blocking **any third-party host** (github.com, npm, your private package mirror, etc.) only affects the specific tool that needs it. The agent session keeps running.

## Behind a corporate proxy

### Plain HTTP proxy

```bash
HTTPS_PROXY=http://proxy.corp:3128 shogo worker start
# or pass the --proxy flag
shogo worker start --proxy http://proxy.corp:3128
```

Both `HTTPS_PROXY` and lowercase `https_proxy` are honoured. `HTTP_PROXY` is also honoured for plaintext traffic.

### TLS-inspecting proxy

If your proxy performs TLS MitM inspection and presents a corporate root CA, the worker's Node runtime needs that CA installed:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem \
  HTTPS_PROXY=http://proxy.corp:3128 \
  shogo worker start --debug
```

The `--debug` flag runs a preflight check (`Proxy reachable`) before starting.

## Verifying your allowlist

```bash
# 1. DNS resolves
for h in api.shogo.ai api-direct.shogo.ai artifacts.shogo.ai; do
  dig +short "$h"
done

# 2. TLS handshake completes
for h in api.shogo.ai api-direct.shogo.ai artifacts.shogo.ai; do
  curl -sS -o /dev/null -w "%{http_code} %{url_effective}\n" "https://$h/health" || echo "FAIL $h"
done

# 3. Worker preflight (includes proxy check if HTTPS_PROXY set)
shogo worker start --debug
```

Expected preflight output when all is well:

```
Shogo Worker — Preflight
  ✓ Runtime (node >= 20)       — node v20.x
  ✓ Worker directory exists    — /home/user/code/app
  ✓ Reach api.shogo.ai         — HTTP 200
  ✓ Proxy reachable            — HTTP 200 (via proxy.corp:3128)
  ✓ API key valid              — HTTP 200
All checks passed.
```

## FAQ

**Why is there no inbound port?**
The worker dials Shogo Cloud over HTTPS. When the cloud needs to push work, the worker's open connection carries it back. No inbound ports, no public IP, no VPN required.

**Can I pin traffic to my region?**
Yes — set `SHOGO_CLOUD_URL` to your region's endpoint (e.g. `https://eu.shogo.ai`). The three-host rule still applies to that region's names.

**Do I need to allow AWS S3 wildcards?**
No. The artifact host (`artifacts.shogo.ai`) is a CNAME to a single S3 bucket. You do **not** need to allow `*.s3.amazonaws.com`. Prefer exact-host rules.

**What about telemetry / phone-home?**
None. The worker only contacts the three hosts above. There is no separate telemetry endpoint.
