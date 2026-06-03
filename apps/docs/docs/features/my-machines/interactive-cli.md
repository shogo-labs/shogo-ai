---
title: Interactive coding agent
sidebar_position: 2
---

# `shogo` — interactive coding agent

Type `shogo` inside any repository and you get an interactive coding agent — in
the same spirit as `claude` or `cursor-agent`. It edits and runs your **local**
files, streams its work to the terminal, and bills LLM usage to your Shogo
account through the workspace key you logged in with.

Unlike a paired worker (which relays a cloud chat to your machine), the
interactive agent runs the whole agent loop **in your terminal, in the current
directory** — no cloud project, no tunnel, no browser.

## Prerequisites

1. **Install the CLI** and **log in** (see the [Quickstart](./quickstart)).
   `shogo login` opens your browser to approve the machine — no key to copy or
   paste:

```bash
shogo login
```

   It mints and stores a workspace key in `~/.shogo/config.json` — the same
   credential the interactive agent bills through. On a headless box or in CI,
   use the escape hatch instead: `shogo login --api-key shogo_sk_…`
   (or set `SHOGO_API_KEY`).

2. **Install the agent runtime binary** (one-time; the interactive agent runs
   inside it):

```bash
shogo runtime install
```

If the binary is missing, `shogo` prints exactly where it looked and how to
fix it. You can also point at a custom build with `--runtime-bin <path>`.

## Start a session

From inside the repo you want to work in:

```bash
cd ~/code/myrepo
shogo
```

That drops you into an interactive prompt. `shogo chat` is the explicit form
of the same command. Type a message and the agent starts editing/exec-ing files
in the current directory, streaming its reasoning, tool calls, and results as it
goes.

```text
Shogo interactive agent
  cwd:   /Users/you/code/myrepo
  model: default
  Type a message, or /help for commands. Ctrl-C to stop a turn or exit.

› add a health check endpoint and a test for it
```

### Controls

| Key | Action |
|-----|--------|
| `Enter` | Submit your message |
| `Ctrl-C` / `Esc` | Interrupt the **current turn** (the agent stops what it's doing) |
| `Ctrl-C` on an empty prompt | Exit the agent |

### Slash commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model [name]` | Show or set the model used for new turns |
| `/clear` | Start a fresh conversation (new session) |
| `/cwd` | Print the working directory |
| `/exit` | Exit the agent (also: `Ctrl-C` on an empty prompt) |

## One-shot / headless mode

Pass `-p` (or `--print`) to run a single turn and exit — perfect for scripts and
pipelines. Assistant text goes to **stdout**, tool activity to **stderr**, and
the exit code reflects success/failure:

```bash
# Ask a question and capture just the answer
shogo -p "what does src/server.ts do?" > summary.txt

# Pipe context in and get a review
git diff | shogo -p "review this diff and flag risky changes"
```

## Flags

| Flag | Description |
|------|-------------|
| `-p, --print <prompt>` | Headless one-shot: run a single turn and print the result |
| `--model <model>` | Model id to use for new turns |
| `--cwd <dir>` | Working directory to operate in (default: `$PWD`) |
| `--runtime-bin <path>` | Override the agent-runtime binary path |
| `--no-tui` | Disable the rich TUI; use a plain renderer (good for dumb terminals/pipes) |
| `--api-key <key>` | Override the API key for this run |
| `--cloud-url <url>` | Override the Shogo Cloud URL for this run |

## How it works

- The MIT `shogo` launcher resolves the agent-runtime binary and execs it in
  interactive mode, handing over your terminal. The agent loop runs
  **in-process** inside that binary against `$PWD`.
- LLM calls are routed through the Shogo AI proxy
  (`<cloud>/api/ai/v1`) and authenticated with your `shogo_sk_…` key, so all
  usage bills to your account — no separate provider key required.
- Each directory gets a stable, synthetic project id (a hash of its path), so
  conversation/session state is reused across runs **without** creating a cloud
  project. `/clear` starts a fresh session.

:::note Trusted directory
v1 runs in a trusted, auto-approve posture — like `claude` in a trusted
directory, the agent edits and runs files in `$PWD` without per-tool
prompts. Run it in repositories you trust.
:::

:::info Licensing
The interactive agent ships inside the `agent-runtime` binary, which is
**AGPL-3.0**. The `shogo` launcher itself stays MIT — it only spawns the
binary, it never links it.
:::

## What next

- [Quickstart](./quickstart) — install, log in, and pair a machine
- [Cloning projects](./project-pull) — bring a cloud project's files local
- [Troubleshooting](./troubleshooting) — login/runtime/heartbeat fixes
