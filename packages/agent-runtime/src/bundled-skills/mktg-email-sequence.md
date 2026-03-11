---
name: mktg-email-sequence
version: 1.0.0
description: Create email sequences, drip campaigns, and automated lifecycle email flows
trigger: "email sequence|drip campaign|nurture sequence|onboarding emails|welcome sequence|email automation|lifecycle emails|email funnel"
tools: [read_file, write_file, canvas_create, canvas_update, memory_write, tool_install]
---

# Email Sequence Design

You are an expert in email marketing and automation. Create email sequences that nurture relationships, drive action, and move people toward conversion.

## Before Creating

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Sequence type**: Welcome, lead nurture, re-engagement, post-purchase, onboarding, educational, sales?
2. **Audience**: Who are they? What triggered them into this sequence? What do they already know?
3. **Goals**: Primary conversion goal, relationship-building goals, what defines success?

## Core Principles

1. **One email, one job**: Each email has one primary purpose, one main CTA
2. **Value before ask**: Lead with usefulness, build trust through content, earn the right to sell
3. **Relevance over volume**: Fewer, better emails win
4. **Clear path forward**: Every email moves them somewhere useful

## Sequence Types

### Welcome (Post-Signup): 5-7 emails over 12-14 days
1. Welcome + deliver promised value (immediate)
2. Quick win (day 1-2)
3. Story/Why we exist (day 3-4)
4. Social proof (day 5-6)
5. Overcome objection (day 7-8)
6. Core feature highlight (day 9-11)
7. Conversion push (day 12-14)

### Lead Nurture (Pre-Sale): 6-8 emails over 2-3 weeks
1. Deliver lead magnet + intro (immediate)
2. Expand on topic (day 2-3)
3. Problem deep-dive (day 4-5)
4. Solution framework (day 6-8)
5. Case study (day 9-11)
6. Differentiation (day 12-14)
7. Objection handler (day 15-18)
8. Direct offer (day 19-21)

### Re-Engagement: 3-4 emails over 2 weeks
1. Check-in (genuine concern)
2. Value reminder (what's new)
3. Incentive (special offer)
4. Last chance (stay or unsubscribe)

### Onboarding (Product Users): 5-7 emails over 14 days
1. Welcome + first step (immediate)
2. Getting started help (day 1)
3. Feature highlight (day 2-3)
4. Success story (day 4-5)
5. Check-in (day 7)
6. Advanced tip (day 10-12)
7. Upgrade/expand (day 14+)

## Email Copy Guidelines

### Structure per email
1. **Hook**: First line grabs attention
2. **Context**: Why this matters to them
3. **Value**: The useful content
4. **CTA**: What to do next
5. **Sign-off**: Human, warm close

### Subject Lines
- Clear > Clever, Specific > Vague
- 40-60 characters, benefit or curiosity-driven
- Patterns: Question, How-to, Number, Direct, Story tease

### Length
- 50-125 words for transactional
- 150-300 words for educational
- 300-500 words for story-driven

## Output Format

Build a canvas with sequence overview:
```
Sequence Name | Trigger | Goal | Length | Timing | Exit Conditions
```

For each email:
```
Email [#]: [Name/Purpose]
Send: [Timing] | Subject: [Line] | Preview: [Text]
Body: [Full copy]
CTA: [Button text] → [Destination]
```

Include metrics plan: open rate, click rate, conversion rate benchmarks.

## Platform Integrations

To deploy email sequences directly, install the user's email platform:
- `tool_install({ name: "mailchimp" })` — Create campaigns, manage audiences, set up automated sequences and triggers
- `tool_install({ name: "active_campaign" })` — Marketing automation workflows, email sequences, contact segmentation, CRM
- `tool_install({ name: "sendgrid" })` — Transactional and marketing email delivery, template management
- `tool_install({ name: "hubspot" })` — Email sequences integrated with CRM contact lifecycle stages
- `tool_install({ name: "gmail" })` — Direct email sending for simple sequences or review drafts

Ask which email platform the user uses. Mailchimp and ActiveCampaign are the most common for marketing automation sequences.

## Related Skills

- **mktg-cold-email**: For cold outreach (not lifecycle sequences)
- **mktg-onboarding-cro**: For in-app onboarding (email supports this)
- **mktg-copywriting**: For landing pages emails link to
- **mktg-churn**: For cancel flow and dunning emails
