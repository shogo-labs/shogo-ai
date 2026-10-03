// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, mock, test } from 'bun:test'

type PurchaseListener = (purchase: Record<string, unknown>) => void | Promise<void>

const purchaseListeners: PurchaseListener[] = []
const errorListeners: Array<(error: unknown) => void> = []

const nativePurchase = {
  id: 'transaction-123',
  productId: 'ai.shogo.app.pro.monthly',
  appAccountToken: 'WORKSPACE-123',
}

const reactNativeIapMock = {
  initConnection: async () => undefined,
  endConnection: async () => undefined,
  fetchProducts: async () => [{ id: nativePurchase.productId }],
  requestPurchase: async () => {
    await purchaseListeners.at(-1)?.(nativePurchase)
  },
  getAvailablePurchases: async () => [nativePurchase],
  getReceiptDataIOS: async () => 'base64-app-receipt',
  purchaseUpdatedListener: (listener: PurchaseListener) => {
    purchaseListeners.push(listener)
    return {
      remove: () => {
        const index = purchaseListeners.indexOf(listener)
        if (index >= 0) purchaseListeners.splice(index, 1)
      },
    }
  },
  purchaseErrorListener: (listener: (error: unknown) => void) => {
    errorListeners.push(listener)
    return {
      remove: () => {
        const index = errorListeners.indexOf(listener)
        if (index >= 0) errorListeners.splice(index, 1)
      },
    }
  },
}

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }))
mock.module('react-native-iap', () => reactNativeIapMock)

const { initIapListeners, purchaseSubscription, restorePurchases } = await import('../iap')

afterEach(() => {
  purchaseListeners.length = 0
  errorListeners.length = 0
})

describe('react-native-iap v14 purchase normalization', () => {
  test('uses the v14 purchase id and retrieves the iOS app receipt for a new purchase', async () => {
    await expect(purchaseSubscription({
      plan: 'pro',
      interval: 'monthly',
      workspaceId: 'WORKSPACE-123',
    })).resolves.toEqual({
      productId: nativePurchase.productId,
      transactionId: 'transaction-123',
      transactionReceipt: 'base64-app-receipt',
      appAccountToken: 'workspace-123',
    })
  })

  test('uses the same receipt and transaction mapping for pending purchases and restores', async () => {
    const received: unknown[] = []
    const teardown = initIapListeners(async (purchase) => {
      received.push(purchase)
    })

    await purchaseListeners.at(-1)?.(nativePurchase)

    await expect(restorePurchases()).resolves.toEqual([{
      productId: nativePurchase.productId,
      transactionId: 'transaction-123',
      transactionReceipt: 'base64-app-receipt',
      appAccountToken: 'workspace-123',
    }])
    expect(received).toEqual([{
      productId: nativePurchase.productId,
      transactionId: 'transaction-123',
      transactionReceipt: 'base64-app-receipt',
      appAccountToken: 'workspace-123',
    }])

    teardown()
  })
})
