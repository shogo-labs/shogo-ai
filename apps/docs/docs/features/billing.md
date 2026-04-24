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
- Monthly allowance in USD
- Monthly or annual billing cycle

### Usage balance

A summary of your current spending:

- **Remaining** — USD allowance left in the current period
- **Total** — Total monthly allowance for your plan
- **Period** — When your balance resets (daily and monthly limits are tracked separately)

### Usage history

A log of spend, showing when you used allowance or overage charges and on which projects. Each entry shows:

- **Date** — When the usage occurred
- **Project** — Which project consumed the allowance
- **Amount** — USD charged (raw provider cost + 20% markup)

## Upgrading your plan

To get more allowance:

1. Go to **Billing**.
2. Click **Change Plan**.
3. Select your new tier.
4. Confirm your selection.

Upgrades take effect immediately. Your new allowance is available right away.

## Downgrading your plan

1. Go to **Billing**.
2. Click **Change Plan**.
3. Select a lower tier.
4. Confirm your selection.

Downgrades take effect at the start of your next billing period. You keep your current allowance until then.

## Overage settings

### Enable overage

By default, overage is disabled: when you run out of allowance, messages stop being processed. To allow spending beyond your monthly allowance:

1. Go to **Billing**.
2. Turn on **Allow Overage**.
3. (Optional) Set a hard cap to prevent surprise charges.

### Set a hard cap

A hard cap prevents charges from exceeding a specific amount per month. Once the cap is hit, no further charges will incur until your next billing period:

1. On the Billing page, enable **Overage**.
2. Set your desired **Hard Cap** (e.g., $500).
3. Save.

When you hit the hard cap, you'll see a notification and can't send messages to the AI until the next period starts.

## Payment management

Billing is handled through **Stripe**, a secure payment platform. From the billing page, you can:

- **Update payment method** — Change your credit card or payment source
- **View invoices** — See past charges and download receipts
- **Cancel subscription** — End your paid plan (reverts to Free at period end)

## Billing FAQ

**Who manages billing for a workspace?**
Workspace owners manage billing. Members can view their usage balance but cannot change the plan or payment method.

**What happens if my payment fails?**
If a payment fails, you'll receive a notification. Your plan remains active for a grace period while you update your payment method. If the issue isn't resolved, overage charges will be blocked and your workspace will revert to the Free plan at the next reset.

**Can I get a refund?**
Contact support for refund requests. Refund eligibility depends on the circumstances.

**Can different workspace members be on different plans?**
No. Plans are workspace-level. All members share the workspace's allowance and overage settings.

**How do I cancel my subscription?**
Go to **Billing** and click the subscription management link. You can cancel at any time. Your plan remains active until the end of the current billing period.

**What's included in my plan's allowance?**
Your monthly allowance covers all AI token usage (chat, code generation, images, voice) at raw provider cost + 20% markup. Some features (file storage, heartbeat infrastructure) are outside the metered allowance.

**Do I pay for errors or failed requests?**
Yes, failed requests still incur charges (the provider was called). However, if there's a Shogo platform error, contact support for a refund.
