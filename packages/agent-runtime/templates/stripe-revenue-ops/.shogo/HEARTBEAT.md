# Heartbeat Checklist

## Revenue Health
- Pull latest Stripe balance, MRR, pending, and failed payments
- Diff against the last snapshot in memory and surface notable deltas

## Churn Risk
- Re-scan the support inbox / ticketing tool for customers with 2+ contacts this month
- Cross-reference with Stripe to compute exposure ($ MRR at risk)
- Flag new entrants and resolved entrants since last heartbeat

## Refund Hygiene
- Confirm every refund executed in the last 24h has a receipt entry
- Alert if any refund has `status: pending` for more than 1 hour
