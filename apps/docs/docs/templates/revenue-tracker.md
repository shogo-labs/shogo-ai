---
title: Revenue Tracker
slug: /templates/revenue-tracker
---

# Revenue Tracker

Your financial command center. Tracks revenue metrics, manages invoices, and builds financial dashboards. Connects to Stripe and other payment tools.

**Category:** Business
**Heartbeat:** Every 24 hours
**Skills:** `revenue-snapshot`, `invoice-manage`

## What this agent does

- Connects to Stripe (or other payment tools) via Composio
- Builds a revenue dashboard with KPIs, payment history, and invoice management
- Tracks MRR, total balance, pending payments, and customer count
- Monitors for failed payments and unusual spikes
- Logs daily revenue snapshots to memory for trend analysis
- Compiles weekly revenue summaries

## Canvas dashboard

The Revenue Tracker agent builds dashboards with:
- **KPIs** — MRR, total balance, pending payments, customer count
- **Charts** — monthly revenue trend
- **Payment table** — recent payments with amount, customer, date, and status
- **CRUD section** — invoice management with client, amount, status, and due date

## Heartbeat behavior

On each heartbeat cycle, the agent:
1. Pulls current balance and recent payments
2. Compares to yesterday and last week
3. Logs revenue metrics to memory
4. Alerts on any failed payments
5. Compiles weekly MRR trend, top customers, and overdue invoices

## Recommended integrations

- **Stripe** — for payment data
- **Google Sheets** — for custom reports
- **Slack** — for revenue alerts

## Customization ideas

- "Connect Stripe and show me my MRR trend for the last 6 months"
- "Alert me on Slack if any payment fails"
- "Track invoices and remind me when they're overdue"
- "Send a weekly revenue summary every Monday morning"
