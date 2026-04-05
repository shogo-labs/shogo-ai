---
sidebar_position: 3
title: How Skills Work
slug: /concepts/skills
---

# How Skills Work

Skills are modular, reusable capabilities that teach your agent how to perform specific tasks. Each skill is a directory containing a `SKILL.md` file with instructions and metadata, plus optional scripts. When the AI adds a skill, it creates this directory in your agent's `.shogo/skills/` directory and the agent loads it on startup.

## What a skill is

A skill's `SKILL.md` has two parts:

1. **Frontmatter** (YAML) — metadata: name, description, what tools it needs
2. **Body** (Markdown) — instructions that tell the agent how to execute the skill

```markdown
---
name: daily-digest
version: 1.0.0
description: Compile and send a daily morning briefing to Slack
trigger: "daily digest|morning briefing|send briefing"
tools: [web, memory_read, send_message]
---

# Daily Digest

When triggered, compile a morning briefing and send it to the configured Slack channel.

## Steps
1. Read MEMORY.md to get tracked topics and preferences
2. Use `web` to search for news on each tracked topic (last 24 hours)
3. Check GitHub for new PRs and issues on configured repos
4. Format a digest with top stories, GitHub activity, and any pending tasks
5. Send to Slack using `send_message`

## Format
- Lead with a one-line summary: "Good morning — 3 stories, 2 open PRs, 1 alert"
- Group by category: News, GitHub, Reminders
- Keep each item to 1-2 lines with a link
- End with "Nothing urgent" if no alerts
```

## Skill fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for the skill |
| `description` | Yes | One-line description of what the skill does |
| `trigger` | No | Pipe-separated keywords that activate the skill |
| `version` | No | Version number (semver) |
| `tools` | No | Tools the skill needs access to |
| `setup` | No | Command to run before first invocation (e.g. `pip install -r requirements.txt`) |
| `runtime` | No | Default runtime for scripts (`python3`, `node`, `bash`) |

## Available tools in skills

| Tool | What it does |
|------|-------------|
| `web` | Search the web or fetch a URL |
| `exec` | Run shell commands |
| `read_file` | Read a workspace file |
| `write_file` | Write a workspace file |
| `memory_read` | Read from MEMORY.md or daily logs |
| `memory_write` | Write to MEMORY.md or daily logs |
| `send_message` | Send a message via a connected channel |
| `browser` | Control a headless browser |
| `heartbeat_configure` | Configure heartbeat schedule and quiet hours |
| `heartbeat_status` | Check heartbeat configuration and checklist |

## The skills directory

Skills live in your agent's workspace `.shogo/skills/` directory:

```
workspace/
└── .shogo/
    └── skills/
        ├── daily-digest/
        │   └── SKILL.md
        ├── ticket-triage/
        │   └── SKILL.md
        ├── lead-scorer/
        │   ├── SKILL.md
        │   └── scripts/
        │       └── score.py
        └── health-check/
            └── SKILL.md
```

Skills can optionally include a `scripts/` subdirectory with custom executable code. These scripts can be run via the `skill` tool's `run_script` action.

You can view all installed skills in the **Capabilities > Skills** tab of your agent.

## How skills are created

Skills are created through chat — you don't write them by hand. The AI generates the skill file based on your description and writes it into `.shogo/skills/`.

**Examples:**

> "Add a skill that monitors our API health and alerts on failures."

> "Create a skill for triaging support tickets by severity."

> "Build a skill that researches a topic across multiple sources and returns a summary."

After you describe what you want, the AI:
1. Determines the right skill name, triggers, and tools
2. Writes the instruction body
3. Creates the file in `.shogo/skills/`
4. Confirms what was created

## Modifying skills

You can edit a skill by describing the change through chat:

> "Update the daily-digest skill to also include Stripe revenue data."

> "Change the ticket-triage skill so P0 tickets trigger an immediate Slack alert instead of waiting for the daily digest."

> "The health-check skill is too noisy — make it only alert if a check fails 3 times in a row."

## Templates come with pre-built skills

Each agent template includes skills pre-configured for its purpose:

| Template | Skills included |
|----------|----------------|
| Research Assistant | `research-deep`, `topic-tracker` |
| GitHub Ops | `github-ops`, `pr-review` |
| Support Desk | `ticket-triage`, `escalation-alert` |
| Meeting Prep | `meeting-prep-v2`, `meeting-notes-v2` |
| Revenue Tracker | `revenue-snapshot`, `invoice-manage` |
| Project Board | `sprint-board`, `standup-collect` |
| Incident Commander | `health-check`, `incident-triage` |
| Personal Assistant | `habit-track`, `reminder-manage` |

You can view and customize any of these through chat after selecting a template.

## Skills vs heartbeat checklist

Skills and the heartbeat checklist serve different purposes:

| | Skills | Heartbeat checklist |
|-|--------|---------------------|
| **What it is** | A reusable capability file | A scheduled task list |
| **How it's triggered** | Via chat, heartbeat, or keyword | Automatically on every tick |
| **Scope** | Detailed instructions for one capability | High-level list of periodic checks |
| **Example** | "How to triage a ticket end-to-end" | "Check for new tickets every 30 min" |

The heartbeat checklist delegates work to skills. A good heartbeat item reads: _"On each tick, run the ticket-triage skill on any new Zendesk tickets."_

## Related

- [Capabilities panel](/getting-started/quick-start#step-5-connect-tools-and-channels) — where you browse installed skills
- [Heartbeat](/concepts/heartbeat) — how skills are triggered on a schedule
- [Workspace Files](/concepts/workspace-files) — the `.shogo/skills/` directory in context
