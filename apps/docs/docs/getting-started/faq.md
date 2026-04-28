---
sidebar_position: 4
title: FAQ
slug: /getting-started/faq
---

# Frequently Asked Questions

## General

### What is Shogo?

Shogo is an AI-powered platform for building autonomous AI agents. You describe what you want your agent to do in plain language, and the AI configures it for you. Agents can monitor systems, process messages, run scheduled tasks, remember context, and display results on visual dashboards.

### Do I need to know how to code?

No. You build and configure your agent entirely through chat. The AI handles the technical details — skills, integrations, memory, and heartbeat scheduling.

### What kind of agents can I build?

You can build agents that monitor GitHub repos, triage support tickets, research topics, track revenue, manage projects, prepare for meetings, respond to incidents, track habits, and much more. See [What can you build?](./welcome#what-can-you-build) for examples.

### Is Shogo free?

Yes — the free plan includes $0.50 of AI usage per day (up to $3/month). Paid plans are available when you need more (Basic $8/mo, Pro $20/seat/mo, Business $40/seat/mo). See [Plans and Pricing](./plans-and-pricing) for details.

## Building agents

### How do I start a new agent?

From your dashboard, type a description in the chat input to start from scratch, or click a template card from the **Templates** tab. See the [Quick Start guide](./quick-start) for a full walkthrough.

### How does the AI chat work?

The chat panel is where you configure your agent. Type a message describing what you want (e.g., "Monitor my GitHub repos and alert me on CI failures"), and the AI will set up the skills, integrations, and heartbeat schedule for you.

### What are templates?

Templates are pre-built agent configurations that give you a head start. Instead of starting from scratch, you can choose a template like Research Assistant, GitHub Ops, or Personal Assistant and customize it through chat. Each template comes with a pre-configured identity, skills, heartbeat schedule, and recommended integrations. See [Templates](../templates/) for the full list.

### What is the heartbeat?

The heartbeat is a scheduled check that makes your agent proactive. Instead of only responding when you message it, your agent wakes up at regular intervals to check for new work — new PRs, support tickets, upcoming meetings, habit reminders, or anything else in its heartbeat checklist.

### What are skills?

Skills are modular capabilities defined as Markdown files. Each skill teaches your agent how to perform a specific task, like researching a topic, triaging a ticket, or running a health check. Templates come with pre-installed skills, and you can create custom skills through chat.

### What is agent memory?

Agents have persistent Markdown-based memory that persists across conversations. Your agent can save important information — research findings, user preferences, tracked topics — and recall it later. Memory is searchable and organized by topic.

### Can I attach images to my messages?

Yes, you can attach screenshots or reference images to help the AI understand what you want.

### What is the canvas?

The canvas is a visual dashboard that your agent builds to display information. It can show metrics, charts, tables, status indicators, and more. The canvas is not an interactive application — it displays summaries and dashboards.

## Tools and integrations

### What tools can my agent connect to?

Agents connect to external tools via Composio, which supports 250+ integrations including GitHub, Slack, Discord, Telegram, Google Calendar, Stripe, Zendesk, Linear, Sentry, Datadog, and more.

### How do I connect a tool?

Open the **Capabilities** tab in your agent project, then switch to the **Tools** sub-tab and search for the tool you want. Tools that use OAuth will open a popup to authenticate. Some tools require API keys, which you enter directly in the form.

### How do I connect a channel?

Open the **Channels** tab in your agent project and fill in the credential form for the messaging platform you want (e.g., a Slack Bot Token or Telegram Bot Token).

### Can my agent send me messages?

Yes. Connect a channel like Slack, Discord, or Telegram via the **Channels** tab, and your agent can proactively send you alerts, reminders, and digests.

## Workspaces and collaboration

### What is a workspace?

A workspace is a shared space where you and your team can organize agents. Each workspace has its own billing, members, and agent list. You can be a member of multiple workspaces.

### Can I invite team members?

Yes. Go to **Settings > People** and send invitations by email. Members can be assigned the role of **Owner**, **Admin**, **Editor**, or **Viewer**.

### Can I share an agent with someone?

Yes. You can share agents within your workspace. Use the sharing settings to control who can view and edit.

## Account and billing

### How does usage work?

Every request — LLM tokens, image generation, voice minutes — is billed at the AI provider's raw cost plus a flat 20% markup. There are no credits and no unit conversions: simpler interactions cost less than complex ones, and the chat input shows an estimated dollar cost before you send. See [Plans and Pricing](./plans-and-pricing) for details.

### What happens when I run out of included usage?

You won't be able to send paid messages to the AI until your daily / monthly included pool resets, or until you upgrade or enable usage-based overage. Your existing agents continue running (heartbeat and channel processing are not affected).

### How do I change my plan?

Go to **Settings > Billing** to view your current plan and upgrade or downgrade. Changes take effect immediately for upgrades, and at the next billing period for downgrades.

### How do I cancel my subscription?

Go to **Settings > Billing** and click on your subscription management link. You can cancel at any time, and you'll retain access until the end of your current billing period.

## Technical

### What technologies does Shogo use?

Agents run on isolated pods with an AI gateway powered by Claude. The heartbeat system, memory, and skills are all managed by the agent runtime. You don't need to know any of these details — the chat handles everything.

### Where is my data stored?

Agent data (memory, configuration, skills) is stored securely on our infrastructure with per-agent isolation.
