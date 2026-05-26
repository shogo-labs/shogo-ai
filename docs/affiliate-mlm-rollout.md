# Native MLM Affiliate — Rollout Playbook

Operational runbook for flipping the native multi-level marketing
affiliate program from Rewardful to in-house. **Read end to end before
running any of these steps in production.** Cross-references the plan
at `.cursor/plans/native-mlm-affiliate-system_ffe2ba91.plan.md`.

## TL;DR

```
SHOGO_AFFILIATES_NATIVE=false  →  current Rewardful behavior, no MLM writes.
SHOGO_AFFILIATES_NATIVE=true   →  click tracking, attribution, commissions,
                                  payouts, and dashboard active.
```

Every server-side surface checks the flag and short-circuits when off,
so a code rollout without the flag flip is a no-op for users.

## What's already shipped (gated)

- Prisma models + migrations on both Postgres and SQLite.
- Service layer at `apps/api/src/services/affiliate.service.ts`.
- HTTP routes at `apps/api/src/routes/affiliates.ts`
  (`/api/affiliates/*`).
- Cloudflare Pages Function `shogo-website/functions/r/[code].ts` for
  click tracking with first-party cookies.
- `better-auth` user.create.after hook reads cookies and writes
  `AffiliateAttribution`.
- Stripe Checkout sites tag Customer + Subscription metadata with
  `affiliateId` via `affiliateCheckoutOverrides`.
- Webhook handlers for `invoice.payment_succeeded`,
  `charge.refunded`, `charge.dispute.created`.
- Three cron jobs wrapped in `withGlobalJobLock`:
  - `approve-eligible-commissions` (hourly)
  - `run-affiliate-payouts` (daily)
  - `affiliate-invoice-reconciliation` (daily)
- Mobile dashboard at `apps/mobile/app/(app)/affiliate/`.
- Marketing copy and FTC disclosure on `/affiliates`.
- Rewardful tracker script removed from both Astro layouts.

## Environment variables to set BEFORE flipping the flag

In every cloud region's API deployment:

| Var | Recommended value | Notes |
| --- | --- | --- |
| `SHOGO_AFFILIATES_NATIVE` | `true` at flip time | Master kill switch. |
| `SHOGO_AFFILIATE_MAX_DEPTH` | `3` | Matches seed tier rows. |
| `SHOGO_AFFILIATE_REFUND_HOLD_DAYS` | `30` | Commissions stay `pending` for this long. |
| `SHOGO_AFFILIATE_MIN_PAYOUT_CENTS` | `5000` | Minimum payout balance. |
| `SHOGO_AFFILIATE_COOKIE_DAYS` | `60` | Click-attribution window. |
| `SHOGO_INTERNAL_SECRET` | 32-byte random | Shared with the Pages Function. |

In the Cloudflare Pages project for `shogo-website`:

| Var | Notes |
| --- | --- |
| `SHOGO_API_URL` | e.g. `https://api.shogo.ai` |
| `SHOGO_INTERNAL_SECRET` | Same value as the API. |
| `SHOGO_AFFILIATE_COOKIE_DAYS` | Optional; defaults to 60. |

## Staging end-to-end script

1. Set `SHOGO_AFFILIATES_NATIVE=true` in staging API + Pages.
2. Sign in as a seed user and enroll: `POST /api/affiliates/enroll`
   `{ termsAccepted: true }`. Confirm a code is generated.
3. Hit `https://<staging>/r/<code>?utm_source=qa` in an incognito
   window. Confirm:
   - 302 redirect to home with UTM params preserved.
   - `__shogo_ref` and `__shogo_ref_visitor` cookies set.
   - `affiliate_clicks` row created.
4. Sign up as a new user in the same incognito window. Confirm an
   `affiliate_attribution` row exists for the new user.
5. Complete a paid checkout. Confirm:
   - Stripe Customer + Subscription metadata contain `affiliateId`.
   - On `invoice.payment_succeeded`, three `affiliate_commission` rows
     are written (one per upline level present).
6. Wait out the refund-hold (or temporarily set
   `SHOGO_AFFILIATE_REFUND_HOLD_DAYS=0`) and run
   `runApproveEligibleCommissions` manually. Confirm `pending → approved`.
7. Run `runAffiliatePayoutsCron`. Confirm a Stripe transfer + payout
   pair was created (visible in Stripe Dashboard → Connect) and an
   `affiliate_payout` row was written.
8. Refund the original Stripe charge. Confirm a clawback runs and
   `pendingPayoutCents` decreases appropriately.

If any step diverges, **do not** flip the flag in prod.

## Backfill from Rewardful

```bash
# In Rewardful: Reports → CSV exports → Affiliates + Conversions.
bun scripts/backfill-rewardful-affiliates.ts \
  --affiliates ./rewardful-affiliates.csv \
  --conversions ./rewardful-conversions.csv \
  --dry-run
```

Re-run without `--dry-run` after reviewing the printed counts.

The script is idempotent: it skips users that already have an
`Affiliate` or `AffiliateAttribution` row. Code collisions are
resolved by suffixing the new affiliate's code with the trailing six
characters of their user id; the original short code is left with
the original owner.

## Production flip

1. Deploy the latest API + Pages builds with `SHOGO_AFFILIATES_NATIVE=false`.
   This is a pure code rollout — no observable change.
2. Run the Rewardful backfill in production (steps above).
3. Spot-check: pick five well-known historical affiliates and confirm
   their `Affiliate` rows and (sample) attributions look right.
4. Flip `SHOGO_AFFILIATES_NATIVE=true` in every API region within a
   single deploy window. The Cloudflare Pages env can be flipped
   independently — clicks will be recorded immediately.
5. Watch the dashboards for one billing cycle:
   - Stripe Connect transfers should appear once the first payout cron runs.
   - `affiliate_commission` row count should grow with each
     `invoice.payment_succeeded`.
   - `affiliate-invoice-reconciliation` should report
     `commissionsCreated == 0` on every run (the webhook beat us to it);
     any non-zero number is a missed webhook to investigate.

## Decommissioning Rewardful

After 30 days at the new system with no anomalies:

1. Cancel the Rewardful subscription.
2. Delete the Rewardful API key from the secret store.
3. Search the codebase for `rewardful` / `getRewardfulReferral` — the
   only remaining references should be in `apps/mobile/lib/rewardful.ts`
   (legacy shim) and one usage each in `billing.tsx` and
   `new-workspace.tsx`. Remove those once `SHOGO_AFFILIATES_NATIVE` has
   been `true` in prod for a full 30 days.

## Rollback

Set `SHOGO_AFFILIATES_NATIVE=false` in every region. Every code path
short-circuits immediately:

- Click endpoint returns 503.
- Signup hook is a no-op.
- Checkout overrides return `{}`.
- Webhook handlers skip the commission write.
- Cron jobs return `{ flagDisabled: true }`.

No data is destroyed; the only artifact of a rolled-back flip is the
rows already written, which become inert until the flag flips back.

## Known follow-ups (P2+)

- The mobile downline endpoint iterates `findMany` per level. Once
  affiliate trees grow beyond a few hundred we should swap in a single
  recursive-CTE query on Postgres.
- Affiliate Connect onboarding currently relies on `createCustomAccount` /
  `submitPayoutDetails` wrappers added to `stripe-connect.service.ts`.
  Long-term we'll want a dedicated `affiliate-connect.service.ts` so
  Stripe-tax categorization for `affiliate` accounts (1099-NEC) can
  diverge from marketplace creators (1099-K) without further
  parameterization at every call site.
- Approval cron currently uses `updateMany` without batching. Should
  be fine at <100k pending rows; revisit if backlog grows.
