---
sidebar_position: 3
title: Plans and Pricing
slug: /getting-started/plans-and-pricing
---

# Plans and Pricing

Shogo uses simple per-seat plans modeled on Cursor.com. Paid plans are
**unlimited within rolling usage windows**, and any usage beyond a full
window (overage) is billed at the AI provider's raw cost plus a flat 20%
markup — no credits, no unit conversions.

## How pricing works

- Each plan includes usage that is **unlimited within two rolling
  windows** — a **5-hour** window and a **weekly** (7-day) window. Higher
  tiers get larger windows.
- Usage is shown as a **percentage of each window** (for example,
  `42% used`), not as a depleting dollar balance. Each window resets on
  its own schedule once it elapses.
- When a window fills up, you can either wait for it to reset or enable
  **overage** to keep going. Overage is billed at the provider's raw cost
  + 20% (e.g. if Claude costs $0.003/1K tokens, you pay $0.0036), with an
  optional hard cap.
- Pricing under the hood is **per token** based on the AI model used — input
  and output tokens are priced separately — and the chat input shows an
  estimated cost before you send.
- You can check your usage windows in the sidebar or in
  **Settings > Billing**.

:::tip
You don't consume usage when browsing the dashboard, viewing the
canvas, or navigating your workspace. Usage is only counted when the AI
processes a message or runs an action.
:::

## Available plans

### Free

- Small 5-hour & weekly usage windows for trying things out
- Create unlimited agents
- Access to all templates
- Perfect for exploring Shogo and building your first agents

### Basic — $8/month

- Standard 5-hour & weekly usage windows
- Fast (economy) AI model
- Unlimited domains
- **Single user — no seats**
- Annual billing: $80/year

### Pro — $20 / seat / month

Per-seat plan for individuals and small teams.

- ~2.5x the usage windows of Basic, **per seat**
- All AI models (basic + advanced)
- Opt-in usage-based pricing for overage with a hard cap
- Priority compute & faster runs
- Annual billing: $200/seat/year

Add or remove seats at any time; we prorate the change automatically.

### Business — $40 / seat / month

Per-seat plan for teams running Shogo in production. Includes everything
in Pro, plus team-grade controls.

- ~5x the usage windows of Basic, **per seat**
- Team analytics & usage reporting
- SSO authentication
- Audit logs
- Personal & restricted projects
- Per-member spending limits
- Priority support
- Annual billing: $400/seat/year

### Enterprise

Custom pricing — contact us for higher volume, dedicated support,
onboarding services, custom connections, group-based access control,
SCIM provisioning, and custom design systems.

:::info Annual billing
Annual billing on every paid plan saves about 17% versus monthly.
:::

## Managing your subscription

1. Go to **Settings** in the sidebar and open the **Billing** tab.
2. From there you can:
   - View your current plan, seat count, and usage windows
   - See your usage history (both in-window usage and overage)
   - Add or remove seats (Pro & Business)
   - Upgrade or downgrade your plan
   - Manage your payment method via Stripe
   - Enable overage and set a hard cap to control spending
   - Redeem a license key

## Frequently asked questions

**What happens when I fill up a usage window?**
By default, you won't be able to send messages to the AI until that window
resets, or until you upgrade to a plan with larger windows. If you enable
overage and have a payment method on file, additional usage is billed at the
same provider cost + 20% rate up to your hard cap.

**What's the 20% markup?**
Shogo charges the provider's raw cost (OpenAI, Anthropic, etc.) plus a
flat 20% markup to cover infrastructure, support, and development. There
are no other fees and no unit conversions.

**Can I set a spending limit?**
Yes. On the Billing page, enable overage and (optionally) set a hard cap.
Once hit, no further charges accrue until the next billing period.

**Do unused usage windows roll over?**
No — each rolling window resets on its own schedule once it elapses, and
unused capacity doesn't carry over. Overage is billed separately.

**Can I add or remove seats mid-cycle?**
Yes. Seat changes on Pro and Business apply immediately and Stripe
prorates the charge. Your usage windows scale with the number of seats.

**Can I downgrade my plan?**
Yes — downgrade at any time. The change takes effect at the start of your
next billing period.

**Is there a free trial for paid plans?**
The free plan lets you explore Shogo at no cost, with small 5-hour and
weekly usage windows. When you're ready for more, upgrade to Basic, Pro,
or Business for larger windows.
