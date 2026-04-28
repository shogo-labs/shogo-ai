---
sidebar_position: 1
title: Best Practices
slug: /tips-and-tricks/best-practices
---

# Best Practices

These tips will help you get the best results from Shogo, keep usage low, and build agents more effectively.

## 1. Plan before you prompt

Before opening Shogo, spend a few minutes thinking about what you want your agent to do:

- **What is the agent for?** — "A GitHub ops agent that monitors my repos."
- **What should it monitor?** — "CI status, new PRs, and critical issues."
- **How should it alert?** — "Slack for urgent, daily digest for everything else."
- **What integrations does it need?** — "GitHub, Slack."

Even rough notes will make your prompts significantly better.

## 2. Start with a template

If a template is close to what you need, start there instead of from scratch. It's faster to customize an existing agent than to build one from nothing.

Browse the [Templates](../templates/) to see what's available. You can change everything about a template after starting.

## 3. Configure one feature at a time

The most common mistake is trying to set up too much at once. Instead:

1. Get one capability working and verified.
2. Move to the next.
3. Repeat.

**Example sequence for a support agent:**
1. "Connect my Zendesk account."
2. "Build a dashboard with open ticket count and priority breakdown."
3. "Set up the heartbeat to check for new tickets every 30 minutes."
4. "Alert me on Slack for P0 and P1 tickets."
5. "Send a daily digest of all new tickets every morning."

Each step is manageable and verifiable.

## 4. Verify after every change

After each AI response, check that the configuration matches your expectations:

- Review what skills were added or modified
- Check that the heartbeat schedule is correct
- Verify integrations are connected
- Look at the canvas dashboard to confirm the layout

Catching issues early saves usage and prevents compounding problems.

## 5. Use checkpoints wisely

Before making a big change, make sure you have a checkpoint. This way, if something goes wrong, you can always go back.

Good times to checkpoint:
- After getting a core feature working
- Before reconfiguring skills or heartbeat
- Before connecting a new integration

See [History & Checkpoints](../features/history-and-checkpoints).

## 6. Be specific in your prompts

Vague prompts lead to vague results. Compare:

**Vague:** "Monitor my repos."

**Specific:** "Monitor the acme/api and acme/web repos on GitHub. Check CI every 15 minutes. Alert on Slack #incidents for build failures on main. Include the failing commit hash and author."

See the [Prompting Guide](../prompting/basics) for more techniques.

## 7. Save usage with combined requests

If you have several small related changes, combine them into one message:

**Instead of three messages:**
> 1. "Change the heartbeat to every 10 minutes."
> 2. "Add staging branch to CI monitoring."
> 3. "Update quiet hours to 11pm-6am."

**Send one message:**
> "Change the heartbeat to every 10 minutes, add the staging branch to CI monitoring, and set quiet hours to 11pm-6am."

This uses less usage than three separate messages.

## 8. Revert early, not late

If a change broke something, revert immediately. Don't layer more changes on top of a broken state — it makes things harder to fix.

## 9. Describe your alert preferences clearly

When your agent monitors multiple things, be explicit about what deserves an alert vs. a digest:

> "Alert immediately on CI failures and P0 tickets. Batch everything else — new PRs, P2-P3 tickets, and non-critical issues — into a daily morning digest."

This helps the AI set up proper escalation rules.

## 10. Don't be afraid to start over on a feature

If a capability isn't working after several attempts, it's often faster to:

1. Revert to before the feature
2. Describe it differently
3. Build it in smaller steps

See [Troubleshooting with Prompts](../prompting/troubleshooting-with-prompts) for more strategies.

## 11. Seed memory early

One of the most impactful things you can do when setting up a new agent is front-load your preferences and context into memory. Tell the agent your name, timezone, systems, key contacts, and alert preferences in one message:

> "Save to memory: my name is Alex, I'm in Pacific time, and I prefer Telegram for urgent alerts and Slack for digests. Our main repos are acme/api and acme/web. Main branch is main."

This context is available on every heartbeat and every future session without you repeating it. See [Using Memory](/guides/using-memory).

## 12. Keep your HEARTBEAT.md focused

The heartbeat checklist runs in full on every tick. A checklist with 20 items costs more per tick than a focused one with 5. Keep it to the checks that actually need to happen at that cadence:

- **High-frequency items** (every 10–15 min): only truly time-sensitive checks like service health or CI status
- **Medium-frequency items** (every 30–60 min): ticket triage, PR monitoring, revenue checks
- **Daily items**: digests, summaries, and weekly reviews

If a task only needs to run once a day, scope it explicitly: _"Once per day at 9am, send a digest."_

See [How the Heartbeat Works](/concepts/heartbeat) for more on HEARTBEAT.md design.
