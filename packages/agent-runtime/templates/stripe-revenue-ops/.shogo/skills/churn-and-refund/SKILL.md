---
name: churn-and-refund
version: 1.0.0
description: Surface churn-risk customers from Stripe + support signals and execute refunds with receipts after explicit confirmation
trigger: "churn|refund|emailed support|at risk|failed payment|cancel|stripe ops"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message]
---

# Churn & Refund Workflow

When triggered, run a churn-risk + refund pass:

1. **Confirm Stripe mode** — Ask test vs live. Persist to memory for the session. Default to test if unspecified.
2. **Connect Stripe** — `tool_search({ query: "stripe" })`; install via Composio if missing. Refuse to proceed without it.
3. **Pull metrics** — `STRIPE_GET_BALANCE`, `STRIPE_LIST_PAYMENTS`, `STRIPE_LIST_CUSTOMERS`, `STRIPE_LIST_INVOICES`. Render the KPI grid on the Revenue Dashboard.
4. **Detect churn risk** — For each customer, combine signals from Stripe + (when connected) Gmail / Zendesk:
   - 2+ support contacts in the last 30 days
   - Failed payment(s) in last 30 days
   - Subscription cancellation in flight
   - MoM spend drop > 50%
   For every flagged customer, capture audit evidence (message ids, ticket ids, Stripe event ids).
5. **Show refund pane** — Preview the refund batch: customer, charge id, amount, reason, total. Surface the policy (max per customer, escalation rules) read from memory.
6. **Wait for explicit approval** — Do not refund until the user types an explicit confirmation including the count and total (e.g. "yes, refund 3 customers for $X"). If anything is ambiguous, ask again.
7. **Execute** — Call `STRIPE_REFUND_CHARGE` per customer. Capture refund id and status.
8. **Receipts** — Append to a canvas `refunds` table: refund id, charge id, customer, amount, reason, mode (test/live), approver, timestamp.
9. **Notify** — `send_message` with the refund summary; if Slack is connected, post a parallel summary.

If anything fails (Stripe error, partial batch), stop, write what succeeded, and ask the user how to proceed. Never silently retry refunds.
