---
name: revenue-snapshot
version: 2.0.0
description: Pull revenue metrics from Stripe and build a financial dashboard on canvas
trigger: "revenue|mrr|payments|balance|stripe|financial|how much"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_bind, write_file]
---

# Revenue Snapshot

When triggered, pull financial data and build a revenue dashboard:

1. **Connect** — Check if Stripe is installed via `tool_search`. If not:
   - `tool_install({ name: "stripe" })` to connect via Composio OAuth
   - Use autoBind to wire Stripe data to canvas
2. **Fetch** — Once connected:
   - `STRIPE_GET_BALANCE` for current balance
   - `STRIPE_LIST_PAYMENTS` for recent transactions
3. **Build canvas** — Revenue dashboard:
   - KPIs: MRR, total balance, pending payments, customer count
   - Chart: monthly revenue trend (bar chart)
   - Table: recent payments (amount, customer, date, status)
4. **Persist** — Log revenue snapshot to memory with timestamp for trend tracking
5. **Alert** — If any failed payments detected, notify via `send_message`

If Stripe isn't available, ask the user to provide revenue data manually or suggest connecting another payment tool via `tool_search("payments")`.
