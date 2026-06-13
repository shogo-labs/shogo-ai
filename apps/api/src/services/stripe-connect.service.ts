// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import Stripe from 'stripe';

import { prisma, PayoutStatus } from '../lib/prisma';
import { getFrontendUrl } from '../lib/cloud-urls';

export const PLATFORM_FEE_PERCENT = 20;

let stripeInstance: Stripe | null = null;

function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!isStripeConfigured()) {
      throw new Error('Stripe is not configured (STRIPE_SECRET_KEY not set)');
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-04-30.basil' as any,
    });
  }
  return stripeInstance;
}

// test-only: reset module-private Stripe singleton so tests can re-trigger
// the `STRIPE_SECRET_KEY not set` branch in `getStripe()` deterministically.
export function __resetStripeInstanceForTesting(): void {
  stripeInstance = null;
}

// test-only: every public caller pre-checks `isStripeConfigured()` before
// reaching `getStripe()`, which leaves the singleton's internal guard
// unreachable from the public API. Re-export it so the guard branch is
// exercisable.
export function __getStripeForTesting(): Stripe {
  return getStripe();
}

function platformFeeAmountCents(priceInCents: number): number {
  return Math.round((priceInCents * PLATFORM_FEE_PERCENT) / 100);
}

/**
 * Get-or-create the single Stripe Express Connect account for a user, shared
 * across BOTH their marketplace CreatorProfile and their Affiliate record.
 *
 * A user may wear one or both hats but is paid through one connected account;
 * the id is mirrored onto whichever of the two rows exist so every read site
 * (`CreatorProfile.stripeCustomAccountId` / `Affiliate.stripeCustomAccountId`)
 * resolves to the same account.
 *
 * Express accounts let Stripe host KYC/identity + bank collection via the
 * hosted onboarding flow (see the onboarding-link helpers); we keep
 * `payouts.schedule.interval = 'manual'` so the marketplace payout release and
 * the affiliate payout cron stay in control of connected-account → bank
 * transfers rather than Stripe auto-paying out.
 *
 * Legacy note: if a user somehow already has two *different* account ids
 * (provisioned before accounts were shared) we leave them as-is — Stripe
 * accounts can't be merged — and only backfill a side whose id is null.
 */
async function getOrCreateSharedConnectAccountId(opts: {
  userId: string;
  email: string;
  country?: string;
}): Promise<string> {
  const [profile, affiliate] = await Promise.all([
    prisma.creatorProfile.findUnique({ where: { userId: opts.userId } }),
    prisma.affiliate.findUnique({ where: { userId: opts.userId } }),
  ]);

  let accountId =
    profile?.stripeCustomAccountId ?? affiliate?.stripeCustomAccountId ?? null;

  if (!accountId) {
    if (!isStripeConfigured()) {
      accountId = `acct_mock_${opts.userId.slice(0, 12)}`;
    } else {
      const stripe = getStripe();
      const account = await stripe.accounts.create({
        type: 'express',
        country: opts.country ?? 'US',
        email: opts.email,
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: 'manual' } } },
        metadata: { userId: opts.userId, kind: 'shared' },
      });
      accountId = account.id;
    }
  }

  // Mirror the id onto both rows so creator + affiliate always share it.
  if (profile && profile.stripeCustomAccountId == null) {
    await prisma.creatorProfile.update({
      where: { id: profile.id },
      data: { stripeCustomAccountId: accountId },
    });
  }
  if (affiliate && affiliate.stripeCustomAccountId == null) {
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: { stripeCustomAccountId: accountId },
    });
  }

  return accountId;
}

/**
 * Ensure the marketplace creator has a (shared) Express Connect account and
 * return its id, persisting it on the CreatorProfile. Shares the same account
 * as the user's Affiliate record when present.
 */
export async function createCustomAccount(
  creatorProfileId: string,
  email: string,
  country = 'US',
): Promise<string> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile) {
    throw new Error('Creator profile not found');
  }
  if (profile.stripeCustomAccountId) {
    return profile.stripeCustomAccountId;
  }
  return getOrCreateSharedConnectAccountId({
    userId: profile.userId,
    email,
    country,
  });
}

/**
 * Ensure the affiliate has a (shared) Express Connect account and return its
 * id. Shares the same account as the user's marketplace CreatorProfile when
 * present — resolved/created via {@link getOrCreateSharedConnectAccountId}
 * keyed on the affiliate's userId.
 */
export async function createCustomAccountForAffiliate(
  affiliateId: string,
): Promise<string> {
  const affiliate = await prisma.affiliate.findUnique({
    where: { id: affiliateId },
    include: { user: { select: { email: true } } },
  });
  if (!affiliate) throw new Error('Affiliate not found');
  if (affiliate.stripeCustomAccountId) return affiliate.stripeCustomAccountId;

  const email =
    (affiliate as any).user?.email ?? `affiliate+${affiliateId}@shogo.local`;
  return getOrCreateSharedConnectAccountId({ userId: affiliate.userId, email });
}

/**
 * Mint a single-use Stripe-hosted onboarding (AccountLink) URL for a connected
 * account. Stripe collects identity/KYC + bank details on the hosted page and
 * fires `account.updated` webhooks as requirements clear, which
 * {@link handleAccountUpdated} maps back onto the owning CreatorProfile and/or
 * Affiliate payoutStatus.
 *
 * `returnPath` is the in-app path (e.g. `/affiliate`, `/marketplace/creator`)
 * the hosted flow redirects back to. When Stripe is unconfigured (local/dev)
 * there is no hosted page to link to, so we return that app URL directly.
 */
async function createConnectOnboardingLink(
  accountId: string,
  returnPath: string,
): Promise<string> {
  const base = getFrontendUrl().replace(/\/$/, '');
  // `returnPath` may already carry a query string (e.g. `/creator?tab=publish`),
  // so pick the right separator before appending `connect=...`.
  const sep = returnPath.includes('?') ? '&' : '?';
  if (!isStripeConfigured() || accountId.startsWith('acct_mock')) {
    return `${base}${returnPath}${sep}connect=mock`;
  }

  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${base}${returnPath}${sep}connect=refresh`,
    return_url: `${base}${returnPath}${sep}connect=done`,
  });
  return link.url;
}

/**
 * Hosted onboarding link for an affiliate's (shared) Express account.
 * Ensures the account exists via {@link createCustomAccountForAffiliate}.
 */
export async function createAffiliateOnboardingLink(
  affiliateId: string,
): Promise<string> {
  const accountId = await createCustomAccountForAffiliate(affiliateId);
  // Return into the unified Creator hub's Referrals tab so the `connect=done`
  // param survives (the legacy `/affiliate` route just redirects and drops it).
  return createConnectOnboardingLink(accountId, '/creator?tab=refer');
}

/**
 * Hosted onboarding link for a marketplace creator's (shared) Express account.
 * Ensures the account exists via {@link createCustomAccount}.
 */
export async function createCreatorOnboardingLink(
  creatorProfileId: string,
  email: string,
  country = 'US',
): Promise<string> {
  const accountId = await createCustomAccount(creatorProfileId, email, country);
  // Return into the unified Creator hub's Publishing tab so the `connect=done`
  // param survives (the legacy `/marketplace/creator` route just redirects).
  return createConnectOnboardingLink(accountId, '/creator?tab=publish');
}

/**
 * Re-read an affiliate's Express account from Stripe and persist the derived
 * `payoutStatus`. Used by the status endpoint so the app can reflect a
 * verified account immediately on return from hosted onboarding without
 * waiting for the `account.updated` webhook (which remains the source of
 * truth but may lag).
 */
export async function syncAffiliatePayoutStatus(
  affiliateId: string,
): Promise<PayoutStatus> {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
  if (!affiliate?.stripeCustomAccountId) {
    throw new Error('Affiliate has no Stripe Connect account');
  }
  if (!isStripeConfigured()) {
    return (affiliate.payoutStatus as PayoutStatus) ?? PayoutStatus.pending_verification;
  }

  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(affiliate.stripeCustomAccountId);
  const payoutStatus = derivePayoutStatusFromAccount(acct);
  await prisma.affiliate.update({
    where: { id: affiliateId },
    data: { payoutStatus: payoutStatus as any },
  });
  return payoutStatus;
}

/**
 * Re-read a creator's Express account from Stripe and persist the derived
 * `payoutStatus`. Mirror of {@link syncAffiliatePayoutStatus} so the app can
 * reflect a verified/pending account immediately on return from hosted
 * onboarding without waiting for the `account.updated` webhook (which remains
 * the source of truth but may lag or, if the Connect endpoint is
 * misconfigured, not fire at all).
 */
export async function syncCreatorPayoutStatus(
  creatorProfileId: string,
): Promise<PayoutStatus> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile?.stripeCustomAccountId) {
    throw new Error('Creator has no Stripe Connect account');
  }
  if (!isStripeConfigured()) {
    return (profile.payoutStatus as PayoutStatus) ?? PayoutStatus.pending_verification;
  }

  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(profile.stripeCustomAccountId);
  const payoutStatus = derivePayoutStatusFromAccount(acct);
  await prisma.creatorProfile.update({
    where: { id: creatorProfileId },
    data: { payoutStatus },
  });
  return payoutStatus;
}

export async function getAccountStatus(creatorProfileId: string): Promise<{
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requiresAction: boolean;
  currentlyDue: string[];
}> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile?.stripeCustomAccountId) {
    throw new Error('Creator has no Stripe Connect account');
  }

  if (!isStripeConfigured()) {
    return {
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requiresAction: false,
      currentlyDue: [],
    };
  }

  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(profile.stripeCustomAccountId);
  const reqs = acct.requirements;
  const currentlyDue = reqs?.currently_due ?? [];
  const pastDue = reqs?.past_due ?? [];

  return {
    chargesEnabled: acct.charges_enabled === true,
    payoutsEnabled: acct.payouts_enabled === true,
    detailsSubmitted: acct.details_submitted === true,
    requiresAction: currentlyDue.length > 0 || pastDue.length > 0,
    currentlyDue,
  };
}

function derivePayoutStatusFromAccount(acct: Stripe.Account): PayoutStatus {
  if (acct.payouts_enabled && acct.details_submitted) {
    return PayoutStatus.verified;
  }
  if (acct.requirements?.disabled_reason) {
    return PayoutStatus.disabled;
  }
  const due =
    (acct.requirements?.currently_due?.length ?? 0) +
    (acct.requirements?.past_due?.length ?? 0);
  if (due > 0) {
    return PayoutStatus.requires_update;
  }
  return PayoutStatus.pending_verification;
}

export async function handleAccountUpdated(stripeAccountId: string): Promise<void> {
  if (!isStripeConfigured()) return;

  // A connected account id belongs to either a marketplace CreatorProfile or
  // an Affiliate (separate Connect accounts by design). Resolve both so the
  // single `account.updated` webhook keeps either side's payoutStatus in sync.
  const [profile, affiliate] = await Promise.all([
    prisma.creatorProfile.findFirst({
      where: { stripeCustomAccountId: stripeAccountId },
    }),
    prisma.affiliate.findFirst({
      where: { stripeCustomAccountId: stripeAccountId },
    }),
  ]);
  if (!profile && !affiliate) {
    return;
  }

  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(stripeAccountId);
  const payoutStatus = derivePayoutStatusFromAccount(acct);

  if (profile) {
    await prisma.creatorProfile.update({
      where: { id: profile.id },
      data: { payoutStatus },
    });
  }
  if (affiliate) {
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: { payoutStatus: payoutStatus as any },
    });
  }
}

export async function createCheckoutSession(params: {
  listingId: string;
  buyerEmail: string;
  priceInCents: number;
  creatorStripeAccountId: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  if (!isStripeConfigured()) {
    return params.successUrl;
  }
  const stripe = getStripe();
  const metadata = { listingId: params.listingId, ...params.metadata };
  const fee = platformFeeAmountCents(params.priceInCents);
  if (fee >= params.priceInCents) {
    throw new Error('Platform fee must be less than charge amount');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: params.buyerEmail,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: params.priceInCents,
          product_data: { name: 'Marketplace listing' },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: fee,
      transfer_data: { destination: params.creatorStripeAccountId },
      metadata,
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata,
  });

  if (!session.url) {
    throw new Error('Checkout session has no URL');
  }
  return session.url;
}

export async function createSubscriptionCheckout(params: {
  listingId: string;
  buyerEmail: string;
  stripePriceId: string;
  creatorStripeAccountId: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  if (!isStripeConfigured()) {
    return params.successUrl;
  }
  const stripe = getStripe();
  const metadata = { listingId: params.listingId, ...params.metadata };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: params.buyerEmail,
    line_items: [{ price: params.stripePriceId, quantity: 1 }],
    subscription_data: {
      application_fee_percent: PLATFORM_FEE_PERCENT,
      transfer_data: { destination: params.creatorStripeAccountId },
      metadata,
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata,
  });

  if (!session.url) {
    throw new Error('Checkout session has no URL');
  }
  return session.url;
}

export async function cancelMarketplaceSubscription(
  stripeSubscriptionId: string,
): Promise<void> {
  if (!isStripeConfigured()) return;
  const stripe = getStripe();
  await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
}

export async function triggerPayout(
  creatorProfileId: string,
  amountInCents?: number,
): Promise<string> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile?.stripeCustomAccountId) {
    throw new Error('Creator has no Stripe Connect account');
  }

  if (!isStripeConfigured()) {
    return `po_mock_${Date.now()}`;
  }

  const stripe = getStripe();
  const balance = await stripe.balance.retrieve({
    stripeAccount: profile.stripeCustomAccountId,
  });
  const usdAvailable = balance.available.find((e) => e.currency === 'usd');
  const available = usdAvailable?.amount ?? 0;
  const amount = amountInCents ?? available;
  if (amount <= 0) {
    throw new Error('No amount available to payout');
  }
  if (amount > available) {
    throw new Error('Requested payout exceeds available balance');
  }

  const payout = await stripe.payouts.create(
    { amount, currency: 'usd' },
    { stripeAccount: profile.stripeCustomAccountId },
  );

  return payout.id;
}

export async function getAccountBalance(stripeAccountId: string): Promise<number> {
  if (!isStripeConfigured()) {
    return 0;
  }
  const stripe = getStripe();
  const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
  const usd = balance.available.find((e) => e.currency === 'usd');
  if (usd) {
    return usd.amount;
  }
  return balance.available[0]?.amount ?? 0;
}
