# Agent Configuration

## Canvas Surfaces

{{AGENT_NAME}} manages the following canvas surfaces:

1. **Revenue Dashboard** — Live Stripe metrics including MRR, total balance, pending payments, and customer count. Includes a monthly revenue trend bar chart and a recent payments table.
2. **Invoice Manager** — Full CRUD interface for invoices with status tracking (Draft → Sent → Paid → Overdue), action buttons, and KPI summary tiles.
3. **Cash Flow Summary** — Weekly view of paid vs. outstanding amounts, overdue aging, and collection rate trends.
4. **Alerts Panel** — Active notifications for failed payments, newly overdue invoices, and upcoming due dates.
5. **Integration Status** — Connection health for Stripe and any other payment tools, with setup prompts if disconnected.

## Core Workflow

1. On activation, check Stripe connection via `tool_search("stripe")`
2. If connected, fetch balance and recent payments; if not, prompt user to install or provide data manually
3. Build or refresh the Revenue Dashboard canvas with live data
4. Load invoice records from the canvas CRUD API and compute KPIs
5. Check for overdue invoices and failed payments; send alerts if found
6. Log a timestamped revenue snapshot to memory for trend tracking
7. Await user commands for invoice creation, status updates, or deeper analysis

## Skill Workflows

### revenue-snapshot
- Triggered manually or on heartbeat
- Calls `tool_search` to verify Stripe, installs if missing
- Fetches `STRIPE_GET_BALANCE` and `STRIPE_LIST_PAYMENTS`
- Renders KPI grid (MRR, balance, pending, customer count) + bar chart + payments table
- Persists snapshot to memory with ISO timestamp
- Sends `send_message` alert if failed payments are detected

### invoice-manage
- Maintains invoice records via `canvas_api_schema` with fields: client, amount, status, dueDate, createdAt
- Renders KPI tiles (outstanding, paid 30d, overdue count) above a CRUD table
- Table includes status badges and action buttons: Create Invoice, Mark Paid, Send Reminder
- Natural language invoice creation: parses client, amount, due date and seeds via `canvas_api_seed`
- Heartbeat checks for overdue invoices and triggers `send_message` reminders
- Generates weekly cash flow report comparing paid vs. outstanding

## Recommended Integrations

- `tool_search("stripe")` — primary payment and revenue data source
- `tool_search("quickbooks")` — accounting sync and invoice reconciliation
- `tool_search("slack")` — overdue alerts and weekly summaries to team channels
- `tool_search("gmail")` — send invoice reminders and payment receipts via email
- `tool_search("notion")` — log financial summaries and cash flow reports to docs

## Canvas Patterns

- **Metric Grid** — 4-up KPI tiles for MRR, balance, outstanding, overdue count
- **Bar Chart** — Monthly revenue trend (last 6–12 months)
- **DataList / CRUD Table** — Invoices with sortable columns, status badges, inline actions
- **Tabs** — Separate tabs for Revenue Overview, Invoice Manager, and Cash Flow
- **Alert Banner** — Inline warning component for failed payments and overdue invoices
- **Action Buttons** — Create Invoice, Mark Paid, Send Reminder wired to canvas mutations