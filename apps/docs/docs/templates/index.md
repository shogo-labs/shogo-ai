---
sidebar_position: 1
title: Browse Templates
slug: /templates
---

# Agent Templates

Templates are pre-built agent configurations that give you a head start. Instead of building from scratch, pick a template that's close to what you need and customize it through chat.

## Why start from a template?

- **Save time** — Each template comes with a configured identity, skills, heartbeat schedule, and recommended integrations.
- **Learn by example** — See how skills, memory, and heartbeat work together in a real agent.
- **Proven patterns** — Templates are built around common agent use cases.
- **Fully customizable** — Everything can be changed through chat after you start.

## Available templates

| Template | Heartbeat | Canvas | What it does |
|----------|-----------|--------|-------------|
| [Research Assistant](/templates/research-assistant) | Every 60 min | Topics table, article list, key takeaways card | Researches tracked topics, delivers daily briefings |
| [GitHub Ops](/templates/github-ops) | Every 15 min | PR queue table, CI status badges, issues table | Monitors repos for CI failures, PR reviews, critical issues |
| [Support Desk](/templates/support-desk) | Every 30 min | Ticket volume chart, priority breakdown, SLA status | Triages support tickets, escalates P0s, sends digests |
| [Meeting Prep](/templates/meeting-prep) | Every 60 min | Upcoming meetings card, attendee notes, action items | Preps briefs before meetings, tracks follow-ups |
| [Revenue Tracker](/templates/revenue-tracker) | Daily | MRR metric, revenue chart, invoices table | Tracks revenue metrics, flags failed payments |
| [Project Board](/templates/project-board) | Every 60 min | Sprint progress, velocity chart, tasks table | Tracks sprint status, collects standups, surfaces blockers |
| [Incident Commander](/templates/incident-commander) | Every 10 min | Service health grid, incidents table, uptime metrics | Monitors service health, pages on-call for outages |
| [Personal Assistant](/templates/personal-assistant) | Every 60 min | Habits tracker, reminders list, daily agenda | Habit tracking, morning briefings, proactive reminders |

## How templates work

When you select a template, Shogo sets up:

1. **Identity files** — `IDENTITY.md` and `SOUL.md` that define your agent's personality and behavior
2. **Agent instructions** — `AGENTS.md` with detailed behavior rules and canvas strategies
3. **Heartbeat checklist** — `HEARTBEAT.md` defining what your agent checks on each scheduled run
4. **Skills** — Pre-installed skill files that teach your agent specific capabilities
5. **Configuration** — Heartbeat interval, model settings, and quiet hours

After setup, an onboarding message walks you through what's been configured and how to customize it.
