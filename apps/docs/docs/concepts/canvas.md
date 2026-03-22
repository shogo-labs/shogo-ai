---
sidebar_position: 5
title: Canvas
slug: /concepts/canvas
---

# Canvas

The canvas is the visual dashboard your agent builds and updates. It lives in the right panel of your agent project and displays whatever your agent finds useful — KPI metrics, data tables, charts, status indicators, and more.

The canvas is **not an interactive application**. It's a display layer — think of it as your agent's reporting surface. The agent writes to it, and you read it.

## What the canvas can show

The canvas is built from components. The AI can combine them freely to create any layout.

### Data components

**Metric (KPI card)**

Displays a single number with an optional label and trend indicator. Used for at-a-glance measurements.

```
MRR                    Open PRs              API Uptime
$48,200                    12                  99.97%
▲ 8% vs last month     +3 this week          ▼ 0.02%
```

**Chart**

Visualizes data over time or by category. Supports line, bar, horizontal bar, area, pie, donut, and progress charts.

**Table**

A grid of rows and columns for structured data — open tickets, recent PRs, invoices, repository activity.

**DataList**

A vertical list of items with labels and values. Good for key-value pairs and settings summaries.

### Display components

**Card** — A container with a title and optional border. Used to group related information together.

**Text** — Headings, body text, captions, code snippets, muted labels.

**Badge** — A small label with color variants. Used for status indicators (e.g., `Active`, `Failed`, `Pending`).

**Alert** — A highlighted callout for warnings, errors, or important notices.

**Progress** — A horizontal progress bar, useful for completion percentages.

**Separator** — A dividing line between sections.

**Icon** — One of 40+ icons (arrows, checks, alerts, domain icons like dollar, calendar, globe, etc.)

### Layout components

**Row / Column** — Arrange components horizontally or vertically.

**Grid** — Multi-column grid layout.

**Tabs / TabPanel** — Tabbed sections for organizing multiple views.

**Accordion / AccordionItem** — Collapsible sections.

**ScrollArea** — A scrollable container for long content.

### Interactive components

**Button** — Triggers an agent action when clicked (e.g., "Refresh data", "Mark resolved").

**TextField / Select / Checkbox** — Input elements for simple forms.

**ChoicePicker** — A set of options to choose from.

:::note
Interactive components that trigger actions (like a Button) still route through the agent. They're not purely frontend — they send a message to the agent to take action and update the canvas.
:::

## How the canvas is updated

The agent writes to the canvas by calling canvas tools during a chat session or heartbeat run. This happens automatically — you don't need to trigger it manually.

**On heartbeat:** The agent runs its checklist, fetches fresh data, and updates the canvas with new values.

**On chat:** When you ask for a dashboard or describe a layout change, the agent builds or updates it immediately.

**Via a Button:** Clicking a canvas button sends a request to the agent, which takes action and updates the canvas in response.

## Prompting for a canvas

You don't need to know the component names to describe what you want. Describe it the way you'd describe a report or dashboard to a colleague.

**Examples:**

> "Build a dashboard with our key metrics at the top — MRR, churn rate, and active subscriptions — and a table of recent invoices below."

> "I want three tabs: Overview, GitHub Activity, and Support. Overview should show API status and uptime. GitHub should show open PRs in a table. Support should show ticket volume as a bar chart."

> "Add a section showing CI status for each of our repos. Use green badges for passing, red for failing."

> "Create a status card at the top showing whether the service is healthy or degraded, with a timestamp of the last check."

### Tips for better canvas prompts

**Name your sections.** "A section called Incidents, a section called System Health" gives the AI clear structure to work with.

**Describe the data, not just the look.** "A table of open GitHub PRs with columns for repo, title, author, and age" is better than "a table of PRs."

**Include trend information if you want it.** "Show MRR with a week-over-week percentage change" explicitly asks for trend arrows — they're not added by default.

**Reference your connected tools.** "Using our Stripe data" or "using the GitHub repos we configured" tells the agent where to pull the data from.

## The canvas updates automatically

Once configured, the canvas refreshes on every heartbeat tick without you doing anything. Each tick:

1. Agent runs the heartbeat checklist
2. Fetches fresh data from connected tools (GitHub, Stripe, etc.)
3. Updates the canvas components with the latest values
4. Sends an alert to your channel if anything needs attention

You can also ask for a manual refresh at any time:

> "Refresh the dashboard with the latest data."

## Canvas examples by template

| Template | Canvas includes |
|----------|----------------|
| Research Assistant | Key takeaways card, article table with source links, topic breakdown |
| GitHub Ops | Open PR queue table, CI status badges per repo, issues table |
| Support Desk | Ticket volume chart, SLA status, priority breakdown, open tickets table |
| Revenue Tracker | MRR metric with trend, failed payments table, revenue chart (30 days) |
| Incident Commander | Service health status grid, recent incidents table, uptime metrics |
| Project Board | Sprint progress, velocity chart, tasks table with assignees |

## Related

- [Heartbeat](/concepts/heartbeat) — the canvas is updated on each heartbeat tick
- [Chat with AI](/features/chat-with-ai) — how to describe canvas changes through chat
- [Templates](/templates/) — each template includes a pre-built canvas dashboard
