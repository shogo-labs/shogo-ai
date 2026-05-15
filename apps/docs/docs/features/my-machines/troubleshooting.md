---
title: Troubleshooting
sidebar_position: 3
---

# Troubleshooting

## `shogo worker start` says "Heartbeat failed: HTTP 401"

Your API key was revoked or the cloud no longer recognizes it.

1. Open [studio.shogo.ai/api-keys](https://studio.shogo.ai/api-keys).
2. Confirm your key is still in the **Manual API keys** list.
3. If it's missing, create a new one and run:
   ```bash
   shogo worker stop
   shogo login --api-key shogo_sk_NEW_KEY
   shogo worker start
   ```

## Worker shows "online" in studio but chat can't reach it

Run the preflight:

```bash
shogo worker start --debug
```

The output shows green/red checks for:
- runtime (bun or node ≥ 20)
- worker dir exists and is readable
- proxy env vars
- DNS + TLS to each of the 3 outbound hosts
- live API-key validation

Red checks explain what's wrong.

## Tunnel error banner in chat: "Connection to desktop instance lost"

The chat UI auto-polls `/agent/health` every 3 seconds for 60 seconds. If the
worker comes back, the conversation resumes automatically.

If the worker stays offline, a **Continue in cloud** button appears next to
**Reconnect**. Click it to fall back to the cloud sandbox — your conversation
continues, just without access to the remote machine.

## "main.agent_configs does not exist" in worker logs

Harmless noise from the local AgentConfig cron — unrelated to pairing. Fixed
in a later release.

## Installer: `Checksum mismatch`

The installer downloads `https://releases.shogo.ai/cli/<channel>/shogo-<target>.tar.gz`
and `...tar.gz.sha256` and verifies them with `sha256sum -c`. A mismatch
means either:

- The tarball was corrupted in transit. Just re-run the installer — the
  302 chain hits a fresh GitHub asset URL each time.
- You're behind a TLS-inspecting proxy that's rewriting the gzip body.
  Use `--no-binary` to fall through to the npm install path, which is
  served over a single TLS hop to `registry.npmjs.org`:

  ```bash
  curl -fsSL https://install.shogo.ai | bash -s -- --no-binary
  ```

## Installer: hangs or `HTTP/2 503` from `releases.shogo.ai`

The release resolver hits the GitHub API to find the latest `v*` tag for
your channel. If you see a brief 503 followed by success on retry, you
hit a transient anonymous rate-limit. The resolver caches successful
lookups for an hour (stable) / 10 min (beta) / 1 min (nightly) so the
warm path is fast.

Persistent 503 means no `v*` release exists for your channel yet — e.g.
`--channel nightly` on a repo that doesn't cut nightly tags. Pick a
different channel or install via npm:

```bash
npm i -g @shogo-ai/worker
```

## Installer: `shogo` not found after install

The installer adds `~/.shogo/bin` (Unix) or `%USERPROFILE%\.shogo\bin`
(Windows) to your PATH, but existing shells don't see the update. Open a **new
terminal** or run:

```bash
export PATH="$HOME/.shogo/bin:$PATH"    # bash/zsh
```

## How do I fully remove my worker?

```bash
shogo worker stop
rm -rf ~/.shogo
```

Then open **studio → Remote Control**, click the trash icon next to the
device, and confirm. The API key is revoked and the Instance row is removed.
