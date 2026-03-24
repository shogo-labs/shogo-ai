---
name: invoice-manage
version: 2.0.0
description: Manage invoices — create, track status, and follow up on overdue payments
trigger: "invoice|create invoice|overdue|billing|send invoice|invoice status"
tools: [canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_write, send_message]
---

# Invoice Management

When managing invoices:

1. **Track** — Use canvas_api_schema for invoice CRUD:
   - Fields: client, amount, status (Draft/Sent/Paid/Overdue), dueDate, createdAt
2. **Build canvas** — Invoice management section:
   - KPIs: total outstanding, total paid (30d), overdue count
   - CRUD Table: invoices with client, amount, status badge, due date
   - Buttons: Create Invoice, Mark Paid, Send Reminder (with mutations)
3. **Create** — When user asks to create an invoice:
   - Parse client, amount, and due date from natural language
   - Add to the CRUD API via canvas_api_seed
4. **Follow up** — On heartbeat, check for overdue invoices:
   - Alert via `send_message` if any invoices are past due
   - Log overdue status to memory
5. **Report** — Weekly summary of cash flow (paid vs outstanding)
