# Heartbeat Tasks

## Every 30 Minutes

- **Refresh Stripe data** — Fetch latest balance and recent transactions from Stripe; update Revenue Dashboard KPIs and payments table; log snapshot to memory with timestamp
- **Failed payment check** — Scan latest payment list for any failed or disputed transactions; send immediate `send_message` alert if new failures are detected since last check

## Every 2 Hours

- **Overdue invoice scan** — Query all invoices with status not equal to Paid; compare dueDate against current date; flag any newly overdue invoices, update their status, and send `send_message` reminder to user
- **Pending invoice nudge** — Identify Sent invoices within 48 hours of due date; log upcoming due dates to memory for weekly report aggregation

## Weekly (Monday Morning)

- **Cash flow summary** — Aggregate paid vs. outstanding invoice totals for the past 7 days; compute collection rate; render updated Cash Flow Summary canvas surface and send a digest via `send_message` with key figures and any outstanding actions required