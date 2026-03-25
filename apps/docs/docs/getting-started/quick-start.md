---
sidebar_position: 2
title: Quick Start
slug: /getting-started/quick-start
---

# Quick Start

Create your first AI agent in Shogo in just a few minutes. This guide walks you through every step — from signing up to having a running agent.

## Step 1: Create your account

1. Go to [shogo.dev](https://shogo.dev) and click **Sign Up**.
2. Enter your email, choose a password, and fill in your name.
3. You'll be taken to your dashboard.

:::tip Free to start
Shogo's free plan gives you 5 credits per day (up to 30 per month) — enough to explore and build your first agent.
:::

## Step 2: Create a workspace

A workspace is where your agents live. Think of it like a folder that can be shared with team members.

1. After signing up, you'll be prompted to create your first workspace.
2. Give it a name (like "My Agents" or your company name).
3. Click **Create**.

## Step 3: Start a new agent

You have two options:

### Option A: Start from a template (recommended)

Your dashboard shows a **Templates** tab with agent templates you can start from:

1. Browse the available templates on your dashboard:
   - **Research Assistant** — web research and daily briefings
   - **GitHub Ops** — PR triage and CI monitoring
   - **Support Desk** — ticket triage and escalation
   - **Meeting Prep** — calendar events and attendee research
   - **Revenue Tracker** — financial dashboards and invoice management
   - **Project Board** — sprint tracking and velocity metrics
   - **Incident Commander** — service health monitoring and alerting
   - **Personal Assistant** — habits, reminders, and daily check-ins
2. Click a template card to create your agent. It opens with a pre-configured identity, skills, and heartbeat schedule. You can customize everything from here.

### Option B: Start from scratch

1. Type a description of the agent you want in the chat input at the top of your dashboard.
2. Shogo creates a new agent and opens the chat panel where you can continue configuring it.

## Step 4: Configure your agent through chat

The chat panel is where you shape your agent. Type messages describing what you want, and the AI will configure your agent for you.

**Example prompts to try:**

> "Set up a heartbeat that checks my GitHub repos every 30 minutes and alerts me on CI failures."

> "Add a skill that researches a topic across multiple sources and builds a summary dashboard."

> "Build a dashboard showing open PRs, CI status, and issue count."

> "Track my daily habits: exercise, reading, and meditation. Send me a morning check-in."

Credits are consumed per token based on the AI model used — simpler requests cost less than complex ones. The chat input shows an estimated cost before you send. The AI will configure your agent's identity, skills, memory, and integrations based on your instructions.

## Step 5: Connect tools and channels

Your agent project has dedicated panels for connecting tools and channels. Open your agent and look at the tabs on the right side: **Canvas**, **Files**, **Capabilities**, **Channels**, **Monitor**.

### Tools and skills (Capabilities panel)

The **Capabilities** tab has two sub-tabs: **Skills** and **Tools**.

- **Skills** — View the skills the AI has configured for your agent. Skills are created and modified through chat, but you can browse them here.
- **Tools** — Search for and connect external tools like GitHub, Google Calendar, Stripe, Zendesk, Linear, and more. Tools that use OAuth will open a popup to authenticate. Some tools require API keys, which you enter directly in the form.

### Channels (Channels panel)

Open the **Channels** tab to connect messaging platforms like Slack, Discord, or Telegram. Each channel has a credential form where you enter the required tokens or keys (e.g., a Slack Bot Token or Telegram Bot Token).

## Step 6: Configure the heartbeat

The heartbeat is what makes your agent proactive. When enabled, your agent wakes up on a schedule to check for work — new tickets, CI failures, upcoming meetings, habit reminders, and anything else defined in its heartbeat checklist.

- **Templates** come with the heartbeat already enabled and a pre-configured interval (e.g., every 15 minutes for GitHub Ops, hourly for Research Assistant).
- **From-scratch agents** start with the heartbeat disabled. Ask the AI to enable it: "Enable the heartbeat and check for new PRs every 30 minutes."

You can adjust the interval, quiet hours, and heartbeat checklist anytime through chat.

## What's next?

- **[Chat with AI](../features/chat-with-ai)** — Learn how to configure your agent effectively.
- **[Templates](../templates/)** — Explore all 8 agent templates in detail.
- **[Prompting basics](../prompting/basics)** — Tips for describing what you want your agent to do.
