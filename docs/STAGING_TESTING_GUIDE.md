# Shogo Staging Testing Guide

**URL:** https://studio-staging.shogo.ai

Thanks for helping us test! This is a loose guide — not a script. Poke around, try things in whatever order feels natural, and take note of anything that feels off.

> **Important framing:** Shogo is an **agent builder**, not an app builder. The canvas is not meant to produce interactive applications. It displays dashboards, summaries, and simple layouts with basic buttons that link to external sites. If something on the canvas isn't interactive, that's by design.

---

## Getting Started

- Sign up for an account (or sign in if you already have one)
- Create a workspace if prompted
- Familiarize yourself with the sidebar, dashboard, and settings

---

## Areas to Test

### 1. Collaboration — Inviting & Sharing

- Invite someone to your workspace (try both email invite and invite link if available)
- Try different roles (Editor, Admin, Viewer) and see if permissions feel right
- Have the invited person accept and check that they see the right projects
- Share a project with someone and verify they can access it
- Try removing a member or revoking access

**What we want to know:**
- Was the invite flow intuitive?
- Did the invited person receive the email? How long did it take?
- Were there any confusing permission states or error messages?
- Anything feel clunky about the sharing experience?

---

### 2. Tools & Integrations

Open a project, go to the Tools panel, and try connecting to external services.

Available integrations to try:
- **Slack**
- **Gmail**
- **Google Calendar**
- **Google Drive**
- **GitHub**
- **Linear**
- **Notion**

For each one:
- Search for the tool, install it, and go through the OAuth flow
- Once connected, ask the agent to do something with it (e.g. "send a Slack message to #general", "list my recent emails")
- Try disconnecting and reconnecting

**What we want to know:**
- Did the OAuth flow complete without errors?
- Were there any confusing steps during connection?
- Did the agent actually use the tool successfully after connecting?
- Any tools that failed silently or gave unhelpful errors?

---

### 3. Building Agents & Dashboards

Create a new project and use the chat to build something. Focus on:
- Defining what the agent should do (its purpose, personality, instructions)
- Having the agent create a **dashboard** — a visual summary or information display on the canvas
- Asking the agent to set up **automations** or **workflows** (e.g. "every morning, summarize my emails and post to Slack")
- Combining tools with agent behavior (e.g. an agent that monitors GitHub PRs and posts updates to a Slack channel)

**Things to try:**
- Give the agent a clear role ("You are a project manager assistant that tracks tasks in Linear and posts daily standups to Slack")
- Ask for a dashboard that shows relevant data (task counts, recent activity, summaries)
- Test multi-step conversations — does the agent remember context?
- Try edge cases: vague instructions, conflicting requests, asking it to do something outside its scope

**What we want to know:**
- How did the agent handle your requests? Did it understand what you wanted?
- Did the dashboard/canvas output look reasonable?
- Were there any crashes, freezes, or infinite loading states?
- How was the response speed?
- Did the agent stay on track or go off the rails?

---

### 4. What NOT to Test

- **Do not** try to build interactive applications (forms that submit, clickable UIs with state, interactive widgets)
- **Do not** expect buttons on the canvas to do anything other than link to external sites
- If the agent tries to build something interactive, that's a bug worth noting — but the expectation is that it won't

---

## General Observations

As you go through everything above, keep an eye on:

- **Performance** — Are things loading quickly? Any noticeable lag?
- **Error handling** — When something goes wrong, does the UI tell you what happened?
- **Navigation** — Can you find your way around without help?
- **Mobile** — If you try it on your phone, does it work?

---

## Feedback Questions

After you've spent some time testing, please share your thoughts on these:

1. **First impressions** — What was your gut reaction when you first opened the app?
2. **Biggest friction point** — What was the most confusing or frustrating part of the experience?
3. **What worked well** — What felt polished or surprisingly good?
4. **Agent quality** — How would you rate the agent's ability to understand and execute your requests? (1-5)
5. **Would you use this?** — If this were a finished product, would you use it for anything? What for?
6. **Missing features** — Is there anything you expected to be there that wasn't?
7. **Bugs** — List any bugs, errors, or unexpected behavior (screenshots appreciated)
8. **One thing to fix first** — If you could only fix one thing before launch, what would it be?

---

Thanks for testing. Your feedback goes directly into what we build next.
