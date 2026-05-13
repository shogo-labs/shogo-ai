// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * iOS In-App Purchase client wrapper for shogo Pro / Business subscriptions.
 *
 * Production design notes:
 *   - All native calls are gated by `Platform.OS === 'ios'` AND a runtime
 *     `require('react-native-iap')` so the module is safe to import from Android
 *     / web bundles without dragging in the native binding.
 *   - StoreKit delivers transactions asynchronously (Ask-to-Buy, app-relaunched
 *     mid-purchase, network blip after Apple charged the card). We register a
 *     global `purchaseUpdatedListener` ONCE on mount via `initIapListeners` so
 *     no transaction is left in the StoreKit queue. This is a hard Apple
 *     requirement — un-finished transactions on relaunch is grounds for rejection.
 *   - `appAccountToken` is normalized to lowercase before send (Apple lowercases
 *     UUIDs in the receipt response — comparing strictly fails otherwise).
 *
 * App Store Connect product IDs (must match exactly):
 *   ai.shogo.{basic|pro|business}.{monthly|annual}
 */
import { Platform } from 'react-native'

export type IapPlan = 'basic' | 'pro' | 'business'
export type IapInterval = 'monthly' | 'annual'

export const IAP_PRODUCT_IDS: Record<IapPlan, Record<IapInterval, string>> = {
  basic:    { monthly: 'ai.shogo.basic.monthly',    annual: 'ai.shogo.basic.annual' },
  pro:      { monthly: 'ai.shogo.pro.monthly',      annual: 'ai.shogo.pro.annual' },
  business: { monthly: 'ai.shogo.business.monthly', annual: 'ai.shogo.business.annual' },
}

export const ALL_PRODUCT_IDS: string[] = Object.values(IAP_PRODUCT_IDS).flatMap((p) => Object.values(p))

export type IapPurchaseResult = {
  productId: string
  transactionId: string
  /**
   * iOS StoreKit transactionReceipt. For SK1 this is a base64 receipt blob;
   * for SK2 it's a signed JWS. Either is accepted by Apple's /verifyReceipt.
   */
  transactionReceipt: string
  appAccountToken?: string
}

export type IapErrorCode =
  | 'not_supported_platform'
  | 'user_cancelled'
  | 'product_not_available'
  | 'network'
  | 'pending'
  | 'unknown'

export class IapError extends Error {
  readonly code: IapErrorCode
  readonly cause?: unknown
  constructor(code: IapErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'IapError'
    this.code = code
    this.cause = cause
  }
}

function loadRNIap(): any | null {
  if (Platform.OS !== 'ios') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-iap')
  } catch (err) {
    console.warn('[IAP] react-native-iap not available:', err)
    return null
  }
}

/**
 * Map react-native-iap error to our typed error code.
 * react-native-iap exposes codes like 'E_USER_CANCELLED', 'E_ITEM_UNAVAILABLE',
 * 'E_NETWORK_ERROR', 'E_DEFERRED_PAYMENT' (Ask to Buy approval pending), etc.
 */
function mapIapError(err: any): IapError {
  const code: string | undefined = err?.code ?? err?.userInfo?.NSUnderlyingError?.code
  switch (code) {
    case 'E_USER_CANCELLED':
      return new IapError('user_cancelled', 'Purchase cancelled by user', err)
    case 'E_ITEM_UNAVAILABLE':
      return new IapError('product_not_available', 'This subscription is not available on the App Store yet', err)
    case 'E_NETWORK_ERROR':
    case 'E_SERVICE_ERROR':
      return new IapError('network', 'Connection to the App Store failed. Please try again.', err)
    case 'E_DEFERRED_PAYMENT':
      return new IapError('pending', 'Purchase is pending approval (e.g. Family Sharing).', err)
    default:
      return new IapError('unknown', err?.message ?? 'In-App Purchase failed', err)
  }
}

let connectionPromise: Promise<void> | null = null
async function ensureConnection(): Promise<any> {
  const RNIap = loadRNIap()
  if (!RNIap) throw new IapError('not_supported_platform', 'IAP is only supported on iOS')
  if (!connectionPromise) {
    connectionPromise = RNIap.initConnection().catch((err: unknown) => {
      connectionPromise = null
      throw err
    })
  }
  await connectionPromise
  return RNIap
}

export async function endIapConnection(): Promise<void> {
  if (Platform.OS !== 'ios') return
  const RNIap = loadRNIap()
  if (!RNIap || !connectionPromise) return
  try {
    await RNIap.endConnection()
  } catch (err) {
    console.warn('[IAP] endConnection failed:', err)
  } finally {
    connectionPromise = null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Async transaction listeners
// ────────────────────────────────────────────────────────────────────────────

export type AsyncPurchaseHandler = (purchase: IapPurchaseResult) => void | Promise<void>
export type AsyncErrorHandler = (err: IapError) => void

let purchaseSub: { remove: () => void } | null = null
let errorSub: { remove: () => void } | null = null

/**
 * Register global purchase / error listeners. Call ONCE per app session
 * (e.g. from a top-level effect in your billing or root layout). Apple
 * REQUIRES that transactions delivered asynchronously be finished — failing
 * to do so causes StoreKit to re-deliver them on every launch and is a
 * common App Review rejection cause.
 *
 * The `onPurchase` callback should:
 *   1. POST the receipt to your /verify-receipt endpoint
 *   2. On success, call `finishPurchase(purchase)` to clear the StoreKit queue
 */
export function initIapListeners(onPurchase: AsyncPurchaseHandler, onError?: AsyncErrorHandler): () => void {
  if (Platform.OS !== 'ios') return () => undefined
  const RNIap = loadRNIap()
  if (!RNIap) return () => undefined

  if (purchaseSub) purchaseSub.remove()
  if (errorSub) errorSub.remove()

  purchaseSub = RNIap.purchaseUpdatedListener(async (p: any) => {
    if (!p || !p.productId) return
    try {
      await onPurchase({
        productId: p.productId,
        transactionId: p.transactionId ?? p.transactionIdentifier ?? '',
        transactionReceipt: p.transactionReceipt ?? '',
        appAccountToken: p.appAccountToken,
      })
    } catch (err) {
      console.warn('[IAP] async purchase handler failed:', err)
    }
  })

  errorSub = RNIap.purchaseErrorListener((err: any) => {
    const mapped = mapIapError(err)
    if (mapped.code !== 'user_cancelled') {
      console.warn('[IAP] purchase error listener:', mapped)
    }
    onError?.(mapped)
  })

  ensureConnection().catch((err) => console.warn('[IAP] eager connection failed:', err))

  return () => {
    purchaseSub?.remove()
    errorSub?.remove()
    purchaseSub = null
    errorSub = null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Purchase / restore / finish
// ────────────────────────────────────────────────────────────────────────────

function normalizeAccountToken(token: string): string {
  // Apple lowercases UUIDs in the resulting receipt. Normalize on the way in
  // so server-side comparison is stable.
  return token.trim().toLowerCase()
}

export async function purchaseSubscription(args: {
  plan: IapPlan
  interval: IapInterval
  workspaceId: string
}): Promise<IapPurchaseResult> {
  if (Platform.OS !== 'ios') {
    throw new IapError('not_supported_platform', 'IAP is only supported on iOS')
  }
  if (!args.workspaceId) {
    throw new IapError('unknown', 'workspaceId is required for IAP')
  }

  const RNIap = await ensureConnection()
  const productId = IAP_PRODUCT_IDS[args.plan][args.interval]
  const appAccountToken = normalizeAccountToken(args.workspaceId)

  try {
    const products = await RNIap.getSubscriptions({ skus: [productId] })
    if (!Array.isArray(products) || products.length === 0) {
      throw new IapError(
        'product_not_available',
        `Subscription "${productId}" is not configured in App Store Connect yet.`,
      )
    }

    const purchase = await RNIap.requestSubscription({
      sku: productId,
      appAccountToken,
    })

    const p = Array.isArray(purchase) ? purchase[0] : purchase
    if (!p) {
      throw new IapError('unknown', 'Purchase returned no transaction')
    }
    if (!p.transactionReceipt) {
      throw new IapError('unknown', 'Purchase did not include a receipt; cannot verify server-side')
    }

    return {
      productId: p.productId,
      transactionId: p.transactionId ?? p.transactionIdentifier ?? '',
      transactionReceipt: p.transactionReceipt,
      appAccountToken,
    }
  } catch (err) {
    if (err instanceof IapError) throw err
    throw mapIapError(err)
  }
}

/**
 * Finish a transaction with StoreKit. MUST be called only AFTER the server
 * has verified the receipt and persisted the subscription state. Otherwise
 * a network drop between verify and finish could leave the user paid-but-
 * not-activated.
 *
 * Accepts the normalized purchase shape returned by this module. It must
 * include the receipt-bearing transaction object, not just a transaction id,
 * so react-native-iap v12 can finish the non-consumable subscription correctly.
 */
export async function finishPurchase(purchase: IapPurchaseResult): Promise<void> {
  if (Platform.OS !== 'ios') return
  const RNIap = loadRNIap()
  if (!RNIap) return
  try {
    if (typeof RNIap.finishTransaction === 'function') {
      // v12+ API
      await RNIap.finishTransaction({ purchase, isConsumable: false })
    } else if (typeof RNIap.finishTransactionIOS === 'function') {
      // v11- fallback
      await RNIap.finishTransactionIOS(purchase.transactionId)
    }
  } catch (err) {
    // Finish is idempotent on Apple's side — log but don't throw.
    console.warn('[IAP] finishTransaction failed (StoreKit will retry on next launch):', err)
  }
}

export async function restorePurchases(): Promise<IapPurchaseResult[]> {
  if (Platform.OS !== 'ios') return []
  const RNIap = await ensureConnection()
  try {
    const purchases = await RNIap.getAvailablePurchases()
    return (purchases || [])
      .filter((p: any) => p?.transactionReceipt)
      .map((p: any) => ({
        productId: p.productId,
        transactionId: p.transactionId ?? p.transactionIdentifier ?? '',
        transactionReceipt: p.transactionReceipt,
        appAccountToken: p.appAccountToken ? normalizeAccountToken(p.appAccountToken) : undefined,
      }))
  } catch (err) {
    throw mapIapError(err)
  }
}

/**
 * Deep-link to the user's App Store subscriptions management page.
 * Apple requires this URL be used (NOT a custom in-app cancel flow) for
 * managing/cancelling iOS subscriptions.
 */
export const APP_STORE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions'
