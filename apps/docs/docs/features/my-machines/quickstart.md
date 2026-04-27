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

The installer drops a single binary at `~/.shogo/bin/shogo` (or
`%USERPROFILE%\.shogo\bin\shogo.exe` on Windows) and adds it to `PATH`.

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
