---
sidebar_position: 1
title: Prompting Basics
slug: /prompting/basics
---

# Prompting Basics

The quality of your agent configuration depends largely on the quality of your messages. This guide teaches you how to write effective prompts that get the results you want.

## The golden rule: be specific

The AI responds to what you tell it. Vague prompts produce vague results. Specific prompts produce specific results.

**Vague:**
> "Monitor my stuff."

**Specific:**
> "Monitor the acme/api and acme/web repos on GitHub. Check CI status every 15 minutes. Alert me on Slack if any build fails on the main branch. Include the commit hash and author in the alert."

You don't need to be technical — just be descriptive. Imagine you're explaining what you want to a colleague.

## Start with the big picture

When creating a new agent, start by describing the overall purpose before diving into details.

> "I want an agent that monitors our support queue. It should connect to Zendesk, triage incoming tickets by severity, alert our team on Slack for critical issues, and build a dashboard showing ticket volume trends and response times."

This gives the AI context that helps it make better decisions as you configure each piece.

## Break complex work into steps

Don't try to configure everything in one message. Break large setups into a sequence of smaller requests:

1. "Connect my Zendesk account."
2. "Build a dashboard with open ticket count, average response time, and priority breakdown."
3. "Set up the heartbeat to check for new tickets every 30 minutes."
4. "Alert me on Slack immediately for any P0 or P1 tickets."
5. "Send a daily digest of all new tickets every morning at 9am."

Each step is easier for the AI to handle correctly, and you can verify each one before moving on.

## Describe the result, not the process

You don't need to tell the AI *how* to configure something. Just describe *what* you want your agent to do.

**Process-focused (don't do this):**
> "Write a HEARTBEAT.md file that has a section for GitHub checks with a list of repos and a section for Slack notifications with the channel ID."

**Result-focused (do this):**
> "Set up a heartbeat that checks my three GitHub repos for new PRs and CI failures, then posts a summary to our #engineering Slack channel."

## Use natural language

Write like you're talking to a person. Don't try to write in configuration syntax or use technical jargon.

**Natural:**
> "When a P0 ticket comes in, immediately alert the team on Slack with the ticket details. For less urgent tickets, batch them into a morning digest."

**Overly technical:**
> "Add a ticket-triage skill with priority-based routing where P0 triggers send_message to Slack channel and P1-P3 are queued for daily batch."

Both will work, but the natural version is clearer and easier to write.

## Include details about what matters to you

When you care about specific behavior, say so:

> "Only alert me during business hours (9am-6pm EST). Outside of those hours, save alerts for the morning digest."

> "When building the dashboard, show MRR as the most prominent metric. Include a comparison to last month with a trend arrow."

## Ask the AI to explain or suggest

You can ask questions too — not just give instructions:

> "What integrations would be useful for a support triage agent?"

> "Can you suggest a heartbeat schedule that balances responsiveness with API rate limits?"

> "I'm not sure how to structure the skills for this agent. Can you help me think through it?"

## Summary

| Do | Don't |
|---|---|
| Be specific and descriptive | Use vague instructions like "set it up" |
| Break complex configurations into steps | Try to configure everything at once |
| Describe what you want your agent to do | Tell the AI how to write config files |
| Use natural language | Use technical jargon |
| Include behavioral details | Assume the AI knows your preferences |
| Ask questions when unsure | Stay stuck without asking for help |
