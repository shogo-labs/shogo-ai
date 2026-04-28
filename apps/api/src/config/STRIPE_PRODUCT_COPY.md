# Stripe Product Copy — Source of Truth

This file is the canonical text for what shows up in Stripe Checkout, invoices,
and the customer portal. It is read by [`scripts/update-stripe-product-copy.ts`](../../../scripts/update-stripe-product-copy.ts)
to keep the Stripe Dashboard in sync with the codebase.

**Pricing model in one sentence**: simple per-seat plans with included monthly
usage in dollars; every AI request is billed at the raw provider cost plus a
flat 20% markup. No credits, no unit conversions.

---

## Products

### Shogo Basic — `prod_UD3oRbXK7sLA8p` (staging)

- **Name**: `Shogo Basic`
- **Description**: `$5 of monthly AI usage + $0.50/day. All usage billed at raw provider cost plus a flat 20% markup. Single user — no seats. No credits, no unit conversions.`
- **Metadata**:
  - `plan`: `basic`
  - `included_usd`: `5`
  - `per_seat`: `false`
  - `markup`: `0.20`

### Shogo Pro — `prod_TnJUJPgKdcWPUD` (staging)

- **Name**: `Shogo Pro`
- **Description**: `Includes $20 of AI usage per seat per month. Every request billed at the AI provider's raw cost plus a flat 20% markup. Opt-in usage-based overage with a hard cap. No credits, no unit conversions.`
- **Metadata**:
  - `plan`: `pro`
  - `included_usd_per_seat`: `20`
  - `per_seat`: `true`
  - `markup`: `0.20`

### Shogo Business — `prod_TnJUouAXCoO5ke` (staging)

- **Name**: `Shogo Business`
- **Description**: `Includes $40 of AI usage per seat per month. Team analytics, SSO, audit logs, per-member spending limits. Every request billed at the AI provider's raw cost plus a flat 20% markup. No credits, no unit conversions.`
- **Metadata**:
  - `plan`: `business`
  - `included_usd_per_seat`: `40`
  - `per_seat`: `true`
  - `markup`: `0.20`

### Shogo Usage Overage — `prod_UOfGeWglG4weLp` (staging)

- **Name**: `Shogo Usage Overage`
- **Description**: `Metered overage beyond your plan's included monthly usage. Charged at provider cost + 20% with an optional hard cap.`
- **Metadata**:
  - `purpose`: `usage_overage`
  - `currency`: `usd`
  - `markup`: `0.20`

---

## Prices

### Basic

| Lookup key                  | Interval | Amount | Per-seat | Staging price ID                   |
|-----------------------------|----------|--------|----------|------------------------------------|
| `shogo_basic_monthly_v2`    | month    | $8     | no       | `price_1TRH5XAp5PDuxitp1Uqkjbcx`   |
| `shogo_basic_annual_v2`     | year     | $80    | no       | `price_1TRH5XAp5PDuxitptfGAK6PB`   |

Nicknames: `Basic (monthly)` / `Basic (annual)`.

### Pro

| Lookup key                  | Interval | Amount       | Per-seat | Staging price ID                   |
|-----------------------------|----------|--------------|----------|------------------------------------|
| `shogo_pro_monthly_v2`      | month    | $20 / seat   | yes      | `price_1TRH5kAp5PDuxitpwN3MHPhD`   |
| `shogo_pro_annual_v2`       | year     | $200 / seat  | yes      | `price_1TRH5kAp5PDuxitpyUIn1Fh6`   |

Nicknames: `Pro (monthly per seat)` / `Pro (annual per seat)`.

### Business

| Lookup key                       | Interval | Amount       | Per-seat | Staging price ID                   |
|----------------------------------|----------|--------------|----------|------------------------------------|
| `shogo_business_monthly_v2`      | month    | $40 / seat   | yes      | `price_1TRH5lAp5PDuxitpCRkOKz4h`   |
| `shogo_business_annual_v2`       | year     | $400 / seat  | yes      | `price_1TRH5lAp5PDuxitpM51P3JNm`   |

Nicknames: `Business (monthly per seat)` / `Business (annual per seat)`.

### Overage (metered)

| Lookup key                | Interval | Unit  | Meter event              | Staging price ID                   |
|---------------------------|----------|-------|--------------------------|------------------------------------|
| (existing, no v2 needed)  | month    | $0.01 | `usage_overage_cents`    | `price_1TPrwgAp5PDuxitpra3BDHvR`   |

The overage meter id is `mtr_test_61UZFtwbFz7EF6Fo541Ap5PDuxitpJ5U` (staging).
Production overage IDs in [`stripe-prices.ts`](./stripe-prices.ts).

---

## Production product / price IDs

To be filled in after the production rollout. The script in
[`scripts/update-stripe-product-copy.ts`](../../../scripts/update-stripe-product-copy.ts)
keeps the descriptions / metadata in sync; price creation is a one-time CLI
operation logged here for traceability.
