// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Apple In-App Purchase server-side verification + subscription state sync.
 *
 * Required environment variables:
 *   APPLE_IAP_SHARED_SECRET   App-Specific Shared Secret from App Store Connect
 *   APPLE_IAP_BUNDLE_ID       (optional) Expected bundle ID for receipt validation
 *                             — defaults to com.odin.ai
 */
import { prisma, type SubscriptionStatus, type BillingInterval } from '../lib/prisma';
import * as billingService from './billing.service';
import { X509Certificate, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const SANDBOX_RETRY_STATUS = 21007;
const DEFAULT_BUNDLE_ID = 'com.odin.ai';
const MAX_RECEIPT_LENGTH = 200_000; // ~200KB — Apple receipts are usually <10KB

const PRODUCT_MAP: Record<string, { planId: 'basic' | 'pro' | 'business'; interval: 'monthly' | 'annual' }> = {
  'ai.shogo.basic.monthly':    { planId: 'basic',    interval: 'monthly' },
  'ai.shogo.basic.annual':     { planId: 'basic',    interval: 'annual' },
  'ai.shogo.pro.monthly':      { planId: 'pro',      interval: 'monthly' },
  'ai.shogo.pro.annual':       { planId: 'pro',      interval: 'annual' },
  'ai.shogo.business.monthly': { planId: 'business', interval: 'monthly' },
  'ai.shogo.business.annual':  { planId: 'business', interval: 'annual' },
};

export function resolveProduct(productId: string) {
  return PRODUCT_MAP[productId] ?? null;
}

type AppleReceiptInfo = {
  product_id: string;
  transaction_id: string;
  original_transaction_id: string;
  purchase_date_ms: string;
  expires_date_ms?: string;
  cancellation_date_ms?: string;
  is_trial_period?: string;
  app_account_token?: string;
};

type PendingRenewalInfo = {
  product_id?: string;
  original_transaction_id?: string;
  auto_renew_status?: string;
  is_in_billing_retry_period?: string;
  grace_period_expires_date_ms?: string;
  expiration_intent?: string;
};

type AppleVerifyResponse = {
  status: number;
  environment?: string;
  receipt?: { bundle_id?: string; in_app?: AppleReceiptInfo[] };
  latest_receipt?: string;
  latest_receipt_info?: AppleReceiptInfo[];
  pending_renewal_info?: PendingRenewalInfo[];
};

async function callAppleVerify(receiptData: string): Promise<AppleVerifyResponse> {
  const sharedSecret = process.env.APPLE_IAP_SHARED_SECRET;
  if (!sharedSecret) {
    throw new Error('APPLE_IAP_SHARED_SECRET is not configured');
  }
  const body = JSON.stringify({
    'receipt-data': receiptData,
    password: sharedSecret,
    'exclude-old-transactions': true,
  });
  const headers = { 'Content-Type': 'application/json' } as const;

  // 10s timeout per attempt — Apple is usually <1s but we don't want to hang.
  const fetchWithTimeout = async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      return (await res.json()) as AppleVerifyResponse;
    } finally {
      clearTimeout(timer);
    }
  };

  let data = await fetchWithTimeout(APPLE_PROD_URL);
  if (data.status === SANDBOX_RETRY_STATUS) {
    data = await fetchWithTimeout(APPLE_SANDBOX_URL);
  }
  return data;
}

function latestForProduct(infos: AppleReceiptInfo[] | undefined, productId: string): AppleReceiptInfo | null {
  if (!infos?.length) return null;
  const filtered = infos.filter((r) => r.product_id === productId);
  if (!filtered.length) return null;
  return filtered.slice().sort((a, b) => Number(b.expires_date_ms ?? 0) - Number(a.expires_date_ms ?? 0))[0];
}

function findRenewalInfo(infos: PendingRenewalInfo[] | undefined, originalTxId: string): PendingRenewalInfo | undefined {
  return infos?.find((r) => r.original_transaction_id === originalTxId);
}

function deriveStatus(info: AppleReceiptInfo, renewal: PendingRenewalInfo | undefined): SubscriptionStatus {
  if (info.cancellation_date_ms) return 'canceled' as SubscriptionStatus;

  const expiresMs = Number(info.expires_date_ms ?? 0);
  const isExpired = expiresMs > 0 && expiresMs < Date.now();

  // In grace period — Apple is retrying the payment, user still has access.
  const graceMs = Number(renewal?.grace_period_expires_date_ms ?? 0);
  if (isExpired && graceMs && graceMs > Date.now()) {
    return 'past_due' as SubscriptionStatus;
  }
  if (renewal?.is_in_billing_retry_period === '1') {
    return 'past_due' as SubscriptionStatus;
  }
  if (isExpired) return 'past_due' as SubscriptionStatus;
  if (info.is_trial_period === 'true') return 'trialing' as SubscriptionStatus;
  return 'active' as SubscriptionStatus;
}

function deriveCancelAtPeriodEnd(renewal: PendingRenewalInfo | undefined): boolean {
  // auto_renew_status = '0' means the user toggled off auto-renew in App Store
  return renewal?.auto_renew_status === '0';
}

export type VerifyArgs = {
  workspaceId: string;
  productId: string;
  transactionId: string;
  transactionReceipt: string;
  appAccountToken?: string;
};

export type VerifyResult =
  | { ok: true; planId: string; interval: BillingInterval; expiresAt: Date; originalTransactionId: string; status: SubscriptionStatus; alreadyProcessed?: boolean }
  | { ok: false; reason: string; appleStatus?: number };

/**
 * Verify an iOS receipt with Apple and sync the resulting subscription state.
 *
 * Idempotent: if the same (originalTransactionId, expiresAt) has already been
 * processed for this workspace, returns ok with alreadyProcessed=true and
 * skips the DB upsert.
 */
export async function verifyAndSyncReceipt(args: VerifyArgs): Promise<VerifyResult> {
  // ── Input validation ────────────────────────────────────────────────────
  if (!args.transactionReceipt || typeof args.transactionReceipt !== 'string') {
    return { ok: false, reason: 'transactionReceipt is required and must be a string' };
  }
  if (args.transactionReceipt.length > MAX_RECEIPT_LENGTH) {
    return { ok: false, reason: `receipt too large (>${MAX_RECEIPT_LENGTH} chars)` };
  }
  const mapped = resolveProduct(args.productId);
  if (!mapped) {
    return { ok: false, reason: `Unknown productId: ${args.productId}` };
  }

  // ── Apple verify ────────────────────────────────────────────────────────
  let apple: AppleVerifyResponse;
  try {
    apple = await callAppleVerify(args.transactionReceipt);
  } catch (err) {
    return { ok: false, reason: `Apple verify request failed: ${(err as Error).message}` };
  }
  if (apple.status !== 0) {
    return { ok: false, reason: `Apple verification rejected`, appleStatus: apple.status };
  }

  // ── Bundle ID guard ─────────────────────────────────────────────────────
  const expectedBundleId = process.env.APPLE_IAP_BUNDLE_ID ?? DEFAULT_BUNDLE_ID;
  if (apple.receipt?.bundle_id && apple.receipt.bundle_id !== expectedBundleId) {
    return { ok: false, reason: `bundle_id mismatch: got ${apple.receipt.bundle_id}, expected ${expectedBundleId}` };
  }

  // ── Find the latest receipt for the requested product ──────────────────
  const info = latestForProduct(apple.latest_receipt_info, args.productId)
    ?? latestForProduct(apple.receipt?.in_app, args.productId);
  if (!info) {
    return { ok: false, reason: 'No matching transaction in Apple response' };
  }

  // ── Workspace binding (case-insensitive — Apple lowercases UUIDs) ──────
  if (info.app_account_token) {
    const got = info.app_account_token.trim().toLowerCase();
    const expected = args.workspaceId.trim().toLowerCase();
    if (got !== expected) {
      return { ok: false, reason: 'app_account_token does not match workspaceId' };
    }
  }

  const renewal = findRenewalInfo(apple.pending_renewal_info, info.original_transaction_id);
  const expiresAt = info.expires_date_ms ? new Date(Number(info.expires_date_ms)) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const purchasedAt = info.purchase_date_ms ? new Date(Number(info.purchase_date_ms)) : new Date();
  const status = deriveStatus(info, renewal);
  const cancelAtPeriodEnd = deriveCancelAtPeriodEnd(renewal);

  // Apple's originalTransactionId is the stable subscription identifier.
  // Prefix with `apple:` so it never collides with a Stripe ID (and so we
  // can disambiguate downstream).
  const stableId = `apple:${info.original_transaction_id}`;

  // ── Idempotency: skip upsert if nothing material changed ────────────────
  const existing = await prisma.subscription.findUnique({
    where: { workspaceId: args.workspaceId },
    select: {
      stripeSubscriptionId: true,
      currentPeriodEnd: true,
      status: true,
      cancelAtPeriodEnd: true,
      planId: true,
      seats: true,
    },
  });
  const unchanged =
    existing &&
    existing.stripeSubscriptionId === stableId &&
    existing.planId === mapped.planId &&
    existing.status === status &&
    existing.cancelAtPeriodEnd === cancelAtPeriodEnd &&
    existing.currentPeriodEnd.getTime() === expiresAt.getTime();
  if (unchanged) {
    return {
      ok: true,
      planId: mapped.planId,
      interval: mapped.interval as BillingInterval,
      expiresAt,
      originalTransactionId: info.original_transaction_id,
      status,
      alreadyProcessed: true,
    };
  }

  await billingService.syncFromStripe({
    workspaceId: args.workspaceId,
    stripeSubscriptionId: stableId,
    stripeCustomerId: `apple:${info.original_transaction_id}`,
    planId: mapped.planId,
    seats: 1, // iOS = 1 seat per IAP — see apps/mobile/lib/iap.ts
    status,
    billingInterval: mapped.interval as BillingInterval,
    currentPeriodStart: purchasedAt,
    currentPeriodEnd: expiresAt,
    cancelAtPeriodEnd,
  });

  return {
    ok: true,
    planId: mapped.planId,
    interval: mapped.interval as BillingInterval,
    expiresAt,
    originalTransactionId: info.original_transaction_id,
    status,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// JWS verification — Apple App Store Server Notifications V2 + StoreKit 2
// ────────────────────────────────────────────────────────────────────────────
//
// Apple signs ASSN V2 payloads as JWS using ES256, with the leaf signing cert
// embedded in the JWS header `x5c` chain. We verify:
//   1. Chain integrity: each cert is signed by the next.
//   2. Trust anchor: the topmost cert is Apple Root CA - G3 (sha256 fingerprint).
//   3. Validity windows: all certs are not-expired / not-before now.
//   4. JWS signature: payload is signed by the leaf cert's public key (ES256).
//
// Source: https://developer.apple.com/documentation/appstoreserverapi/jwsdecodedheader
// Apple Root CA G3 PEM: apps/api/src/certs/AppleRootCA-G3.pem
const APPLE_ROOT_CA_G3_PATH = new URL('../certs/AppleRootCA-G3.pem', import.meta.url);

let _appleRoot: X509Certificate | null = null;
function appleRootCa(): X509Certificate {
  if (!_appleRoot) _appleRoot = new X509Certificate(readFileSync(APPLE_ROOT_CA_G3_PATH, 'utf8'));
  return _appleRoot;
}

function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64');
}

class JwsVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'JwsVerificationError'; }
}

/**
 * Verify a JWS signedPayload anchored to Apple Root CA G3 and return its
 * decoded payload. Throws JwsVerificationError on any chain / signature
 * failure.
 *
 * Allows opting out via `APPLE_IAP_SKIP_JWS_VERIFY=1` ONLY for local dev /
 * sandbox tests — production must never set this flag.
 */
export function verifyAndDecodeJws(jws: string): Record<string, any> {
  if (process.env.APPLE_IAP_SKIP_JWS_VERIFY === '1') {
    console.warn('[IAP] APPLE_IAP_SKIP_JWS_VERIFY=1 — skipping JWS signature verification. DO NOT USE IN PRODUCTION.');
    const decoded = decodeJwsPayloadUnverified(jws);
    if (!decoded) throw new JwsVerificationError('payload decode failed');
    return decoded;
  }

  const parts = jws.split('.');
  if (parts.length !== 3) throw new JwsVerificationError('JWS must have 3 dot-separated parts');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: Record<string, any>;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  } catch {
    throw new JwsVerificationError('JWS header is not valid JSON');
  }
  if (header.alg !== 'ES256') {
    throw new JwsVerificationError(`Unsupported JWS alg: ${header.alg} (expected ES256)`);
  }
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every((c) => typeof c === 'string')) {
    throw new JwsVerificationError('JWS header missing or malformed x5c chain');
  }

  // Parse the certificate chain.
  let certs: X509Certificate[];
  try {
    certs = x5c.map((b64) => new X509Certificate(Buffer.from(b64, 'base64')));
  } catch (err) {
    throw new JwsVerificationError(`x5c parse failed: ${(err as Error).message}`);
  }

  // 1. Each non-root cert must be signed by the next.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new JwsVerificationError(`x5c chain broken at index ${i}: not signed by parent`);
    }
  }

  // 2. Trust anchor: the topmost cert must be Apple Root CA G3
  //    (compare by sha256 fingerprint to avoid spoofing).
  const top = certs[certs.length - 1];
  if (top.fingerprint256 !== appleRootCa().fingerprint256) {
    throw new JwsVerificationError(`JWS chain not anchored to Apple Root CA G3 (got ${top.subject})`);
  }

  // 3. Validity windows.
  const now = Date.now();
  for (const c of certs) {
    if (Date.parse(c.validFrom) > now) throw new JwsVerificationError(`cert not yet valid: ${c.subject}`);
    if (Date.parse(c.validTo)   < now) throw new JwsVerificationError(`cert expired: ${c.subject}`);
  }

  // 4. JWS signature.
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);
  const ok = cryptoVerify(
    'sha256',
    signingInput,
    { key: certs[0].publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!ok) throw new JwsVerificationError('JWS signature verification failed');

  try {
    return JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new JwsVerificationError('JWS payload is not valid JSON');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// App Store Server Notifications V2
// ────────────────────────────────────────────────────────────────────────────

/**
 * Handler for ASSN V2 webhooks. The outer notification payload and nested
 * transaction/renewal payloads are verified against Apple's x5c certificate
 * chain before use. Webhooks only refresh subscriptions we already know about;
 * initial entitlement still comes from the authenticated /verify-receipt flow.
 */
export type NotificationResult = {
  ok: boolean;
  notificationType?: string;
  processed?: boolean;
  skipped?: 'no_subscription' | 'stale_event' | 'no_transaction';
  reason?: string;
};

export async function handleAppStoreNotification(signedPayload: string): Promise<NotificationResult> {
  // 1. Cryptographically verify the JWS — anyone can POST to our endpoint;
  //    only Apple holds the private key for the leaf cert in the chain.
  let decoded: Record<string, any>;
  try {
    decoded = verifyAndDecodeJws(signedPayload);
  } catch (err) {
    console.error('[IAP] ASSN JWS verification failed:', (err as Error).message);
    return { ok: false, reason: 'jws_verification_failed' };
  }

  const notificationType: string | undefined = decoded.notificationType;
  const signedDate = Number(decoded.signedDate ?? 0);
  const signedTx = decoded.data?.signedTransactionInfo;
  if (!signedTx) return { ok: true, notificationType, processed: false, skipped: 'no_transaction' };

  let tx: Record<string, any>;
  try {
    tx = verifyAndDecodeJws(signedTx);
  } catch (err) {
    console.error('[IAP] ASSN signedTransactionInfo JWS verification failed:', (err as Error).message);
    return { ok: false, notificationType, reason: 'jws_verification_failed' };
  }

  const originalTxId: string | undefined = tx.originalTransactionId;
  if (!originalTxId) return { ok: false, notificationType, reason: 'missing_originalTransactionId' };

  const stableId = `apple:${originalTxId}`;
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: stableId } });
  if (!existing) {
    // No matching subscription yet — happens for the initial SUBSCRIBED event
    // delivered before the client has called /verify-receipt. Safe to ignore;
    // the client's verify call will create the record.
    return { ok: true, notificationType, processed: false, skipped: 'no_subscription' };
  }

  // 2. Timestamp idempotency: Apple does NOT guarantee notification ordering.
  //    If a newer event (e.g. DID_RENEW with future expiry) has already been
  //    processed, drop any older event (e.g. an out-of-order EXPIRED) so it
  //    can't roll our state backward. We use the Subscription.updatedAt as the
  //    high-water mark — Prisma touches it on every write.
  if (signedDate && signedDate < existing.updatedAt.getTime() - 1000 /* 1s tolerance */) {
    console.log('[IAP] dropping stale notification', {
      notificationType,
      originalTxId,
      signedDate: new Date(signedDate).toISOString(),
      lastUpdate: existing.updatedAt.toISOString(),
    });
    return { ok: true, notificationType, processed: false, skipped: 'stale_event' };
  }

  const expiresAt = tx.expiresDate ? new Date(Number(tx.expiresDate)) : existing.currentPeriodEnd;

  // Derive cancelAtPeriodEnd from signedRenewalInfo if present.
  let cancelAtPeriodEnd = existing.cancelAtPeriodEnd;
  if (decoded.data?.signedRenewalInfo) {
    let renewal: Record<string, any> | null = null;
    try {
      renewal = verifyAndDecodeJws(decoded.data.signedRenewalInfo);
    } catch (err) {
      console.warn('[IAP] signedRenewalInfo JWS verification failed (continuing with prior state):', (err as Error).message);
    }
    if (renewal && typeof renewal.autoRenewStatus === 'number') {
      cancelAtPeriodEnd = renewal.autoRenewStatus === 0;
    }
  }

  // Map notification type → status
  let status: SubscriptionStatus = existing.status;
  switch (notificationType) {
    case 'EXPIRED':
    case 'REVOKE':
    case 'REFUND':
      status = 'canceled' as SubscriptionStatus;
      break;
    case 'GRACE_PERIOD_EXPIRED':
    case 'DID_FAIL_TO_RENEW':
      status = 'past_due' as SubscriptionStatus;
      break;
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'OFFER_REDEEMED':
      status = expiresAt.getTime() < Date.now() ? ('past_due' as SubscriptionStatus) : ('active' as SubscriptionStatus);
      break;
    case 'DID_CHANGE_RENEWAL_STATUS':
    case 'DID_CHANGE_RENEWAL_PREF':
      // Status unchanged; only cancelAtPeriodEnd / plan may have changed.
      break;
    default:
      // Unknown event — refresh expires/status conservatively
      status = expiresAt.getTime() < Date.now() ? ('past_due' as SubscriptionStatus) : status;
      break;
  }

  // If the user upgraded/downgraded between plans within the same group, the
  // productId changes. Reflect it on our side too.
  const newProductId: string | undefined = tx.productId;
  const mapped = newProductId ? resolveProduct(newProductId) : null;

  await prisma.subscription.update({
    where: { stripeSubscriptionId: stableId },
    data: {
      status,
      currentPeriodEnd: expiresAt,
      cancelAtPeriodEnd,
      ...(mapped ? { planId: mapped.planId, billingInterval: mapped.interval as BillingInterval } : {}),
    },
  });

  return { ok: true, notificationType, processed: true };
}

/**
 * Decode JWS payload WITHOUT signature verification. Only used when
 * `APPLE_IAP_SKIP_JWS_VERIFY=1` is set (local dev / sandbox tests).
 * Never called in production code paths.
 */
function decodeJwsPayloadUnverified(jws: string): { [k: string]: any } | null {
  try {
    const parts = jws.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
