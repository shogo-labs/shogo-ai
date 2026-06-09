// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Affiliate content-CPM screen.
 *
 * Lets an enrolled affiliate connect Instagram / TikTok handles, prove
 * ownership by placing a one-time code in their bio, and watch per-post
 * views + CPM earnings. Earnings roll into the same balance as referral
 * commissions (they are AffiliateCommission rows, source=content), so
 * payouts happen through the existing Stripe Connect flow on the main
 * affiliate dashboard.
 *
 * All data comes from /api/affiliates/me/content and the
 * /api/affiliates/me/social-accounts endpoints. A 503 means the
 * content-CPM feature flag is off for this region.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Platform,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import {
  ArrowLeft, AlertTriangle, CheckCircle2, Clock, Copy, Trash2, Eye,
} from 'lucide-react-native'
import { Card, CardContent, Button, Badge, Input } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import {
  affiliateApi,
  type AffiliateContentSummary,
  type AffiliateSocialAccount,
  type SocialPlatform,
} from '../../../lib/affiliate-api'

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function describeAddError(code: string): string {
  switch (code) {
    case 'invalid_platform': return 'Pick Instagram or TikTok.'
    case 'invalid_handle': return 'Enter a valid handle (letters, numbers, dot, underscore).'
    case 'handle_taken': return 'That handle is already connected by another affiliate.'
    case 'not_enrolled': return 'Join the affiliate program first.'
    case 'feature_disabled': return 'Content earnings are not available in your region yet.'
    case 'provider_not_configured': return 'View tracking is temporarily unavailable. Try later.'
    default: return 'Could not connect that handle. Please try again.'
  }
}

export default function AffiliateContentScreen() {
  const router = useRouter()
  const http = useDomainHttp()

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [summary, setSummary] = useState<AffiliateContentSummary | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const [platform, setPlatform] = useState<SocialPlatform>('tiktok')
  const [handle, setHandle] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErrorMsg(null)
    try {
      const res = await affiliateApi.getContent(http)
      setSummary(res)
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      if (status === 503) {
        setErrorMsg('Content earnings are not available in your region yet.')
      } else {
        setErrorMsg(err?.message ?? 'Failed to load content earnings.')
      }
      setSummary(null)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [http])

  useEffect(() => { load() }, [load])

  const addHandle = useCallback(async () => {
    const trimmed = handle.trim().replace(/^@+/, '')
    if (!trimmed) {
      setAddError('Enter a handle.')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const res = await affiliateApi.addSocialAccount(http, { platform, handle: trimmed })
      if (res?.ok) {
        setHandle('')
        await load()
      } else {
        setAddError(describeAddError(res?.error?.code ?? 'unknown'))
      }
    } catch (err: any) {
      const code = err?.body?.error?.code ?? err?.response?.body?.error?.code
      setAddError(describeAddError(code ?? 'unknown'))
    } finally {
      setAdding(false)
    }
  }, [handle, platform, http, load])

  const verify = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await affiliateApi.verifySocialAccount(http, id)
      await load()
    } finally {
      setBusyId(null)
    }
  }, [http, load])

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await affiliateApi.removeSocialAccount(http, id)
      await load()
    } finally {
      setBusyId(null)
    }
  }, [http, load])

  const copyCode = useCallback(async (account: AffiliateSocialAccount) => {
    await Clipboard.setStringAsync(account.verificationCode)
    setCopiedId(account.id)
    setTimeout(() => setCopiedId(null), 1500)
  }, [])

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="text-lg font-semibold text-foreground">Content earnings</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={
          Platform.OS !== 'web' ? (
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load() }} />
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
        ) : summary ? (
          <>
            <EarningsCard summary={summary} />
            <AddHandleCard
              platform={platform}
              setPlatform={setPlatform}
              handle={handle}
              setHandle={setHandle}
              adding={adding}
              addError={addError}
              onAdd={addHandle}
            />
            <View className="gap-2">
              <Text className="text-xs uppercase text-muted-foreground tracking-wide">Connected accounts</Text>
              {summary.accounts.length === 0 ? (
                <Text className="text-sm text-muted-foreground">No handles connected yet.</Text>
              ) : (
                summary.accounts.map((a) => (
                  <AccountCard
                    key={a.id}
                    account={a}
                    busy={busyId === a.id}
                    copied={copiedId === a.id}
                    onVerify={() => verify(a.id)}
                    onRemove={() => remove(a.id)}
                    onCopyCode={() => copyCode(a)}
                  />
                ))
              )}
            </View>

            {summary.posts.length > 0 ? (
              <View className="gap-2">
                <Text className="text-xs uppercase text-muted-foreground tracking-wide">Tracked posts</Text>
                {summary.posts.slice(0, 25).map((p) => (
                  <PostRow key={p.id} post={p} />
                ))}
              </View>
            ) : null}

            <Text className="text-[10px] text-muted-foreground text-center px-4 leading-4">
              You earn a CPM on new views of content you post after connecting a
              verified handle. Views are checked hourly; earnings are held for a
              short review window, then paid out with your other commissions.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

function EarningsCard({ summary }: { summary: AffiliateContentSummary }) {
  const { totals } = summary
  return (
    <Card>
      <CardContent className="gap-1 p-5">
        <Text className="text-xs uppercase text-muted-foreground tracking-wide">Content earnings (pending)</Text>
        <Text className="text-3xl font-bold text-foreground">{dollars(totals.pendingCents)}</Text>
        <Text className="text-sm text-muted-foreground">
          Approved {dollars(totals.approvedCents)} · Paid {dollars(totals.paidCents)}
        </Text>
        <View className="flex-row gap-2 mt-2">
          <Badge variant="secondary"><Text className="text-xs">{compactNumber(totals.lifetimeViews)} views</Text></Badge>
          <Badge variant="secondary"><Text className="text-xs">{totals.posts} posts</Text></Badge>
          <Badge variant="secondary"><Text className="text-xs">${(summary.cpmCents.tiktok / 100).toFixed(2)}/1k</Text></Badge>
        </View>
      </CardContent>
    </Card>
  )
}

function AddHandleCard({
  platform, setPlatform, handle, setHandle, adding, addError, onAdd,
}: {
  platform: SocialPlatform
  setPlatform: (p: SocialPlatform) => void
  handle: string
  setHandle: (h: string) => void
  adding: boolean
  addError: string | null
  onAdd: () => void
}) {
  return (
    <Card>
      <CardContent className="gap-3 p-4">
        <Text className="text-sm font-semibold text-foreground">Connect a handle</Text>
        <View className="flex-row gap-2">
          {(['tiktok', 'instagram'] as SocialPlatform[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => setPlatform(p)}
              className={`flex-1 rounded-md border px-3 py-2 items-center ${platform === p ? 'bg-primary border-primary' : 'border-border'}`}
            >
              <Text className={platform === p ? 'text-primary-foreground text-sm capitalize' : 'text-foreground text-sm capitalize'}>{p}</Text>
            </Pressable>
          ))}
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-medium text-muted-foreground">@</Text>
          <Input
            className="flex-1"
            value={handle}
            onChangeText={setHandle}
            placeholder="yourhandle"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {addError ? (
          <View className="flex-row items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5" />
            <Text className="text-xs text-foreground flex-1">{addError}</Text>
          </View>
        ) : null}
        <Button onPress={onAdd} disabled={adding}>
          {adding ? <ActivityIndicator /> : <Text className="text-primary-foreground font-medium">Connect</Text>}
        </Button>
      </CardContent>
    </Card>
  )
}

function AccountCard({
  account, busy, copied, onVerify, onRemove, onCopyCode,
}: {
  account: AffiliateSocialAccount
  busy: boolean
  copied: boolean
  onVerify: () => void
  onRemove: () => void
  onCopyCode: () => void
}) {
  const verified = account.verificationStatus === 'verified'
  return (
    <Card>
      <CardContent className="gap-2 p-4">
        <View className="flex-row items-center gap-2">
          <Text className="text-foreground font-medium capitalize">{account.platform}</Text>
          <Text className="text-foreground">@{account.handle}</Text>
          <View className="flex-1" />
          <Badge variant={verified ? 'default' : 'secondary'}>
            <View className="flex-row items-center gap-1">
              {verified ? <CheckCircle2 size={12} className="text-primary-foreground" /> : <Clock size={12} className="text-foreground" />}
              <Text className="text-xs">{verified ? 'Verified' : 'Pending'}</Text>
            </View>
          </Badge>
        </View>

        {!verified ? (
          <View className="gap-2">
            <Text className="text-xs text-muted-foreground">
              Add this code to your {account.platform} bio, then tap Verify. You
              can remove it from your bio once you're verified.
            </Text>
            <Pressable onPress={onCopyCode} className="flex-row items-center gap-2 rounded-md border border-border px-3 py-2">
              <Text className="text-foreground text-sm flex-1">{account.verificationCode}</Text>
              <Copy size={14} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">{copied ? 'Copied' : 'Copy'}</Text>
            </Pressable>
            {account.lastError ? (
              <Text className="text-[11px] text-yellow-600">{account.lastError}</Text>
            ) : null}
            <View className="flex-row gap-2">
              <Button variant="secondary" onPress={onVerify} disabled={busy} className="flex-1">
                {busy ? <ActivityIndicator /> : <Text className="text-foreground text-sm">Verify</Text>}
              </Button>
              <Pressable onPress={onRemove} disabled={busy} hitSlop={8} className="px-3 py-2 items-center justify-center">
                <Trash2 size={16} className="text-red-500" />
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-xs text-muted-foreground flex-1">
                {account.lastPolledAt ? `Last checked ${new Date(account.lastPolledAt).toLocaleDateString()}` : 'Awaiting first check'}
              </Text>
              <Pressable onPress={onRemove} disabled={busy} hitSlop={8}>
                <Trash2 size={16} className="text-red-500" />
              </Pressable>
            </View>
            <Text className="text-[11px] text-muted-foreground">
              You're verified — you can now remove the shogo-… code from your {account.platform} bio.
            </Text>
          </View>
        )}
      </CardContent>
    </Card>
  )
}

function PostRow({ post }: { post: AffiliateContentSummary['posts'][number] }) {
  return (
    <Card>
      <CardContent className="flex-row items-center gap-3 p-3">
        <Eye size={16} className="text-muted-foreground" />
        <View className="flex-1">
          <Text className="text-foreground text-sm" numberOfLines={1}>
            {post.caption?.trim() || post.url || post.providerPostId}
          </Text>
          <Text className="text-[11px] text-muted-foreground capitalize">
            {post.platform} · {compactNumber(post.paidViews)} of {compactNumber(post.lastViews)} views paid
          </Text>
        </View>
        <Text className="text-foreground font-semibold">{compactNumber(post.lastViews)}</Text>
      </CardContent>
    </Card>
  )
}
