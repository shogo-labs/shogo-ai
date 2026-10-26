---
sidebar_position: 4
title: Boards
slug: /features/boards
---

# Boards

Boards are Kanban boards that live in your team channels. Each department can
run its work on them: support tickets, the sales pipeline, hiring, invoice
approvals, content, contracts, bugs. People and agents work the same cards, and
you can watch it all from the channel.

A channel can hold several boards. #support might have **Tickets** and
**Bugs**, and #sales might have **Pipeline** and **Renewals**. They show up as
tabs at the top of the channel.

## Cards

Every card has a key like `SUP-42`, a column, an owner (a person or an agent),
a priority, an optional due date, and any fields the board defines (customer,
amount, close date, ...).

A card keeps its own history:

- **Thread.** Each card has a thread in its channel. Replies there are the
  card's conversation.
- **History.** Moves, assignments, field changes and agent runs are recorded
  on the card. A message anywhere in the workspace that mentions the card's key
  links to it. Private-channel messages are linked but stay hidden from people
  who can't see that channel.

Open a card to see both, side by side with the board. When an agent picks up a
card, it reads this history first, so it knows what was already tried, who
promised what, and who owns it.

## Columns

Each column has a category (backlog, active, waiting, review, done, or
dismissed), which is how Shogo knows what "open" and "finished" mean on any
board. Columns can also have:

- **SLA hours.** Cards that sit in the column longer than this are flagged as
  breaching. Cards past 80% of it are flagged as at risk.
- **WIP limit.** The board warns when a column holds more cards than this.
- **An agent.** Cards moved into the column are handed to that agent.

Boards can **require human review**. On those, agents can move cards up to a
review column, but only a person can close them. Approvals, legal review and
hiring boards use this.

## My work and channel activity

**My work** lists every open card assigned to you, across all boards. A
channel's activity feed shows card moves and finishes next to its messages, so
you can follow a department without opening each board.

## Setting up with the workspace agent

Ask the workspace agent in plain words: "Set up support and engineering so bug
reports flow to engineering", or "Make #finance private and add a Collections
board". It creates the channels, boards, department agents and triggers for
you.

It can start from templates:

| Kind | Templates |
|------|-----------|
| Companies | SaaS startup, agency, e-commerce, nonprofit, freelancer, local services |
| Departments | Support, sales, marketing, engineering, people, finance, operations, legal |
| Boards | Support tickets, bug triage, engineering problems, sales pipeline, renewals, hiring candidates, onboarding checklist, finance approvals, collections, content calendar, campaigns, vendor requests, legal review, OKRs |

A department template brings its channel (People, Finance and Legal are
private), its boards, a department agent with an hourly heartbeat, and
anything it needs to run. For example, People adds a trigger that opens an
onboarding card when someone joins the workspace. Integrations a department
relies on (Zendesk, HubSpot, GitHub, ...) are listed for you to connect by
hand.

The setup is written to `shogo-system.yaml` and applied with `system_apply`,
so it's reviewable and safe to run again: applying a template that's already
in place changes nothing.

## Department agents

Department agents work their boards on every heartbeat. They triage new cards,
chase cards that are breaching their SLA or going stale, and hand bugs to
engineering by moving the card to the Bugs board. Each one follows its
department's rules. For example, the finance agent never changes vendor bank
details, and the support agent never promises refunds.

The workspace agent, with company operations on, sweeps every board on its
heartbeat, posts a daily digest in each department channel, and posts a weekly
summary in #general.

What an agent can do on boards is set by its
[capabilities](/features/capabilities#work-capabilities):

- **Boards** lets it read and work cards.
- **Board management** lets it create and change boards, columns and
  templates.
- **Company operations** adds the heartbeat sweeps and digests.
- **Problems** turns error reports into deduplicated problem cards.

## Triggers

A trigger can turn an event into a card: a new member joining, a new support
ticket, a failed payment. Repeats of the same event update the open card
instead of opening a new one.
