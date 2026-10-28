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
delegated subagent (channel, integration). The agent can't reach a tool
you've turned off, and it won't be told the tool exists. Image generation is the
one capability whose tools the agent calls **directly** — a project's own agent
generates images with `generate_image`, it does not hand the job to a subagent.
The same goes for `server_sync`, which regenerates and restarts the project's API
server: every agent calls it directly.
:::

## The capabilities

Most capabilities default to **on**; set a flag to `false` to disable it. Opt-in
ones (Git worktrees, Social media, Video generation, 3D generation, and some of
the [work capabilities](#work-capabilities)) default to off — the two generation
modes that bill per output are off until you turn them on.

| Capability | Flag | Gates (tools) | Also trims from prompt |
|------------|------|---------------|------------------------|
| Web search | `webEnabled` | `web` | — |
| Browser control | `browserEnabled` | `browser` | Browser guide (delegated) |
| Shell | `shellEnabled` | `exec`, `exec_wait` | — |
| Image generation | `imageGenEnabled` | `generate_image`, `list_media_models` | `media` capability line |
| Video generation (opt-in) | `videoGenEnabled` | `generate_video` | Video tools in the `media` line |
| Music generation (opt-in) | `musicGenEnabled` | `generate_music` | Music tools in the `media` line |
| 3D generation (opt-in) | `threeDGenEnabled` | `generate_3d_model`, `edit_3d_model` | 3D tools in the `media` line |
| Heartbeat | `heartbeatToolsEnabled` | `heartbeat_configure`, `heartbeat_status` | `heartbeat` line + Action Tools reminder |
| Memory | `memoryEnabled` | `memory_read`, `memory_search` | — |
| Quick actions | `quickActionsEnabled` | `quick_action` | Quick Action guide |
| Channels | `channelsEnabled` | `channel_connect`, `channel_disconnect`, `channel_list`, `send_message` | `channel` line + Action Tools bullet |
| Integrations | `integrationsEnabled` | `search_integrations`, `connect`, `disconnect` | `integrations` line + Action Tools bullet |
| Canvas | `canvasEnabled` / `activeMode: "none"` | canvas tools | Canvas file reference + preview context |

### Work capabilities

These cover how an agent works with your team in workspace channels and on
[boards](/features/boards). They only apply to team agents; a personal agent
never gets team chat, board management, or company operations.

| Capability | Flag | Default | Gates (tools) |
|------------|------|---------|---------------|
| Team chat | `teamChatEnabled` | on | `team_chat_*`, `team_directory`, `member_activity`, `fetch_chat_files` |
| Boards | `boardsEnabled` | on | `board_list`, `board_summary`, `board_health`, `work_item_*` |
| Board management | `boardAdminEnabled` | opt-in | `board_create`, `board_update`, `board_archive`, `board_reorder`, `column_*`, `work_template_list`, `work_template_add`, and board changes in `system_apply` |
| Triggers | `workTriggersEnabled` | on | `trigger_create`, `trigger_update`, `trigger_delete`, `trigger_test` (listing triggers always works) |
| Company operations | `companyOpsEnabled` | opt-in | No tools. Adds heartbeat board sweeps, nudges, and digests to the prompt. Needs Heartbeat and Boards on. |
| Problems | `problemsEnabled` | opt-in | `problem_report`, `problem_occurrences`. Needs Boards on. |

The workspace agent has board management, company operations, and problems
turned on by default, since it's the one setting up and running the boards.
Set any of them to `false` to turn it off.

Turning off Boards also turns off board management and problems, since they
work on boards. If a capability is on but something it needs is off, the agent
is told which one, so it can ask you to turn it on.

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
  "heartbeatToolsEnabled": false,
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

## The agent can change its own capabilities

The system prompt lists which capabilities are enabled, disabled, or locked by
the workspace profile. The agent turns them on and off for **its own project**
with `capabilities_configure`. The change is saved to the project and applies
on the next turn.

A personal workspace still cannot turn Shell or Canvas back on. Those stay
locked by the profile.

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
The agent can turn it back on with `capabilities_configure`, and you can
re-enable it in the **Capabilities** tab (or `config.json`). The tool comes
back on the next turn. Shell stays off on a personal workspace.

**Can I keep the tools but trim only the prompt?**
For most capabilities the tool and its prompt guidance are linked — that's the
point. The exceptions are the prompt-only toggles like the **Shogo SDK Guide**,
which trim context without removing any tool.

## Which tool schemas reach the model

A fully-enabled agent registers well over 100 tools, and sending every JSON
schema on every API call costs ~28k tokens before the conversation starts. So
the runtime advertises a **core set** (read/write/edit, `exec`, `todo_write`,
`web`, `read_guide`, `ask_user`, `share_file`, `agent_spawn`, …) plus **the
tools this agent actually uses**, learned from its last 30 days of tool calls.
Everything else is *deferred*: it stays callable, and it is listed by name in
the agent's **Deferred Tools** prompt section, but its schema is only loaded
when the agent asks for it (`read_guide({ tool })`) or calls it directly.

Both tracks behave identically, and the deferred set is capped by an 8,000-token
budget. To turn it off for a project, set `deferredToolsEnabled: false` in
`config.json` (or `SHOGO_DEFERRED_TOOLS=0` in the runtime's environment).

