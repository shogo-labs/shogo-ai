---
sidebar_position: 3
title: Using Memory Effectively
slug: /guides/using-memory
---

# Guide: Using Memory Effectively

Memory is what makes your agent smarter over time. Without it, every conversation starts fresh. With it, your agent knows your preferences, remembers past work, and builds context you'd otherwise have to re-explain every time.

This guide shows you how to get the most out of agent memory.

---

## What memory is (and isn't)

**Memory is:**
- Persistent Markdown files that survive across sessions
- The agent's "notebook" for facts, preferences, and learnings
- Something the agent reads at the start of every session

**Memory is not:**
- The chat context (messages you can scroll up and see)
- A database for structured querying
- Automatic — the agent writes to memory when asked or when doing tasks that naturally produce notes

See [How Memory Works](/concepts/memory) for the full technical explanation.

---

## Getting started: seed your memory

The fastest way to make memory useful is to tell the agent everything important upfront in one message.

**Example:**

> "Please save the following to memory: My name is Alex. I'm a backend engineer at Acme Corp. Our main repos are acme/api (Node.js) and acme/web (React). We use GitHub Actions for CI, PostgreSQL for the database, AWS for hosting (us-east-1). My preferred alert channel is Telegram for urgent things and Slack #engineering for daily summaries. I work 9am–6pm EST."

The agent will write all of this into `MEMORY.md` in structured sections. From now on, it knows your setup without you repeating it.

---

## Specific things to tell your agent to remember

### Your preferences

> "Remember that I always want alerts in bullet point format, not paragraphs."

> "Remember that I prefer conservative approaches — never run a destructive operation without asking me first."

> "Note that I'm not interested in news about Twitter or Meta — filter those out of briefings."

### Key facts about your systems

> "Save to memory: our API base URL is https://api.acme.com, staging is https://staging-api.acme.com, and the health check endpoint is /health."

> "Remember that the main GitHub repo is acme/api and the primary reviewer for PRs is Sarah Chen (@sarah)."

### Ongoing projects and context

> "Note in memory: we're mid-migration from PostgreSQL to PlanetScale. Expected completion: Feb 28. Owner: James. Don't recommend PostgreSQL-specific tooling until this is done."

> "Save: we're running a black-Friday promotion Jan 15–22. During this period, treat any payment errors as P0 incidents."

### Research findings

> "Save the key findings from this research to memory so I can reference them in future conversations."

> "Note that we evaluated Datadog and PagerDuty last month. We chose PagerDuty for cost reasons."

---

## Asking the agent to recall memory

The agent reads memory automatically, but you can also ask explicitly:

> "What do you know about our infrastructure setup?"

> "What's in memory about our PostgreSQL migration?"

> "Remind me what we decided about alert routing."

The agent will surface the relevant section of `MEMORY.md` or the relevant daily log.

---

## Asking the agent to update memory

You can update or correct memory at any time:

> "Update memory: the main branch is now called `main`, not `master`."

> "Remove the note about PlanetScale migration — we cancelled it."

> "Update my timezone in memory to America/Denver, I moved."

You can also ask the agent to do a full review:

> "Review MEMORY.md and tell me if anything looks outdated."

---

## Using daily logs effectively

The agent writes to `memory/YYYY-MM-DD.md` automatically during heartbeat runs and research tasks. You can use these to build context over time.

**Ask the agent to record things:**

> "After each heartbeat run, write a brief log of what you found and any actions you took."

> "At the end of each day, write a summary of what we discussed and any decisions made."

**Ask the agent to recall from daily logs:**

> "What happened with the CI failures last Tuesday?"

> "What did you find in the research session we did two weeks ago about LLM observability?"

> "What was the incident on January 12?"

---

## Memory patterns that work well

### The "always remember" pattern

Tell the agent upfront what it should always retain from your conversations:

> "From now on, whenever I share a useful URL, command, or finding, add it to memory automatically. I want to be able to recall things I mentioned in passing."

### The "project context" pattern

When starting work on a project, seed the context:

> "We're building a new auth system. Save to memory: using JWT with 24-hour expiry, refresh tokens in Redis with 7-day TTL, auth service is a separate microservice at auth.acme.com. Store this under an 'Auth Project' section."

Then any future conversation about auth has context immediately.

### The "preference capture" pattern

When you correct or adjust something the agent does, ask it to remember:

> "I don't like that format — please use a numbered list instead. And remember this preference for future responses."

> "That message was too long. Keep Slack alerts to 3 lines max. Save that to memory."

### The "post-incident" pattern

After resolving an incident or completing a project, capture it:

> "The database incident is resolved. Write a brief incident summary to memory: what happened, root cause, how we fixed it, and what to watch for in future."

---

## Reviewing and cleaning up memory

Over time, `MEMORY.md` can accumulate outdated information. Periodically ask the agent to review it:

> "Review MEMORY.md. Flag anything that looks outdated or no longer accurate, and suggest what should be updated or removed."

The agent will go through the file section by section and identify stale information.

---

## Memory and the heartbeat

When the heartbeat runs, the agent reads `MEMORY.md` as part of its context. This means:

- Alert routing rules in memory are applied automatically ("P0 → DM me on Telegram")
- Tracked topics in memory are researched without you having to mention them again
- Known contacts in memory are used in digests ("Assigned to Sarah Chen")

**Practical tip:** Put your most important preferences directly in `MEMORY.md` rather than relying on chat history. Chat history is session-scoped; memory is always there.

---

## Related

- [How Memory Works](/concepts/memory) — the full technical explanation
- [Workspace Files](/concepts/workspace-files) — MEMORY.md in context with other workspace files
- [How the Heartbeat Works](/concepts/heartbeat) — how memory is used during heartbeat runs
