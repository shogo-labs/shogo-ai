---
sidebar_position: 4
title: Troubleshooting with Prompts
slug: /prompting/troubleshooting-with-prompts
---

# Troubleshooting with Prompts

Sometimes the AI doesn't get it right the first time, or things need adjustment as your agent grows. This guide helps you get back on track.

## When the result isn't what you expected

### Be more specific about what's wrong

Instead of:
> "This isn't right. Fix it."

Try:
> "The heartbeat is checking GitHub every 30 minutes, but I want it to check every 15 minutes. Also, it's alerting on all branches — I only want alerts for main and staging."

The more precisely you describe the gap between what you have and what you want, the better the fix.

### Show, don't just tell

Attach a screenshot if the canvas dashboard doesn't look right:

> "Here's what the dashboard looks like now [attach screenshot]. The KPI cards are too small and the chart is missing the revenue trend line. I want larger cards with trend arrows and a line chart showing the last 90 days."

## When something breaks

### Describe the problem clearly

Use this format:
> "When my agent [does what], [what happens]. I expected [what should happen]."

**Example:**
> "When the heartbeat runs, the agent checks GitHub but doesn't send Slack alerts for CI failures. I expected it to post to #incidents whenever a build fails on main."

### Ask the AI to investigate

> "The heartbeat stopped sending morning digests. It was working before I added the new GitHub monitoring skill. Can you investigate what happened?"

> "My agent's canvas dashboard is showing stale data. The metrics haven't updated in 24 hours. Can you check what's wrong?"

### Revert if needed

If changes made things worse, don't keep layering fixes. Revert to a working version first:

1. Open the **session picker** in the chat panel.
2. Find the last session where things worked.
3. Revert to that version.
4. Try a different approach to your request.

See [History and Checkpoints](../features/history-and-checkpoints) for details on reverting.

## When the AI gets stuck in a loop

Sometimes the AI might repeatedly try to fix something without success. Signs of this:

- The same issue keeps appearing after multiple fix attempts
- Changes seem to undo each other
- Configuration keeps breaking in different ways

**What to do:**

1. **Stop and revert** — Go back to the last working version.
2. **Describe the goal differently** — Use different words or break the task into smaller pieces.
3. **Simplify the request** — Instead of asking for the full feature, ask for a simpler version first.

**Example:**

Instead of:
> "Set up a complex incident response system with multi-source correlation, escalation chains, and automated runbooks."

Try:
> "Start with a simple health check that pings three URLs every 10 minutes. If any return non-200, alert me on Slack. Let's get that working first."

Then add complexity incrementally.

## Common issues and how to fix them

### Heartbeat not running

> "My agent's heartbeat doesn't seem to be running. Can you check the heartbeat configuration and make sure it's enabled with the right interval?"

### Integrations not connecting

> "I connected GitHub through the Capabilities panel but the integration isn't working. Can you check the connection status?"

### Canvas dashboard showing stale data

> "The dashboard metrics haven't updated since yesterday. Can you check if the heartbeat is refreshing the canvas data?"

### Alerts not sending

> "The agent detects issues but doesn't send Slack alerts. Can you verify the channel connection and alert configuration?"

## The "fresh start" approach

If a feature is really not working, sometimes the best approach is to ask the AI to start that specific part over:

> "The ticket triage skill isn't working well. Can you remove it and rebuild it from scratch? Here's what I need: [clear description]."

This is better than trying to patch broken configuration repeatedly.

## Asking for help

Remember, you can always ask the AI for guidance:

> "I'm not sure what's going wrong. Can you check the current agent configuration and tell me if you see any issues?"

> "I've tried to fix this three times. Can you suggest a different approach?"

> "Before making any changes, can you explain what might be causing this problem?"

## Prevention tips

:::tip Build incrementally
The best way to avoid problems is to configure one feature at a time and verify it before moving on. Most issues come from trying to do too much at once.
:::

:::tip Test as you go
After each change, check that your agent's behavior matches your expectations. Verify heartbeat runs, check that alerts arrive, and review canvas dashboards.
:::

:::tip Save before experiments
Before trying something ambitious, make sure you have a recent checkpoint. See [History and Checkpoints](../features/history-and-checkpoints).
:::
