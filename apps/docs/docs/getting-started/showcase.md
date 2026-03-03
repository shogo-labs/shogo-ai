---
sidebar_position: 4
title: What People Build
slug: /getting-started/showcase
---

# What People Build

Real examples of agents built with Shogo — what they monitor, how they're configured, and what they produce.

---

## GitHub Ops monitor

**Use case:** Engineering team at a 12-person startup

**The problem:** CI failures were getting missed, PRs were sitting without reviewers for days, and the team had no shared visibility into repo health.

**The agent:**
- Watches 4 GitHub repos every 15 minutes
- Posts to Slack #incidents immediately when any build fails on main
- Sends a 9am digest to #engineering: open PRs, any stale reviews, yesterday's merges
- Canvas shows a live PR queue with CI status badges per repo

**Sample alert:**
> CI failure: `acme/api` main — Build #412 failed. 3 tests failing in `src/auth`. [View run →]

**Sample morning digest:**
> Good morning. 7 open PRs across 4 repos — 2 ready for review, 1 pending CI. 4 merged yesterday. No new critical issues.

**Key configuration:**
```
Heartbeat: every 15 min
Quiet hours: midnight–7am PT (CI failures still break through)
Channels: Slack #incidents (urgent), #engineering (daily)
```

---

## Revenue tracker

**Use case:** Solo founder managing a SaaS product

**The problem:** Checking Stripe manually every morning, losing track of failed payments, and having no clear picture of month-to-date MRR.

**The agent:**
- Checks Stripe daily for revenue metrics and failed payments
- Flags any failed payment immediately via Telegram
- Canvas shows MRR with 30-day trend, new subscribers, and churn
- Sends a weekly Sunday summary: MRR, new ARR, churn for the week

**Canvas dashboard:**

```
MRR              New Subscribers    Churn
$48,200          +12 this month       2
▲ 8% vs last                      ▼ 0.4%

Recent Invoices
───────────────────────────────────────────
Invoice #8821  Acme Corp    $2,400   Paid
Invoice #8820  Beta Inc     $1,200   Failed  ← flagged
Invoice #8819  Gamma LLC      $800   Paid
```

**Key configuration:**
```
Heartbeat: daily at 7am PT
Channels: Telegram (immediate alerts for failed payments)
```

---

## Support desk

**Use case:** Customer success team handling inbound tickets

**The problem:** P0 tickets were getting missed in a busy inbox, SLA compliance was being tracked manually in a spreadsheet, and there was no easy way to see ticket volume trends.

**The agent:**
- Polls Zendesk every 30 minutes for new tickets
- Routes P0 tickets to an immediate Slack DM + posts in #customer-success
- Sends a 9am summary to #customer-success: overnight tickets, open queue, SLA status
- Canvas shows ticket volume chart (7 days), priority breakdown, and open tickets by assignee

**Sample P0 alert:**
> P0 ticket: "API completely down — can't process payments" from Enterprise customer Acme Corp. Assigned to: unassigned. [View ticket →]

**Key configuration:**
```
Heartbeat: every 30 min
Channels: Slack #customer-success (digests and P1-P3), DM to @on-call (P0 only)
```

---

## Research assistant

**Use case:** Researcher tracking developments in AI safety

**The problem:** Keeping up with arXiv papers, blog posts, and news across multiple sources was taking 45+ minutes every morning. Important papers were getting missed entirely.

**The agent:**
- Searches for new AI safety papers, blog posts, and news every morning
- Sends a curated Telegram briefing by 8am with 5-8 items, each with a one-line summary and link
- Remembers past findings so it doesn't repeat covered stories
- Canvas shows a running list of tracked papers with relevance scores and notes

**Sample morning briefing (Telegram):**
> **AI Safety — Jan 17**
> 
> **Top story:** OpenAI releases new alignment research on reward hacking — significant findings on goal misgeneralization in RLHF. [arXiv →]
> 
> • Anthropic blog: New constitutional AI paper with empirical results [link]
> • DeepMind: Scalable oversight paper posted to arXiv [link]
> • LessWrong: Post on mesa-optimization getting significant discussion [link]
> • Nature: Coverage of AI governance proposals in EU [link]
> 
> *Nothing urgent. Next briefing tomorrow at 8am.*

**Key configuration:**
```
Heartbeat: daily at 7:30am PT
Memory: tracked topics, past findings, sources to prioritize
Channels: Telegram (briefing), Slack (occasional deep-dives)
```

---

## Personal assistant

**Use case:** Founder managing a busy schedule

**The problem:** Forgetting habit streaks, missing meeting prep, and no consistent "daily briefing" for the workday ahead.

**The agent:**
- Sends a 7:30am Telegram morning briefing: weather, calendar for the day, habits to track, top 3 priorities
- Checks calendar 1 hour before each meeting and sends prep context (attendees, previous notes)
- Tracks daily habits (exercise, meditation, reading) and sends an evening check-in
- Reminds about anything flagged as important from previous conversations

**Sample morning message (Telegram):**
> **Good morning, Alex — Tuesday Jan 17**
> 
> **Today's calendar (4 events):**
> 9:00am — Standup (30 min)
> 11:00am — 1:1 with Sarah [prep reminder at 10am]
> 2:00pm — Investor update call [prep reminder at 1pm]
> 4:00pm — Team retro
> 
> **Habits:** 3-day streak on exercise. Reading: 2 days since last session.
> 
> **Reminder:** Follow up with James about the database migration (you flagged this yesterday).

**Key configuration:**
```
Heartbeat: daily at 7:30am + 1 hour before each calendar event
Memory: preferences, ongoing projects, habit tracking, contacts
Channels: Telegram
```

---

## Incident commander

**Use case:** DevOps team at a 30-person company

**The problem:** Services were going down and the on-call engineer was the last to know. Post-incident reviews were inconsistent, and there was no shared dashboard for service health.

**The agent:**
- Pings health endpoints for 8 services every 10 minutes
- Posts to Slack #incidents immediately on failure, with the error and affected service
- Updates the canvas status board in real time (green/red per service)
- Writes an incident log entry to memory for post-incident review

**Canvas status board:**

```
Service Health — Last checked: 2:47pm

api.acme.com          ● Healthy    99.97% (30d)
auth.acme.com         ● Healthy    99.99% (30d)
payments.acme.com     ✕ Degraded   [Alert sent]
webhooks.acme.com     ● Healthy   100.00% (30d)
admin.acme.com        ● Healthy    99.94% (30d)
```

**Key configuration:**
```
Heartbeat: every 10 min (no quiet hours — 24/7)
Channels: Slack #incidents (all alerts), PagerDuty via webhook (P0 only)
```

---

## Project board

**Use case:** Engineering manager tracking team velocity

**The problem:** Sprint planning was happening without good visibility into historical velocity. There was no easy weekly summary for the team.

**The agent:**
- Syncs with Linear every hour for sprint progress
- Sends a Friday afternoon Slack summary: completed tickets, remaining, velocity vs last sprint
- Canvas shows a Kanban-style view with issue counts per column, a velocity chart, and open blockers

**Key configuration:**
```
Heartbeat: hourly (sprint tracking), weekly on Friday 4pm (digest)
Channels: Slack #engineering (weekly summary)
```

---

## Build yours

These are just starting points. The agents people build most often start as one of the templates above and evolve over weeks as they add integrations, tune the heartbeat, and teach the agent their preferences through memory.

**Start from a template** — [Browse templates →](/templates/)

**Or describe what you want** — Type it into the chat input on your dashboard and the AI will configure it for you.
