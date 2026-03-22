---
sidebar_position: 4
title: Workspace Files
slug: /concepts/workspace-files
---

# Workspace Files

Each agent has a workspace — a set of Markdown files that define its identity, behavior, memory, and capabilities. When you configure an agent through chat, the AI is writing and editing these files. You can also view and browse them in the **Files** tab of your agent.

## Full workspace layout

```
workspace/
├── AGENTS.md           ← Operating instructions and priorities
├── SOUL.md             ← Personality, tone, and boundaries
├── IDENTITY.md         ← Name, emoji, tagline
├── USER.md             ← Your preferences and contact info
├── HEARTBEAT.md        ← Scheduled task checklist
├── MEMORY.md           ← Long-term facts and learnings
├── TOOLS.md            ← Notes about available tools
├── memory/             ← Daily logs (YYYY-MM-DD.md)
├── skills/             ← Skill definition files
└── config.json         ← Runtime settings (model, intervals, channels)
```

Every file is plain Markdown (except `config.json`). The agent reads them at startup and on each heartbeat tick.

---

## AGENTS.md — Operating instructions

**Loaded:** Every session, every heartbeat

This is the most important file. It defines _how_ the agent behaves — its operating rules, priorities, and approach to different tasks. Think of it as a standing order document that the agent follows at all times.

**Default content:**
```markdown
# Operating Instructions

## Approach
- Plan before you build
- Use canvas to display dashboards and results
- Use memory to persist important facts
- Prefer action over clarification

## Priorities
1. User requests — respond promptly
2. Urgent alerts — surface immediately via channels
3. Scheduled checks — run on heartbeat cadence
4. Proactive suggestions — offer when relevant
```

**What to customize:**
- Alert routing rules ("P0 tickets → immediate Slack DM; P1-P3 → daily digest")
- Communication format preferences ("always use bullet points; include timestamps")
- Domain-specific rules ("never restart the prod database without confirmation")
- Batching preferences ("group GitHub activity into daily summaries")

**Example customization:**
```markdown
# Operating Instructions

## Core Rules
- Alert me immediately if API error rate exceeds 1% for 5+ minutes
- Batch non-urgent GitHub activity into a 9am daily digest
- Never send more than 3 messages per hour unless it's a P0 incident
- Always include a "What to do next" section in incident alerts

## Alert Routing
- P0 (service down): Slack DM to @russell + post in #incidents
- P1 (degraded): Post in #incidents, no DM
- P2-P3: Include in daily digest only
```

---

## SOUL.md — Personality and tone

**Loaded:** Every session

Defines your agent's personality, communication style, and behavioral guardrails. The agent uses this to shape how it speaks and what it will or won't do.

**Default content:**
```markdown
# Soul

You are a capable, proactive AI agent. You communicate clearly and get
things done efficiently. You explain what you're about to do, then do it.

## Tone
- Direct and helpful, not verbose
- Confident but not presumptuous
- Celebrate completions briefly, then move on

## Boundaries
- Never execute destructive commands without explicit confirmation
- Never share credentials in channel messages
- Respect quiet hours for non-urgent notifications
```

**What to customize:**
- Communication style ("always be concise — one sentence max per update")
- Agent persona ("you are a diligent DevOps engineer; use technical language")
- Hard limits ("never send messages to external channels without my approval")
- Formatting preferences ("use code blocks for commands; use tables for data")

---

## IDENTITY.md — Name and vibe

**Loaded:** Every session

Sets the agent's display name, emoji, and tagline. Mostly cosmetic — it affects how the agent refers to itself.

**Default content:**
```markdown
# Identity

- **Name:** Shogo
- **Emoji:** ⚡
- **Tagline:** Your AI agent — ready to build
```

**Customized example:**
```markdown
# Identity

- **Name:** Atlas
- **Emoji:** 🌐
- **Tagline:** Your tireless systems guardian
```

You can set this through chat: _"Name the agent Atlas and give it a globe emoji."_

---

## USER.md — Your preferences

**Loaded:** Every session

Stores information about you — your name, timezone, contact preferences, and anything else the agent should know to serve you well.

**Default content:**
```markdown
# User

- **Name:** (not set)
- **Timezone:** UTC
```

**Customized example:**
```markdown
# User

- **Name:** Russell
- **Timezone:** America/Los_Angeles
- **Work hours:** 9am–6pm PT, Mon–Fri
- **Preferred contact:** Telegram for urgent, Slack for everything else
- **GitHub handle:** @russell
- **Slack:** @russell in acme.slack.com
```

The agent uses this to personalize alerts, respect your timezone for quiet hours, and know how to reach you. Set it through chat:

> "My name is Russell and I'm in Pacific time. I prefer Telegram for urgent alerts and Slack for daily digests."

---

## HEARTBEAT.md — Scheduled task checklist

**Loaded:** Each heartbeat tick

The checklist of tasks your agent runs on each scheduled heartbeat. See [How the Heartbeat Works](/concepts/heartbeat) for the full guide.

**Example:**
```markdown
# Heartbeat Checklist

## Every heartbeat
- Check https://api.acme.com/health — alert if non-200
- Scan GitHub for new issues labeled "critical"

## Daily at 9am
- Send morning digest to Slack #engineering
```

---

## MEMORY.md — Long-term facts

**Loaded:** On demand (at the start of each session and when recalled)

Persistent storage for facts, preferences, and learnings that should survive across conversations. See [How Memory Works](/concepts/memory) for the full guide.

**Example:**
```markdown
# Memory

## User Preferences
- Alert channel: Slack #incidents (urgent), #general (routine)
- Work hours: 9am–6pm PT

## Systems
- API: https://api.acme.com
- GitHub: acme/api, acme/web, acme/infra

## Key Contacts
- Sarah Chen — backend lead
- James Park — DevOps, escalation for infra
```

---

## TOOLS.md — Tool notes

**Loaded:** On demand

A place to record notes about how specific tools should be used in this agent's context. The AI maintains this file and may update it when you connect new tools or describe preferences.

**Example:**
```markdown
# Tools

## GitHub
- Use token stored in GITHUB_TOKEN env var
- Monitor repos: acme/api, acme/web
- Main branch: main

## Slack
- Bot is installed in acme.slack.com
- Default alert channel: #incidents
- DM channel for urgent: @russell

## Stripe
- Use restricted key (read-only) for revenue queries
```

---

## How the AI edits these files

When you chat with your agent, the AI reads and writes these files based on your requests. For example:

- _"Make the agent more concise"_ → edits `SOUL.md`
- _"Set quiet hours to midnight–8am"_ → edits `config.json`
- _"Remember that our main repo is acme/api"_ → writes to `MEMORY.md`
- _"Check GitHub every 15 minutes"_ → edits `HEARTBEAT.md` and `config.json`
- _"Add a ticket triage skill"_ → creates `skills/ticket-triage.md`

You can also view and browse all these files in the **Files** tab of your agent project — useful to see exactly what the AI has configured.

---

## Related

- [How the Heartbeat Works](/concepts/heartbeat)
- [How Memory Works](/concepts/memory)
- [How Skills Work](/concepts/skills)
- [Chat with AI](/features/chat-with-ai) — how the AI edits workspace files
