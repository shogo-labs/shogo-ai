---
sidebar_position: 1
title: Chat with AI
slug: /features/chat-with-ai
---

# Chat with AI

The chat panel is how you build and configure your agent in Shogo. Type what you want, and the AI sets up your agent's identity, skills, memory, heartbeat, and canvas dashboards.

## How it works

1. **You type a message** describing what you want your agent to do — a new skill, a heartbeat schedule, a canvas dashboard, or a behavior change.
2. **The AI processes your request** and configures your agent accordingly.
3. **You iterate** — ask for adjustments, add more capabilities, or refine behavior.

Credits are consumed per token based on the AI model used — simpler requests cost less than complex ones. See [Plans and Credits](../getting-started/plans-and-credits) for details.

## What the AI can do

The AI agent can handle a wide range of configuration tasks:

- **Set up identity** — "Make this a GitHub monitoring agent that alerts on CI failures."
- **Add skills** — "Add a skill that researches topics across the web and builds a summary."
- **Configure heartbeat** — "Check my GitHub repos every 15 minutes for new PRs."
- **Manage memory** — "Remember that our main repo is github.com/acme/api."
- **Build canvas dashboards** — "Create a dashboard showing open PRs, CI status, and issue count."
- **Customize behavior** — "Only alert on P0 and P1 tickets. Batch everything else into a daily digest."

:::tip Tools, channels, and skills
Skills are configured through chat — ask the AI to add, modify, or remove skills. You can also view your agent's skills in the **Capabilities** tab (which has **Skills** and **Tools** sub-tabs). To connect external tools (GitHub, Stripe, etc.), use the **Tools** sub-tab. To connect messaging channels (Slack, Telegram, Discord), use the **Channels** tab.
:::

## What the AI actually produces

When you send a message, the AI isn't just responding in chat — it's editing files in your agent's workspace. Every configuration change is a real file write that persists. This makes the system transparent and reversible.

| What you say | What changes |
|-------------|-------------|
| "Make this a GitHub monitoring agent" | Rewrites `AGENTS.md` with monitoring instructions |
| "Add a skill that triages tickets" | Creates `skills/ticket-triage.md` |
| "Check GitHub every 15 minutes" | Edits `HEARTBEAT.md` and `config.json` |
| "Remember our main repo is acme/api" | Writes to `MEMORY.md` |
| "Give the agent a calmer personality" | Edits `SOUL.md` |
| "Build a revenue dashboard" | Writes canvas layout via canvas tools |
| "Set quiet hours to midnight–8am" | Updates `config.json` |

You can browse all workspace files in the **Files** tab to see exactly what the AI has configured. See [Workspace Files](/concepts/workspace-files) for the full breakdown.

## Tips for writing good messages

### Be specific

The more detail you provide, the better the result.

**Less effective:**
> "Monitor my repos."

**More effective:**
> "Monitor the acme/api and acme/web repos on GitHub. Check CI status every 15 minutes. Alert me on Slack immediately if any build fails on the main branch."

### One thing at a time

Break complex configurations into smaller steps. This gives you more control and makes it easier to iterate.

**Instead of this:**
> "Set up a complete support desk with ticket triage, SLA tracking, escalation rules, Zendesk integration, Slack alerts, and a dashboard."

**Try this sequence:**
> 1. First, connect Zendesk through the **Capabilities** tab.
> 2. "Build a support dashboard with open tickets, response times, and priority breakdown."
> 3. "Alert me on Slack for any P0 or P1 tickets."
> 4. "Send a daily digest of all new tickets every morning at 9am."

### Describe the outcome you want

You don't need technical language. Describe what you want your agent to achieve.

> "I want to know immediately if any of our services go down. Check health endpoints every 10 minutes and post to our #incidents Slack channel if anything fails."

### Attach images for context

You can attach screenshots or diagrams to your messages. This is helpful when you want a specific canvas layout or are showing an error.

## The chat interface

### Message history

Your entire conversation history is preserved for each agent. You can scroll up to see previous messages and the changes the AI made.

### Session management

Each time you open an agent, a new chat session begins. Previous sessions are saved and can be reviewed via the session picker in the chat panel.

### Streaming responses

When the AI is working, you'll see its response stream in real time. Tool calls and configuration changes appear as they happen.

## FAQ

**Is there a limit to message length?**
There's no strict limit, but shorter, focused messages tend to produce better results than very long ones.

**Can the AI remember context from earlier messages?**
Yes. The AI has context of your conversation within the current session. It understands your agent's current configuration and what changes have been made.

**What if the AI makes a mistake?**
You can ask it to undo or adjust. You can also revert to a previous version using [History and Checkpoints](./history-and-checkpoints).

**Does the AI work with templates?**
Yes. If you start from a template, the AI understands the existing agent configuration and can modify and extend it.
