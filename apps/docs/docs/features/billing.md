---
sidebar_position: 11
title: Billing & Subscriptions
slug: /features/billing
---

# Billing & Subscriptions

Manage your workspace's plan, view usage and spend, and handle payment information from the Billing page.

## Accessing billing

1. Go to **Settings** in the sidebar.
2. Click **Billing**.

Only workspace **owners** can manage billing settings.

## What you'll see

### Current plan

Your active plan is displayed at the top, showing:

- Plan name and tier (e.g., Pro)
- Your billing cycle (monthly or annual)
- Seat count, for per-seat plans (Pro and Business)

### Usage windows

Paid plans are **unlimited within rolling usage windows** rather than a depleting dollar balance. Your usage is shown as a percentage of two windows that run in parallel:

- **5-hour window** — A short rolling window for bursty activity
- **Weekly window** — A 7-day rolling window

Each window shows how much you've used (e.g., `42% used`) and when it resets (e.g., `Resets in 3h 10m`). When a window fills up you'll see `Limit reached — resets in …`. Each window starts counting from your first action after the previous one elapses, so the two windows reset independently.

Higher tiers get larger windows, so heavier usage is less likely to hit a limit. Enterprise plans show **Unlimited** with no window cap.

### Usage history

A log of activity, showing when usage was counted toward a window or billed as overage, and on which projects. Each entry shows:

- **Date** — When the usage occurred
- **Project** — Which project the usage came from
- **Amount** — Cost recorded (raw provider cost + 20% markup)

## Upgrading your plan

To get larger usage windows:

1. Go to **Billing**.
2. Click **Change Plan**.
3. Select your new tier.
4. Confirm your selection.

Upgrades take effect immediately. Your larger windows are available right away.

## Downgrading your plan

1. Go to **Billing**.
2. Click **Change Plan**.
3. Select a lower tier.
4. Confirm your selection.

Downgrades take effect at the start of your next billing period. You keep your current plan's windows until then.

## Overage settings

### Enable overage

When you fill up a usage window, messages stop being processed until that window resets. Overage lets you keep working past a full window instead of waiting:

1. Go to **Billing**.
2. Turn on **Allow Overage**.
3. (Optional) Set a hard cap to prevent surprise charges.

With overage on, usage beyond a full window is billed at the same provider cost + 20% rate.

### Set a hard cap

A hard cap prevents overage charges from exceeding a specific amount per month. Once the cap is hit, no further charges will incur until your next billing period:

1. On the Billing page, enable **Overage**.
2. Set your desired **Hard Cap** (e.g., $500).
3. Save.

When you hit the hard cap, you'll see a notification and can't send messages to the AI until the next period starts.

## Redeeming a license key

If you've received a Shogo license key (format `SHGO-…`), you can redeem it to apply a plan or extra usage to your workspace:

1. Go to **Billing**.
2. Enter the code in the **Redeem a license key** field.
3. Click **Redeem**.

You can also follow a redemption link (for example `https://studio.shogo.ai/billing?redeem=YOUR-CODE`), which opens the Billing page with the code pre-filled. License keys are single-use and apply to the workspace you're currently in.

## Payment management

Billing is handled through **Stripe**, a secure payment platform. From the billing page, you can:

- **Update payment method** — Change your credit card or payment source
- **View invoices** — See past charges and download receipts
- **Cancel subscription** — End your paid plan (reverts to Free at period end)

## Billing FAQ

**Who manages billing for a workspace?**
Workspace owners manage billing. Members can view their usage balance but cannot change the plan or payment method.

**What happens if my payment fails?**
If a payment fails, you'll receive a notification. Your plan remains active for a grace period while you update your payment method. If the issue isn't resolved, overage charges will be blocked and your workspace will revert to the Free plan (with its smaller usage windows) at the next reset.

**Can I get a refund?**
Contact support for refund requests. Refund eligibility depends on the circumstances.

**Can different workspace members be on different plans?**
No. Plans are workspace-level. All members share the workspace's usage windows and overage settings.

**How do I cancel my subscription?**
Go to **Billing** and click the subscription management link. You can cancel at any time. Your plan remains active until the end of the current billing period.

**What's included in my plan?**
Your usage windows cover all AI token usage (chat, code generation, images, voice), priced at raw provider cost + 20% markup. Higher tiers get larger windows. Some features (file storage, heartbeat infrastructure) sit outside the metered usage windows.

**Do I pay for errors or failed requests?**
Yes, failed requests still incur charges (the provider was called). However, if there's a Shogo platform error, contact support for a refund.
