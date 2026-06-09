// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate / referral dashboard.
 *
 * Now lives inside the unified Creator hub (`/(app)/creator`) as the
 * "Referrals" tab via the exported {@link AffiliateReferralPanel}. The default
 * export of this route just redirects into that hub so old links keep working.
 *
 * - Not enrolled  → CTA card linking to /affiliate/enroll
 * - Enrolled      → balance + referral link + 30d stats + entry points
 *                   to commissions / payouts / downline screens.
 *
 * Data is pulled exclusively from /api/affiliates/me; never trust
 * the client cache for payout amounts.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Platform, Share,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { Redirect, useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft, Copy, Share2, Wallet, Users, ChevronRight, AlertTriangle, Video,
} from 'lucide-react-native'
import { Card, CardContent, Button, Badge } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import { affiliateApi, buildReferralLink, type AffiliateSummary } from '../../../lib/affiliate-api'

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Redirect legacy `/(app)/affiliate` into the unified Creator hub's Referrals
 * tab. The real UI is {@link AffiliateReferralPanel}, embedded by the hub.
 */
export default function AffiliateDashboardRedirect() {
  return <Redirect href="/(app)/creator?tab=refer" />
}

/**
 * The referral/affiliate dashboard body. Rendered by the Creator hub
 * (`embedded`) or standalone. When embedded, the hub supplies the page header
 * and tab bar, so we drop the local back-header.
 */
export const AffiliateReferralPanel = observer(function AffiliateReferralPanel({
  embedded = false,
}: {
  embedded?: boolean
}) {
  const router = useRouter()
  const http = useDomainHttp()
  const params = useLocalSearchParams<{ connect?: string }>()

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [enrolled, setEnrolled] = useState<boolean | null>(null)
  const [summary, setSummary] = useState<AffiliateSummary | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setErrorMsg(null)
    try {
      const res = await affiliateApi.me(http)
      if (!('enrolled' in res) || !res.enrolled) {
        setEnrolled(false)
        setSummary(null)
      } else {
        setEnrolled(true)
        const { enrolled: _e, ...rest } = res
        setSummary(rest as AffiliateSummary)
      }
    } catch (err: any) {
      // 503 = feature flag off; treat as "not available"
      const status = err?.status ?? err?.response?.status
      if (status === 503) {
        setEnrolled(null)
        setErrorMsg('Affiliate program is not yet available on your region.')
      } else {
        setErrorMsg(err?.message ?? 'Failed to load affiliate info.')
      }
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http])

  useEffect(() => { load() }, [load])

  // Pull the latest Connect account status from Stripe (source of truth is
  // the account.updated webhook, but it can lag), then reload the dashboard.
  const syncConnect = useCallback(async () => {
    try { await affiliateApi.getConnectStatus(http) } catch { /* best effort */ }
    await load()
  }, [http, load])

  // Returning from Stripe-hosted onboarding (return_url adds ?connect=done)
  // — refresh payout status so the UI reflects a now-verified account.
  useEffect(() => {
    if (params.connect === 'done' || params.connect === 'refresh') {
      syncConnect()
    }
  }, [params.connect, syncConnect])

  const referralLink = summary ? buildReferralLink(summary.affiliate.code) : ''

  const copyLink = useCallback(async () => {
    if (!referralLink) return
    await Clipboard.setStringAsync(referralLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [referralLink])

  const shareLink = useCallback(async () => {
    if (!referralLink) return
    try {
      await Share.share({
        message: `Join me on Shogo: ${referralLink}`,
        url: referralLink,
      })
    } catch {
      // user cancelled — no-op
    }
  }, [referralLink])

  return (
    <View className="flex-1 bg-background">
      {!embedded ? (
        <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={22} className="text-foreground" />
          </Pressable>
          <Text className="text-lg font-semibold text-foreground">Affiliate Program</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={
          Platform.OS !== 'web' ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load() }}
            />
          ) : undefined
        }
      >
        {loading ? (
          <View className="py-16 items-center"><ActivityIndicator /></View>
        ) : errorMsg ? (
          <Card>
            <CardContent className="flex-row items-start gap-3 p-4">
              <AlertTriangle size={20} className="text-yellow-500 mt-0.5" />
              <Text className="text-sm text-foreground flex-1">{errorMsg}</Text>
            </CardContent>
          </Card>
        ) : enrolled === false ? (
          <NotEnrolledCard onEnroll={() => router.push('/(app)/affiliate/enroll')} />
        ) : summary ? (
          <>
            <BalanceCard summary={summary} />
            <ReferralLinkCard
              link={referralLink}
              code={summary.affiliate.code}
              copied={copied}
              onCopy={copyLink}
              onShare={shareLink}
            />
            <StatsRow summary={summary} />
            <View className="gap-2">
              <NavRow
                icon={<Wallet size={18} className="text-foreground" />}
                title="Commissions"
                subtitle={`${summary.commissionsLast30d} in the last 30 days`}
                onPress={() => router.push('/(app)/affiliate/commissions')}
              />
              <NavRow
                icon={<Wallet size={18} className="text-foreground" />}
                title="Payouts"
                subtitle={`Lifetime ${dollars(summary.lifetimePayoutCents)}`}
                onPress={() => router.push('/(app)/affiliate/payouts')}
              />
              <NavRow
                icon={<Users size={18} className="text-foreground" />}
                title="Downline"
                subtitle="See who you've referred"
                onPress={() => router.push('/(app)/affiliate/downline')}
              />
              <NavRow
                icon={<Video size={18} className="text-foreground" />}
                title="Content earnings"
                subtitle="Connect Instagram / TikTok, earn per view"
                onPress={() => router.push('/(app)/affiliate/content')}
              />
            </View>

            <PayoutSetupCard summary={summary} onChanged={syncConnect} />
            <Disclosure />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
})

function NotEnrolledCard({ onEnroll }: { onEnroll: () => void }) {
  return (
    <Card>
      <CardContent className="gap-3 p-5">
        <Text className="text-lg font-semibold text-foreground">Refer Shogo and earn</Text>
        <Text className="text-sm text-muted-foreground">
          Share your link. When someone signs up and pays, you earn 20% of their
          seat subscription for the first 12 months, then 10% forever after.
          Opt in to get your unique link.
        </Text>
        <Button onPress={onEnroll}>
          <Text className="text-primary-foreground font-medium">Become an affiliate</Text>
        </Button>
      </CardContent>
    </Card>
  )
}

function BalanceCard({ summary }: { summary: AffiliateSummary }) {
  return (
    <Card>
      <CardContent className="gap-1 p-5">
        <Text className="text-xs uppercase text-muted-foreground tracking-wide">Pending payout</Text>
        <Text className="text-3xl font-bold text-foreground">{dollars(summary.pendingPayoutCents)}</Text>
        <Text className="text-sm text-muted-foreground">
          Lifetime paid: {dollars(summary.lifetimePayoutCents)}
        </Text>
        <View className="flex-row gap-2 mt-2">
          <Badge variant={summary.affiliate.status === 'active' ? 'default' : 'secondary'}>
            <Text className="text-xs">{summary.affiliate.status}</Text>
          </Badge>
          <Badge variant="secondary"><Text className="text-xs">L{summary.affiliate.depth}</Text></Badge>
        </View>
      </CardContent>
    </Card>
  )
}

function ReferralLinkCard({
  link, code, copied, onCopy, onShare,
}: {
  link: string; code: string; copied: boolean
  onCopy: () => void; onShare: () => void
}) {
  return (
    <Card>
      <CardContent className="gap-2 p-4">
        <Text className="text-xs uppercase text-muted-foreground tracking-wide">Your link</Text>
        <Text className="text-sm text-foreground" numberOfLines={1} ellipsizeMode="middle">
          {link}
        </Text>
        <Text className="text-xs text-muted-foreground">Code: {code}</Text>
        <View className="flex-row gap-2 mt-1">
          <Button variant="secondary" onPress={onCopy} className="flex-1">
            <View className="flex-row items-center gap-2">
              <Copy size={14} className="text-foreground" />
              <Text className="text-foreground text-sm">{copied ? 'Copied' : 'Copy'}</Text>
            </View>
          </Button>
          <Button onPress={onShare} className="flex-1">
            <View className="flex-row items-center gap-2">
              <Share2 size={14} className="text-primary-foreground" />
              <Text className="text-primary-foreground text-sm">Share</Text>
            </View>
          </Button>
        </View>
      </CardContent>
    </Card>
  )
}

function StatsRow({ summary }: { summary: AffiliateSummary }) {
  return (
    <View className="flex-row gap-2">
      <Stat label="Clicks (30d)" value={summary.clicksLast30d} />
      <Stat label="Signups (30d)" value={summary.signupsLast30d} />
      <Stat label="Commissions (30d)" value={summary.commissionsLast30d} />
    </View>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="flex-1">
      <CardContent className="p-3 items-center">
        <Text className="text-xl font-bold text-foreground">{value}</Text>
        <Text className="text-[10px] uppercase text-muted-foreground text-center">{label}</Text>
      </CardContent>
    </Card>
  )
}

function NavRow({
  icon, title, subtitle, onPress,
}: { icon: React.ReactNode; title: string; subtitle: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <Card>
        <CardContent className="flex-row items-center gap-3 p-3">
          {icon}
          <View className="flex-1">
            <Text className="text-foreground font-medium">{title}</Text>
            <Text className="text-xs text-muted-foreground">{subtitle}</Text>
          </View>
          <ChevronRight size={18} className="text-muted-foreground" />
        </CardContent>
      </Card>
    </Pressable>
  )
}

function PayoutSetupCard({
  summary, onChanged,
}: { summary: AffiliateSummary; onChanged: () => void | Promise<void> }) {
  const http = useDomainHttp()
  const [working, setWorking] = useState(false)
  const verified = summary.affiliate.payoutStatus === 'verified'
  const status = summary.affiliate.payoutStatus ?? 'unverified'

  const onboard = useCallback(async () => {
    setWorking(true)
    try {
      const res = await affiliateApi.onboardStripeConnect(http)
      if (!res.onboardUrl) return
      if (Platform.OS === 'web') {
        // The return_url (set server-side) brings the browser back to
        // /affiliate?connect=done, where the dashboard re-syncs status.
        if (typeof window !== 'undefined') window.open(res.onboardUrl, '_self')
        return
      }
      // Native: open the hosted onboarding page; when the in-app browser
      // is dismissed (completed or cancelled) re-sync the Connect status.
      await WebBrowser.openBrowserAsync(res.onboardUrl)
      await onChanged()
    } finally {
      setWorking(false)
    }
  }, [http, onChanged])

  return (
    <Card>
      <CardContent className="gap-2 p-4">
        <Text className="text-sm font-semibold text-foreground">Payout setup</Text>
        <Text className="text-xs text-muted-foreground">
          We pay commissions to a Stripe-connected bank account. Status: <Text className="text-foreground">{status}</Text>
        </Text>
        {!verified && (
          <Button variant="secondary" onPress={onboard} disabled={working}>
            <Text className="text-foreground text-sm">
              {working ? 'Loading…' : summary.affiliate.stripeCustomAccountId ? 'Resume payout setup' : 'Connect bank account'}
            </Text>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function Disclosure() {
  return (
    <Text className="text-[10px] text-muted-foreground text-center px-4 leading-4">
      FTC disclosure: when you share your link you must clearly disclose that
      you receive a commission from Shogo on qualifying signups. Self-referrals
      are not eligible. Commissions are subject to a refund hold period and may
      be reversed if the referred customer refunds or disputes the charge.
    </Text>
  )
}
