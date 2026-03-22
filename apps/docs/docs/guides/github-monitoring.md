---
sidebar_position: 1
title: GitHub Monitoring Agent
slug: /guides/github-monitoring
---

# Guide: GitHub Monitoring Agent

This guide walks you through setting up a GitHub monitoring agent from scratch — one that watches your repos for CI failures, new PRs, and critical issues, alerts your team on Slack, and keeps a PR dashboard current on the canvas.

**Time to complete:** ~10 minutes

**What you'll build:**
- Heartbeat that checks GitHub every 15 minutes
- Immediate Slack alerts on CI failures
- Daily PR digest to your engineering Slack channel
- Canvas dashboard showing open PRs and CI status

---

## Step 1: Start from the GitHub Ops template

The GitHub Ops template is the fastest starting point. From your dashboard, click the **GitHub Ops** template card.

This creates an agent with:
- Heartbeat enabled at 15-minute intervals
- `github-ops` and `pr-review` skills pre-installed
- A canvas dashboard layout pre-configured

When the agent opens, it will describe what's been set up and ask what you want to customize.

:::tip Starting from scratch instead?
If you prefer to build from scratch, type in the dashboard chat input: _"Build me a GitHub monitoring agent that checks for CI failures and new PRs."_ The AI will set up the same configuration through chat.
:::

---

## Step 2: Connect GitHub

Open the **Capabilities** tab (in the right panel) and switch to the **Tools** sub-tab.

1. Search for "GitHub"
2. Click **Connect** — this opens a GitHub OAuth popup
3. Authorize Shogo to access your repositories
4. Close the popup — the tool shows as connected

Once connected, tell the agent which repos to watch:

> "Watch these repos: acme/api and acme/web. The main branch is `main`."

The agent will update its configuration and `MEMORY.md` to remember your repos.

---

## Step 3: Connect Slack

Open the **Channels** tab and find **Slack**.

Fill in your credentials:
- **Bot Token** — starts with `xoxb-`, from your Slack app settings
- **App Token** — starts with `xapp-`, from your Slack app settings

If you haven't created a Slack app yet, the Channels panel links to the setup guide.

Once Slack is connected, tell the agent where to send alerts:

> "Send urgent alerts (CI failures, critical issues) to Slack channel #incidents. Send the daily digest to #engineering."

---

## Step 4: Configure the heartbeat

The template's default heartbeat checks every 15 minutes. You can verify and customize it:

> "Show me the current heartbeat configuration."

The agent will display the current `HEARTBEAT.md` and interval. A well-configured GitHub heartbeat looks like this:

```markdown
# Heartbeat Checklist

## Every heartbeat (15 min)
- Check CI status on acme/api main branch — alert immediately on failure
- Check CI status on acme/web main branch — alert immediately on failure
- Scan acme/api for new issues labeled "critical" or "bug:high"
- Flag any PRs with no reviewer assigned for longer than 24 hours

## Daily at 9am PT
- Send a PR digest to #engineering: open PRs, any stale reviews, merged yesterday
- Check for any open security advisories across both repos
```

Adjust it through chat:

> "Also check for any new issues labeled 'security' and alert immediately."

> "Change the daily digest to 8:30am PT instead of 9am."

---

## Step 5: Set up the canvas dashboard

Ask the agent to build a dashboard:

> "Build a canvas dashboard with: CI status for each repo (green/red badge), a table of open PRs with columns for repo, title, author, age, and CI status, and a count of open issues by label."

The agent will create the dashboard and populate it with data from your connected GitHub repos. After the first heartbeat tick, it will refresh automatically.

You can iterate on the layout:

> "Add a section at the top showing the last time CI passed on each repo."

> "Group the PR table by repo, not by date."

---

## Step 6: Verify everything is working

To test the setup without waiting for the next heartbeat:

> "Trigger the heartbeat now and tell me what you found."

The agent will run through the checklist and report back. If something isn't working (GitHub isn't returning data, Slack isn't connected), it will tell you what to fix.

**Common checks:**
- _"Is GitHub connected? What repos can you see?"_
- _"What's the current CI status on acme/api main?"_
- _"What open PRs are there right now?"_

---

## Step 7: Configure quiet hours (optional)

By default, the heartbeat respects quiet hours (11pm–7am UTC). For a CI monitoring agent, you may want 24/7 alerts for P0 failures but not for routine updates:

> "Set quiet hours to midnight–7am PT. During quiet hours, only alert for CI failures — not for new PRs or issue summaries."

---

## What it looks like when running

Once set up, your agent will:

**Every 15 minutes:**
- Silently check GitHub and send `HEARTBEAT_OK` internally if nothing is wrong
- Post to Slack immediately if CI fails: _"CI failure: acme/api main — Build #412 failed. 3 tests failing in auth module. [View run →]"_

**Every morning at 9am:**
- Send a digest to #engineering: open PR count, any stale reviews, what merged yesterday

**Canvas:** Always shows current CI status and the live PR queue, updated on every tick.

---

## Customization ideas

- _"Add monitoring for acme/mobile repo as well."_
- _"Alert me if the same test fails 3 times in a row — but not for one-off failures."_
- _"When a PR gets 2 approvals, post a 'ready to merge' note in #engineering."_
- _"Track which team members have the most open PRs and include that in the weekly summary."_
- _"If a PR is labeled 'urgent', DM me on Slack directly."_

---

## Related

- [GitHub Ops template](/templates/github-ops) — full template description
- [How the Heartbeat Works](/concepts/heartbeat) — deep dive on heartbeat configuration
- [Canvas](/concepts/canvas) — how the dashboard components work
