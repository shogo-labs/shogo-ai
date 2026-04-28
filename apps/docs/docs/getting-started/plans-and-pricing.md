---
sidebar_position: 3
title: Plans and Pricing
slug: /getting-started/plans-and-pricing
---

# Plans and Pricing

Shogo uses simple per-seat plans modeled on Cursor.com. Every request is
billed at the AI provider's raw cost plus a flat 20% markup — no credits,
no unit conversions.

## How pricing works

- Pricing is **per token** based on the AI model used, not a flat rate per
  message. Input and output tokens are priced separately so the bill
  accurately reflects model costs.
- We charge the provider's raw cost + 20% (e.g. if Claude costs
  $0.003/1K tokens, you pay $0.0036).
- The chat input shows an estimated USD cost before you send.
- Daily and monthly included pools reset automatically. Overage charges
  (when enabled) are billed on top of your plan.
- You can check your remaining balance in the sidebar or in
  **Settings > Billing**.

:::tip
You don't burn included usage when browsing the dashboard, viewing the
canvas, or navigating your workspace. Costs are only incurred when the AI
processes a message or runs an action.
:::

## Available plans

### Free

- $0.50/day of included usage (up to **$3/month**)
- Create unlimited agents
- Access to all templates
- Perfect for exploring Shogo and building your first agents

### Basic — $8/month

- $5 of monthly usage + $0.50/day
- Fast (economy) AI model
- Unlimited domains
- **Single user — no seats**
- Annual billing: $80/year

### Pro — $20 / seat / month

Per-seat plan for individuals and small teams.

- $20 of monthly usage **per seat**
- All AI models (basic + advanced)
- Opt-in usage-based pricing for overage with a hard cap
- Priority compute & faster runs
- Annual billing: $200/seat/year

Add or remove seats at any time; we prorate the change automatically.

### Business — $40 / seat / month

Per-seat plan for teams running Shogo in production. Includes everything
in Pro, plus team-grade controls.

- $40 of monthly usage **per seat**
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
   - View your current plan, seat count, and remaining included usage
   - See your usage history (both included and overage)
   - Add or remove seats (Pro & Business)
   - Upgrade or downgrade your plan
   - Manage your payment method via Stripe
   - Enable overage and set a hard cap to control spending

## Frequently asked questions

**What happens when I run out of included usage?**
By default, you won't be able to send messages to the AI until your daily
or monthly allowance resets, or until you upgrade. If you enable overage
and have a payment method on file, additional usage is billed at the same
provider cost + 20% rate up to your hard cap.

**What's the 20% markup?**
Shogo charges the provider's raw cost (OpenAI, Anthropic, etc.) plus a
flat 20% markup to cover infrastructure, support, and development. There
are no other fees and no unit conversions.

**Can I set a spending limit?**
Yes. On the Billing page, enable overage and (optionally) set a hard cap.
Once hit, no further charges accrue until the next billing period.

**Do unused included pools roll over?**
No — daily and monthly included usage reset at the start of each period.
Overage is billed separately and doesn't roll over.

**Can I add or remove seats mid-cycle?**
Yes. Seat changes on Pro and Business apply immediately and Stripe
prorates the charge. Your monthly included usage scales linearly with
seats (Pro: $20 per seat, Business: $40 per seat).

**Can I downgrade my plan?**
Yes — downgrade at any time. The change takes effect at the start of your
next billing period.

**Is there a free trial for paid plans?**
The free plan lets you explore Shogo at no cost ($0.50/day, up to
$3/month). When you're ready for more, upgrade to Basic, Pro, or Business.
