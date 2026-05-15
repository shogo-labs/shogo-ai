---
title: Quickstart
sidebar_position: 1
---

# My Machines — Quickstart

**My Machines** lets you pair any Mac, Linux box, or Windows PC to Shogo so chat
tool calls (shell, file I/O, MCP servers) run **on your machine** instead of a
cloud sandbox. Same model as Cursor's "Cloud Agent → My Machines".

You can pair in under 2 minutes.

## 1. Create an API key

Open [studio.shogo.ai/api-keys](https://studio.shogo.ai/api-keys) and click
**+ Create Key**. Copy the `shogo_sk_...` string.

:::tip
Keep the key on the machine you're about to pair. It won't be shown again.
:::

## 2. Install the CLI

**macOS / Linux**

```bash
curl -fsSL https://install.shogo.ai | bash
```

**Windows (PowerShell)**

```powershell
irm https://install.shogo.ai/ps | iex
```

The installer drops a single self-contained binary at `~/.shogo/bin/shogo`
(`%USERPROFILE%\.shogo\bin\shogo.exe` on Windows), verifies its SHA-256
against the published checksum, and adds the bin dir to `PATH`. No Node or
Bun on your machine required.

<details>
<summary>Already have Node 20+? Or want a specific channel?</summary>

The script accepts flags after `--`:

```bash
curl -fsSL https://install.shogo.ai | bash -s -- --channel beta
curl -fsSL https://install.shogo.ai | bash -s -- --prefix ~/bin --force
```

| Flag | Effect |
|------|--------|
| `--channel stable\|beta` | Pick a release channel (default `stable`). |
| `--prefix <dir>` | Install into `<dir>/shogo` instead of `~/.shogo/bin/`. |
| `--force` | Overwrite an existing install. |
| `--no-binary` | Skip the prebuilt binary; install the npm package via `npm i -g @shogo-ai/worker` (needs Node ≥ 20). |

Equivalent npm one-liner if you'd rather skip the script entirely:

```bash
npm i -g @shogo-ai/worker
```

Air-gapped? The binary tarballs live on the [v\* GitHub release](https://github.com/shogo-labs/shogo-ai/releases) — same artifacts the installer pulls.

</details>

## 3. Log in and start the worker

```bash
shogo login --api-key shogo_sk_XXXXXXXX
shogo worker start --worker-dir ~/code/myrepo
```

Within ~5 seconds the machine appears in the **Remote Control** page in studio.
Pick it from the environment switcher next to the chat input and your next
message runs there.

## 4. Send it something

Try:

> List the files in the current directory and show the git status.

Shogo's tool calls execute on your laptop and stream output back into chat.

## What next

- [Networking & allowlist](./networking) — what the worker talks to
- [Troubleshooting](./troubleshooting) — fixing login/heartbeat/tunnel errors
- [External triggers](../external-triggers/quickstart) — let Jira, Linear,
  GitHub or your own services send messages to an agent running on this
  machine.
