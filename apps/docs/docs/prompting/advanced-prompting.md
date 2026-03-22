---
sidebar_position: 3
title: Advanced Prompting
slug: /prompting/advanced-prompting
---

# Advanced Prompting

Once you're comfortable with the basics, these techniques will help you configure agents faster and get more precise results.

## Iterative refinement

Building with AI is a conversation, not a one-shot request. The best results come from an iterative approach:

1. **Start broad** — Describe the overall agent purpose or feature you want.
2. **Review the result** — Check what was configured.
3. **Refine in follow-ups** — Ask for specific adjustments.

**Example sequence:**

> "Set up this agent to monitor my GitHub repos and alert on issues."

*Review: The heartbeat is checking repos but only looking at PRs.*

> "Also check CI status on every heartbeat. Alert immediately on any build failures on the main branch."

*Review: Good, but alerts are too noisy.*

> "Only alert on failures for the main and staging branches. Ignore feature branches. Batch PR updates into a daily digest."

Each step builds on the last, giving you fine-grained control.

## Setting constraints

Tell the AI what *not* to do, as well as what to do. This prevents unintended side effects.

> "Update the heartbeat to check every 10 minutes instead of 30. Don't change any of the existing skills or integrations."

> "Add a revenue tracking skill. Don't modify the existing support desk behavior."

> "Change the alert channel to #ops-alerts. Keep the daily digest going to #general."

## Describing complex dashboards

For detailed canvas dashboards, describe the structure in sections:

> "Build a dashboard with this layout:
> - **Top row**: Four KPI cards showing MRR, Active Customers, Churn Rate, and Support Tickets.
> - **Middle section**: A line chart showing weekly revenue trend for the last 3 months.
> - **Bottom section**: Two tables side by side. Left table shows recent payments (customer, amount, date, status). Right table shows open support tickets (subject, priority, age)."

The AI handles multi-section dashboards well when you describe each section clearly.

## Using roles and scenarios

Describe who receives what and in what context:

> "Send P0 alerts to both the #incidents Slack channel and directly to the on-call engineer via Telegram. Send P1 alerts only to #incidents. Batch P2 and below into a daily digest to #engineering."

> "Morning check-in should go to me on Telegram. Team standup summary should go to #standup on Slack."

## Asking the AI to explain

You can ask the AI to describe what's configured or help you plan:

> "What skills does my agent have right now? List them with what they do."

> "I want to add incident response capabilities. Can you walk me through what that would involve before we start configuring?"

> "What integrations is my agent connected to? Which ones are active?"

This is especially useful when you're picking up an agent after some time away.

## Referencing existing behavior

> "The heartbeat check for GitHub is working great. Set up a similar check for our GitLab repos using the same alert rules."

> "Use the same escalation priority system from the support desk for incident alerts."

## Multi-step features

For complex capabilities, lay out the plan first:

> "I want to add meeting prep capabilities. Here's what I need:
> 1. Connect Google Calendar to pull my schedule
> 2. Research external attendees by looking up their company websites
> 3. Build a prep document canvas for each meeting with agenda and background
> 4. Track action items after meetings with owners and deadlines
>
> Let's start with step 1."

Then work through each step in order, verifying as you go.

## Credit-efficient prompting

Since credits are based on token usage, longer and more complex interactions cost more:

- **Combine related small changes** — "Change the heartbeat to every 10 minutes, add the staging branch to CI monitoring, and update quiet hours to 11pm-6am" is more efficient than three separate messages.
- **Be clear the first time** — Spending a moment thinking about your prompt saves credits on back-and-forth corrections.
- **Use follow-ups wisely** — "Also add..." is often more efficient than describing the whole configuration again.

## Summary

| Technique | When to use |
|-----------|-------------|
| Iterative refinement | Configuring any feature — start broad, then refine |
| Setting constraints | When you want changes scoped to specific areas |
| Describing complex dashboards | Canvas layouts with multiple sections |
| Using roles and scenarios | Agents with different alert targets |
| Asking for explanations | Understanding current config or planning next steps |
| Multi-step features | Large capabilities that need to be built incrementally |
