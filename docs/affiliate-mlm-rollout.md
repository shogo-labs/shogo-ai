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

## Commission structure (default: single-level)

The program ships with **multi-level payouts disabled by default**. Only
the direct referrer earns:

- **20%** of a referred customer's invoices for the **first 365 days**
  (from their attribution date), then **10% forever after**. This
  step-down is configured per tier via the new `secondaryRateBps` column
  on `affiliate_commission_tiers` (level 1 seeded at `1000` bps).
- Levels 2 and 3 of someone's downline earn **nothing** by default — a
  referrer is not paid for the customers that *their* referrals bring in.

Two independent depth knobs control this:

```
SHOGO_AFFILIATE_MAX_DEPTH=3          →  how deep the enrollment tree may grow
                                         (parentCode chains). Deep trees still
                                         form even when payouts are single-level.
SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH=1   →  how many upline levels actually earn a
                                         commission. 1 = direct referrer only.
                                         Set to 3 to re-enable full MLM payouts.
```

Re-enabling MLM payouts later is a single env flip
(`SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH=3`) — no code change, no migration. The
L2/L3 tier rows and the enrollment tree are preserved the whole time.

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
| `SHOGO_AFFILIATE_MAX_DEPTH` | `3` | Enrollment tree depth (parentCode chains). |
| `SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH` | `1` | Levels actually paid. `1` = direct referrer only (MLM payouts off); `3` re-enables full MLM. |
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
   - On `invoice.payment_succeeded`, one `affiliate_commission` row is
     written for the direct referrer at 20% (default single-level). If you
     set `SHOGO_AFFILIATE_PAYOUT_MAX_DEPTH=3` to test MLM, expect one row
     per upline level present.
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
- Affiliate Connect onboarding uses Stripe-hosted Express onboarding via
  `createCustomAccountForAffiliate` (resolves/creates the Express account) +
  `createAffiliateOnboardingLink` (AccountLink) in
  `stripe-connect.service.ts`; `account.updated` webhooks drive
  `handleAccountUpdated` -> `Affiliate.payoutStatus`.
- A user's affiliate and marketplace-creator roles SHARE a single Stripe
  Express Connect account. `getOrCreateSharedConnectAccountId` (keyed on
  `userId`) resolves an existing account from either `CreatorProfile` or
  `Affiliate` and mirrors the id onto both rows, so onboarding either role
  onboards the other. Because payouts now flow through one account, affiliate
  commissions (1099-NEC) and marketplace royalties (1099-K) are reported
  against the same connected account — accept this consolidated tax posture
  or split the accounts again before relying on per-role 1099 categorization.
- Approval cron currently uses `updateMany` without batching. Should
  be fine at <100k pending rows; revisit if backlog grows.
