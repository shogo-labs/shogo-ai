---
sidebar_position: 2
title: Daily Digest Agent
slug: /guides/daily-digest
---

# Guide: Daily Digest Agent

This guide walks you through building an agent that delivers a personalized morning briefing — news on topics you care about, pulled from across the web, summarized and sent to you each day.

**Time to complete:** ~8 minutes

**What you'll build:**
- Agent that researches configured topics every morning
- Daily Slack (or Telegram) briefing with top stories and key takeaways
- Canvas dashboard with the day's findings
- Memory that tracks topics over time

---

## Step 1: Start from the Research Assistant template

From your dashboard, click the **Research Assistant** template card.

This creates an agent with:
- Hourly heartbeat
- `research-deep` and `topic-tracker` skills pre-installed
- A research canvas dashboard pre-configured

---

## Step 2: Tell the agent what to track

Once the agent opens, describe your topics:

> "I want a daily morning briefing on these topics: AI research papers, LLM developer tools, and any major security vulnerabilities in Node.js or Python ecosystems. Send it to me every day at 8am PT."

> "Also keep an eye on news about Stripe and Anthropic — anything significant."

The agent will:
- Update `MEMORY.md` with your tracked topics
- Update `HEARTBEAT.md` to run a daily digest at 8am PT
- Create a `daily-digest` skill with instructions for how to compile the briefing

---

## Step 3: Connect your delivery channel

### Slack

Open the **Channels** tab and configure Slack:
- **Bot Token** (`xoxb-...`) — from your Slack app settings
- **App Token** (`xapp-...`) — from your Slack app settings

Then tell the agent where to send the briefing:

> "Send the daily digest to my Slack DM, not a channel."

or

> "Send it to Slack channel #research."

### Telegram

Open the **Channels** tab and configure Telegram:
- **Bot Token** — from @BotFather on Telegram

Then:

> "Send my morning briefing via Telegram."

---

## Step 4: Configure the briefing format

The default format works well, but you can customize it:

> "Format the briefing like this: start with a one-paragraph summary of the day's most important story, then bullet points for 4-5 other stories, each with a link. End with a 'Worth watching' section for slower-moving stories."

> "Keep it short — 5 bullet points max. I only want things that are genuinely significant, not routine news."

> "Group the briefing by topic (AI tools, security, company news) rather than by importance."

The agent will update the `daily-digest` skill with your formatting preferences.

---

## Step 5: Set up the canvas

Ask for a canvas to accompany the briefings:

> "Build a research dashboard with today's top stories in a table — columns for headline, source, topic, and relevance score. Include a summary card at the top with the key takeaway of the day."

After the first digest runs, the canvas will populate with the day's findings and stay updated on each subsequent run.

---

## Step 6: Test it now

Don't wait until 8am to see if it works:

> "Run the daily digest now and show me what you'd send."

The agent will immediately research your topics, compile a briefing, and either:
- Show it to you in chat (if you say "show me")
- Send it to your connected channel

This lets you see the output and refine the format before the first real send.

---

## Refining over time

After a few days of digests, you can tune the agent based on what's useful:

> "The security section is too noisy — only include security items that directly affect Node.js, not general CVEs."

> "Start including Hacker News top threads in the daily briefing."

> "I liked the summary of the Anthropic paper yesterday. Do a deeper research pass on that topic and add the findings to my canvas."

The agent will update its skills and memory to improve future digests.

---

## How memory makes it smarter over time

The Research Assistant uses memory to improve over time:

- It remembers which topics you care most about
- It tracks stories it's already covered so it doesn't repeat them
- It saves research findings so it can refer back to them later
- It notes your feedback ("too long", "too much security news") and applies it

After a week of digests, your briefings will be significantly more targeted than the first one.

---

## Customization ideas

- _"Add a weekly deep-dive on Fridays — pick the most important story of the week and research it in depth."_
- _"If there's a major AI breakthrough, alert me immediately on Telegram instead of waiting for the morning briefing."_
- _"Track my competitor's blog posts and include any new posts in the briefing."_
- _"Send me a separate 'reading list' on Sundays — longer articles worth reading over the weekend."_
- _"Include a section with open-source projects that got significant GitHub stars this week in my tracked topics."_

---

## Related

- [Research Assistant template](/templates/research-assistant) — full template description
- [How Memory Works](/concepts/memory) — how the agent tracks topics and findings
- [How the Heartbeat Works](/concepts/heartbeat) — scheduling the daily run
- [Using Memory](/guides/using-memory) — maximizing memory for research tasks
