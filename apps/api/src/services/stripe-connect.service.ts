// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import Stripe from 'stripe';

import { prisma, PayoutStatus } from '../lib/prisma';

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

export type PayoutDetails = {
  bankAccountToken?: string;
  firstName: string;
  lastName: string;
  dob: { day: number; month: number; year: number };
  address: {
    line1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  ssnLast4?: string;
  email: string;
};

function platformFeeAmountCents(priceInCents: number): number {
  return Math.round((priceInCents * PLATFORM_FEE_PERCENT) / 100);
}

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

  if (!isStripeConfigured()) {
    const mockId = `acct_mock_${creatorProfileId.slice(0, 12)}`;
    await prisma.creatorProfile.update({
      where: { id: creatorProfileId },
      data: { stripeCustomAccountId: mockId },
    });
    return mockId;
  }

  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'custom',
    country,
    email,
    capabilities: {
      transfers: { requested: true },
    },
    settings: {
      payouts: {
        schedule: {
          interval: 'manual',
        },
      },
    },
  });

  await prisma.creatorProfile.update({
    where: { id: creatorProfileId },
    data: { stripeCustomAccountId: account.id },
  });

  return account.id;
}

/**
 * Create a Stripe Custom Connect account for an Affiliate (MLM program).
 *
 * Affiliates and CreatorProfiles deliberately get separate Connect
 * accounts: tax categorization and 1099 issuance differ between
 * marketplace-sales recipients and referral commission recipients,
 * so we keep them on separate Stripe accounts to keep reporting clean.
 *
 * Returns either the existing onboarding URL or the persisted account id.
 * The route layer converts the bare id into a Stripe AccountLink URL.
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

  const email = (affiliate as any).user?.email ?? `affiliate+${affiliateId}@shogo.local`;

  if (!isStripeConfigured()) {
    const mockId = `acct_mock_aff_${affiliateId.slice(0, 12)}`;
    await prisma.affiliate.update({
      where: { id: affiliateId },
      data: { stripeCustomAccountId: mockId },
    });
    return mockId;
  }

  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'custom',
    country: 'US',
    email,
    capabilities: {
      transfers: { requested: true },
    },
    settings: {
      payouts: { schedule: { interval: 'manual' } },
    },
    metadata: { affiliateId, kind: 'affiliate' },
  });

  await prisma.affiliate.update({
    where: { id: affiliateId },
    data: { stripeCustomAccountId: account.id },
  });

  return account.id;
}

/** Affiliate equivalent of submitPayoutDetails — writes back to Affiliate. */
export async function submitPayoutDetailsForAffiliate(
  affiliateId: string,
  details: PayoutDetails,
): Promise<{ payoutStatus: PayoutStatus }> {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
  if (!affiliate?.stripeCustomAccountId) {
    throw new Error('Affiliate has no Stripe Connect account');
  }
  if (!isStripeConfigured()) {
    await prisma.affiliate.update({
      where: { id: affiliateId },
      data: { payoutStatus: 'pending_verification' as any },
    });
    return { payoutStatus: 'pending_verification' as any };
  }

  const stripe = getStripe();
  const individual: Stripe.AccountUpdateParams.Individual = {
    first_name: details.firstName,
    last_name: details.lastName,
    email: details.email,
    dob: { day: details.dob.day, month: details.dob.month, year: details.dob.year },
    address: {
      line1: details.address.line1,
      city: details.address.city,
      state: details.address.state,
      postal_code: details.address.postal_code,
      country: details.address.country,
    },
  };
  if (details.ssnLast4) individual.ssn_last_4 = details.ssnLast4;

  const params: Stripe.AccountUpdateParams = { individual };
  if (details.bankAccountToken) params.external_account = details.bankAccountToken;

  await stripe.accounts.update(affiliate.stripeCustomAccountId, params);
  await prisma.affiliate.update({
    where: { id: affiliateId },
    data: { payoutStatus: 'pending_verification' as any },
  });
  return { payoutStatus: 'pending_verification' as any };
}

export async function submitPayoutDetails(
  creatorProfileId: string,
  details: PayoutDetails,
): Promise<void> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile) {
    throw new Error('Creator profile not found');
  }

  // Self-heal: if the Connect account was never provisioned (e.g. the
  // best-effort creation during profile setup failed, or predates that
  // step), create it now rather than rejecting the payout submission.
  const stripeAccountId =
    profile.stripeCustomAccountId ??
    (await createCustomAccount(
      creatorProfileId,
      details.email,
      details.address.country,
    ));

  if (!isStripeConfigured()) {
    await prisma.creatorProfile.update({
      where: { id: creatorProfileId },
      data: {
        payoutStatus: PayoutStatus.pending_verification,
        payoutDetailsSubmittedAt: new Date(),
      },
    });
    return;
  }

  const stripe = getStripe();
  const individual: Stripe.AccountUpdateParams.Individual = {
    first_name: details.firstName,
    last_name: details.lastName,
    email: details.email,
    dob: {
      day: details.dob.day,
      month: details.dob.month,
      year: details.dob.year,
    },
    address: {
      line1: details.address.line1,
      city: details.address.city,
      state: details.address.state,
      postal_code: details.address.postal_code,
      country: details.address.country,
    },
  };
  if (details.ssnLast4) {
    individual.ssn_last_4 = details.ssnLast4;
  }

  const params: Stripe.AccountUpdateParams = { individual };
  if (details.bankAccountToken) {
    params.external_account = details.bankAccountToken;
  }

  await stripe.accounts.update(stripeAccountId, params);

  await prisma.creatorProfile.update({
    where: { id: creatorProfileId },
    data: {
      payoutStatus: PayoutStatus.pending_verification,
      payoutDetailsSubmittedAt: new Date(),
    },
  });
}

/**
 * Create a Stripe-hosted onboarding URL for a creator's Connect account.
 *
 * Returns a short-lived URL that walks the creator through identity,
 * address, DOB, SSN, document upload, and bank-account collection on
 * Stripe's own pages — replaces the custom KYC form previously posted
 * to `submitPayoutDetails`.
 *
 * In mock mode (no STRIPE_SECRET_KEY) returns `params.returnUrl` so the
 * client flow stays exercisable in dev/CI without hitting Stripe.
 */
export async function createOnboardingLink(
  creatorProfileId: string,
  params: { refreshUrl: string; returnUrl: string },
): Promise<{ url: string }> {
  const profile = await prisma.creatorProfile.findUnique({
    where: { id: creatorProfileId },
  });
  if (!profile?.stripeCustomAccountId) {
    throw new Error('Creator has no Stripe Connect account');
  }

  if (!isStripeConfigured()) {
    return { url: params.returnUrl };
  }

  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: profile.stripeCustomAccountId,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: 'account_onboarding',
  });
  return { url: link.url };
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

  const profile = await prisma.creatorProfile.findFirst({
    where: { stripeCustomAccountId: stripeAccountId },
  });
  if (!profile) {
    return;
  }

  const stripe = getStripe();
  const acct = await stripe.accounts.retrieve(stripeAccountId);
  const payoutStatus = derivePayoutStatusFromAccount(acct);

  await prisma.creatorProfile.update({
    where: { id: profile.id },
    data: { payoutStatus },
  });
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
