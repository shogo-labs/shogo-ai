---
sidebar_position: 1
title: Glossary
slug: /reference/glossary
---

# Glossary

Plain-language definitions of terms you may encounter while using Shogo.

## Shogo concepts

### Agent
An autonomous AI process you build in Shogo. Agents can monitor systems, process messages, run scheduled tasks, remember context, and display results on a canvas dashboard. Each agent runs in an isolated pod.

### AGENTS.md
A workspace file that defines your agent's core behavior rules, canvas strategy, heartbeat behavior, and recommended integrations.

### Canvas
A visual dashboard that your agent builds to display information. The canvas shows metrics, charts, tables, status indicators, and more. It is not an interactive application — it presents summaries and dashboards.

### Channel
A messaging platform connected to your agent (Slack, Discord, Telegram, etc.). Channels let your agent send proactive alerts and receive messages from users.

### Chat panel
The left side of the agent workspace where you type messages to configure and interact with your agent. This is the primary way you build and modify your agent.

### Checkpoint
A saved snapshot of your agent at a specific point in time. Checkpoints let you go back to a known good state. You can create them manually or they're created automatically at key moments.

### Composio
The integration platform that connects your agent to 250+ external tools. When you connect GitHub, Slack, Stripe, etc. through the Capabilities panel, it uses Composio under the hood. Some tools use OAuth, others require API keys.

### Usage
Spend in Shogo is denominated in US dollars. Every AI request is billed at the provider's raw cost plus a flat 20% markup — there are no credits or unit conversions. Each plan includes a fixed amount of monthly usage; overage (when enabled) is metered and billed by Stripe.

### Dashboard
The main page of your workspace. Has a chat input at the top for creating new agents, and tabs for **Templates**, **My projects**, and **Shared with me**.

### Heartbeat
A scheduled check that makes your agent proactive. On each heartbeat cycle, the agent wakes up and runs through its HEARTBEAT.md checklist — checking for new PRs, tickets, calendar events, or whatever it's configured to monitor. The interval is configurable (e.g., every 10 minutes, hourly, daily).

### HEARTBEAT.md
A workspace file that defines what your agent checks on each scheduled heartbeat run. It contains a checklist of tasks like "Check CI status" or "Scan for new tickets."

### IDENTITY.md
A workspace file that defines your agent's name, emoji, and tagline. This shapes how the agent presents itself.

### Memory
Persistent Markdown-based storage that your agent uses to remember information across conversations. Agents can save research findings, user preferences, tracked topics, and more. Memory is searchable and organized by topic.

### Project
An agent you're building in Shogo. Each project has its own configuration, chat history, and workspace files. Projects live inside workspaces.

### Quiet hours
A time window during which your agent suppresses non-urgent alerts. Critical alerts (like service outages) can still break through quiet hours depending on configuration.

### Skill
A modular capability defined as a Markdown file. Each skill teaches your agent how to perform a specific task, like researching a topic, triaging a ticket, or running a health check. Skills are configured through chat and can be viewed in the **Skills** sub-tab of the Capabilities panel.

### SOUL.md
A workspace file that defines your agent's personality, tone, and behavioral boundaries. It shapes how the agent communicates and what guardrails it follows.

### Template
A pre-built agent configuration that you can use as a starting point. Templates include configured identity, skills, heartbeat schedule, and recommended integrations. See [Templates](../templates/).

### USER.md
A workspace file where your agent stores information about you — your name, timezone, preferences, and other context that helps it serve you better.

### Workspace
A shared space that contains agents and members. Workspaces have their own billing, usage pool, and team. You can belong to multiple workspaces.

## General technology terms

### API (Application Programming Interface)
A way for different software systems to communicate with each other. Your agent uses APIs to connect with external tools like GitHub, Slack, and Stripe.

### Authentication
The process of verifying identity — typically through login with email and password, or OAuth with an external service.

### CRUD
An acronym for Create, Read, Update, Delete — the four basic data operations. Canvas dashboards can include CRUD tables for managing data like tickets, tasks, or invoices.

### OAuth
A method that lets your agent securely connect to external services (GitHub, Slack, Google, etc.) using your existing accounts, without sharing passwords.

## Canvas elements

### Card
A rectangular container on the canvas used to display related information together — like a meeting prep card or a research summary.

### Chart
A visual data representation on the canvas, like a line chart for revenue trends or a bar chart for ticket volume.

### KPI / Metric
A key performance indicator displayed on the canvas as a prominent number with optional trend indicator — like "MRR: $12,500 (+8%)."

### Table
A grid of rows and columns on the canvas for displaying structured data, like a list of open PRs or support tickets.
