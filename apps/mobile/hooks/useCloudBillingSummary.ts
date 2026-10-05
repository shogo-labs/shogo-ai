// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PlatformApi,
  type CloudBillingSummary,
} from '@shogo-ai/sdk'
import { createHttpClient } from '../lib/api'
import { buildCloudBillingUrls } from '../lib/billing-config'

export function useCloudBillingSummary(enabled = true) {
  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])
  const [summary, setSummary] = useState<CloudBillingSummary | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled) return null
    setIsLoading(true)
    setError(null)
    try {
      const fetched = await platform.cloudBillingSummary()
      // Older/partial responses may lack the cloud page URLs; derive them so
      // the Upgrade / Manage buttons always have somewhere to go.
      const next: CloudBillingSummary = fetched.signedIn
        ? {
            ...fetched,
            ...buildCloudBillingUrls(fetched.cloudUrl, fetched.workspace?.id),
            ...(fetched.manageUrl ? { manageUrl: fetched.manageUrl } : {}),
            ...(fetched.upgradeUrl ? { upgradeUrl: fetched.upgradeUrl } : {}),
          }
        : fetched
      setSummary(next)
      return next
    } catch (requestError: any) {
      const message: string =
        requestError?.message || 'Unable to load Shogo Cloud billing'
      // A revoked device key makes the proxied plan request return 401, and a
      // local API that predates the billing bridge returns 404. The local
      // status endpoint still has the account identity and rejection flag, so
      // preserve that state (plus working cloud URLs) for the UI.
      try {
        const status = await platform.cloudLoginStatus()
        if (status.signedIn) {
          const rejected: CloudBillingSummary = {
            signedIn: true,
            cloudUrl: status.cloudUrl,
            email: status.email,
            workspace: status.workspace,
            cloudKeyRejected: status.cloudKeyRejected ?? true,
            ...buildCloudBillingUrls(status.cloudUrl, status.workspace?.id),
            error: message,
          }
          setSummary(rejected)
          setError(message)
          return rejected
        }
      } catch {
        // Report the original billing request below.
      }
      setSummary(null)
      setError(message)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [enabled, platform])

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return
    }
    void refresh()
  }, [enabled, refresh])

  const setSpendingLimit = useCallback(async (limitUsd: number | null): Promise<void> => {
    const result = await platform.setCloudSpendingLimit({
      overageEnabled: true,
      overageHardLimitUsd: limitUsd,
    })
    if (!result.ok) {
      const errorData = result.error as any
      throw new Error(errorData?.message || 'Failed to update spending limit')
    }
    await refresh()
  }, [platform, refresh])

  return {
    summary,
    isLoading,
    error,
    refresh,
    setSpendingLimit,
  }
}
