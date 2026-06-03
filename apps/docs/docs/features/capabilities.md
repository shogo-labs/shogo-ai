---
sidebar_position: 3
title: Capabilities
slug: /features/capabilities
---

# Capabilities

Every agent ships with a set of **capabilities** — web search, shell, browser
control, image generation, heartbeat, memory, channels, integrations, and more.
You turn them on and off in the **Capabilities** tab of a project (or in
`config.json` for local/CLI workflows).

Turning a capability off does **two** things at once:

1. **Removes its tools** — the agent (and any subagent it delegates to) can no
   longer call them.
2. **Trims the system prompt** — the related guidance is dropped from the
   prompt, saving tokens on every turn.

This makes capabilities the main lever for tailoring an agent to a job: a
code-only agent working a GitHub repo doesn't need messaging channels or image
generation, and dropping them keeps the agent focused and cheaper to run.

:::info Tools and prompt stay in sync
A disabled capability is removed **everywhere** — the main agent and every
delegated subagent (media, devops, channel, integration). The agent can't reach
a tool you've turned off, and it won't be told the tool exists.
:::

## The capabilities

All capabilities default to **on**. Set a flag to `false` to disable it.

| Capability | Flag | Gates (tools) | Also trims from prompt |
|------------|------|---------------|------------------------|
| Web search | `webEnabled` | `web` | — |
| Browser control | `browserEnabled` | `browser` | Browser guide (delegated) |
| Shell | `shellEnabled` | `exec`, `exec_wait` | — |
| Image generation | `imageGenEnabled` | `generate_image` | `media` capability line |
| Heartbeat | `heartbeatEnabled` | `heartbeat_configure`, `heartbeat_status` | `devops` line + Action Tools reminder |
| Memory | `memoryEnabled` | `memory_read`, `memory_search` | — |
| Quick actions | `quickActionsEnabled` | `quick_action` | Quick Action guide |
| Channels | `channelsEnabled` | `channel_connect`, `channel_disconnect`, `channel_list`, `send_message` | `channel` line + Action Tools bullet |
| Integrations | `integrationsEnabled` | `search_integrations`, `connect`, `disconnect` | `integrations` line + Action Tools bullet |
| Canvas | `canvasEnabled` / `activeMode: "none"` | canvas tools | Canvas file reference + preview context |

### Prompt-only toggles

A couple of switches trim the prompt without gating any tool, because there's
no tool behind them — they're pure context:

| Toggle | Flag | What it removes |
|--------|------|-----------------|
| Shogo SDK Guide | `sdkGuideEnabled` | The `@shogo-ai/sdk` reference (~2k tokens) for projects that ship a Shogo app |

:::note Tech stack guide
The tech stack guide isn't a toggle — it's the contents of `STACK.md`, injected
only when that file exists. For a plain repo there's nothing to disable; if you
want stack context, write a short `STACK.md` (or a `# Stack` section in
`AGENTS.md`) describing your repo's actual stack. See
[Workspace Files](/concepts/workspace-files).
:::

## When to turn things off

### Code-only agents (working a GitHub repo)

If you're using Shogo to work on a repository — editing code, running tests,
opening PRs — you usually want the **full coding prompt** without the
Shogo-platform surfaces. Turn these off:

- **Channels** — you're not messaging through Slack/Telegram/Discord.
- **Integrations** — you authenticate to GitHub with a token + the `gh` CLI, not
  managed OAuth.
- **Image generation** — not needed for code work.
- **Heartbeat** — no autonomous scheduling.
- **Shogo SDK Guide** — only useful if the repo ships a Shogo app.
- **Canvas** (`activeMode: "none"`) — no visual dashboards.

Keep **Shell**, **Web search**, **Memory**, and **Browser** (handy for testing
web apps) on. This leaves the agent with the complete coding toolset and a
leaner prompt.

```json title="config.json"
{
  "activeMode": "none",
  "channelsEnabled": false,
  "integrationsEnabled": false,
  "imageGenEnabled": false,
  "heartbeatEnabled": false,
  "sdkGuideEnabled": false
}
```

:::tip GitHub access
Save a personal access token to `.env` as `GITHUB_TOKEN` and let the agent use
the `gh` CLI — there's no need for the managed Integrations surface. See the
[GitHub ops template](../templates/github-ops) for a worked example.
:::

### Chat-only agents (no app, no code)

If the agent only chats and answers questions, drop the developer surfaces
instead: turn off **Shell**, **Browser**, **Canvas**, and the **Shogo SDK
Guide**. Keep **Memory**, **Channels**, and **Web search** so it can hold a
conversation, reach people, and look things up.

### Autonomous / monitoring agents

Leave **Heartbeat**, **Channels**, and **Integrations** on — these are exactly
the surfaces a background agent relies on to check things on a schedule and
report out. See [Heartbeat](/concepts/heartbeat).

## How to change capabilities

### In Shogo Studio

Open a project, go to the **Capabilities** tab, and toggle any capability. The
change is saved to the project and pushed to the running agent immediately — no
restart needed.

### In a local / CLI workflow

For the [interactive CLI](./my-machines/interactive-cli) (`shogo chat`) or any
workspace you run yourself, add the flags to the workspace `config.json`. The
agent reads them when it builds each turn, so the toggles apply to that
directory.

### Hot-reloading a running agent

You can patch a live runtime directly:

```bash
curl -X PATCH "$AGENT_URL/agent/config" \
  -H "Content-Type: application/json" \
  -d '{ "channelsEnabled": false, "integrationsEnabled": false }'
```

The runtime merges the change into `config.json` and reloads — the next turn
uses the new capability set.

## FAQ

**Does turning a capability off save money?**
Yes — twice over. The prompt is shorter (fewer input tokens every turn), and the
agent has fewer tool schemas to reason over, which keeps it focused.

**Will a subagent still use a disabled tool?**
No. Capability gating is applied to the shared tool set that subagents draw
from, so a disabled tool is unreachable for delegated agents too.

**What if I disable Shell or Memory by accident?**
The agent will tell you a needed tool isn't available. Re-enable it in the
**Capabilities** tab (or `config.json`) and the tool comes back on the next
turn.

**Can I keep the tools but trim only the prompt?**
For most capabilities the tool and its prompt guidance are linked — that's the
point. The exceptions are the prompt-only toggles like the **Shogo SDK Guide**,
which trim context without removing any tool.
