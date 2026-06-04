// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BillingHistory — in-app list of recent Stripe invoices for a workspace.
 *
 * Lets users see what they were charged (amount, date, status) and open the
 * hosted invoice / PDF without leaving the app or opening the Stripe portal.
 * Renders nothing while empty so free / never-charged workspaces stay clean.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { Receipt, ExternalLink } from 'lucide-react-native'
import { Card, CardContent, Skeleton } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../contexts/domain'
import { api, type BillingInvoice } from '../../lib/api'

function formatAmount(total: number, currency: string): string {
  const value = total.toFixed(2)
  return currency === 'USD' ? `$${value}` : `${value} ${currency}`
}

function formatDate(epochMs: number | null): string {
  if (!epochMs) return ''
  return new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Status → pill background + text color classes. Stripe statuses:
 * paid / open / void / uncollectible / draft. */
function statusStyle(status: string | null): { pill: string; text: string } {
  switch (status) {
    case 'paid':
      return { pill: 'bg-emerald-500/15', text: 'text-emerald-600' }
    case 'open':
      return { pill: 'bg-amber-500/15', text: 'text-amber-600' }
    case 'uncollectible':
    case 'void':
      return { pill: 'bg-destructive/15', text: 'text-destructive' }
    default:
      return { pill: 'bg-muted', text: 'text-muted-foreground' }
  }
}

export function BillingHistory({ workspaceId }: { workspaceId: string | undefined }) {
  const http = useDomainHttp()
  const [invoices, setInvoices] = useState<BillingInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    setError(false)
    try {
      const rows = await api.listInvoices(http, workspaceId)
      setInvoices(rows)
    } catch (e) {
      console.error('[Billing] Failed to load invoices:', e)
      setError(true)
    } finally {
      setIsLoading(false)
    }
  }, [http, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  // Stay out of the way until there's something to show (free / never-charged
  // workspaces). Surface only the loading skeleton, then real rows.
  if (!isLoading && !error && invoices.length === 0) return null

  return (
    <Card className="mb-4">
      <CardContent className="p-4 gap-3">
        <View className="flex-row items-center gap-2">
          <Receipt size={16} className="text-primary" />
          <Text className="text-sm font-medium text-foreground">Billing history</Text>
        </View>

        {isLoading ? (
          <View className="gap-2">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </View>
        ) : error ? (
          <Pressable onPress={load}>
            <Text className="text-xs text-muted-foreground">
              Couldn't load invoices. Tap to retry.
            </Text>
          </Pressable>
        ) : (
          <View className="gap-1">
            {invoices.map((inv, idx) => {
              const url = inv.hostedInvoiceUrl ?? inv.invoicePdf
              const badge = statusStyle(inv.status)
              const RowInner = (
                <View className={cnRow(idx, invoices.length)}>
                  <View className="flex-1 pr-3">
                    <Text className="text-sm font-medium text-foreground">
                      {formatAmount(inv.total, inv.currency)}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {formatDate(inv.created)}
                      {inv.number ? ` · ${inv.number}` : ''}
                    </Text>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <View className={`rounded-full px-2 py-0.5 ${badge.pill}`}>
                      <Text className={`text-[11px] font-medium ${badge.text}`}>
                        {inv.status ?? 'unknown'}
                      </Text>
                    </View>
                    {url ? <ExternalLink size={14} className="text-muted-foreground" /> : null}
                  </View>
                </View>
              )
              return url ? (
                <Pressable key={inv.id} onPress={() => WebBrowser.openBrowserAsync(url)}>
                  {RowInner}
                </Pressable>
              ) : (
                <View key={inv.id}>{RowInner}</View>
              )
            })}
          </View>
        )}
      </CardContent>
    </Card>
  )
}

/** Row container classes with a divider between rows (not after the last). */
function cnRow(idx: number, total: number): string {
  const base = 'flex-row items-center justify-between py-2'
  return idx < total - 1 ? `${base} border-b border-border` : base
}
