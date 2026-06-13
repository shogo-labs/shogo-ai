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
  ShieldCheck, XCircle, Send,
} from 'lucide-react-native'
import { Card, CardContent, Button, Badge, Input } from '@shogo/shared-ui/primitives'
import { useDomainHttp } from '../../../contexts/domain'
import {
  affiliateApi,
  type AffiliateContentSummary,
  type AffiliateSocialAccount,
  type SocialPlatform,
} from '../../../lib/affiliate-api'
import { ContentAnalyticsPanel } from '../../../components/analytics/ContentAnalytics'

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
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

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

  const analyticsFetcher = useCallback(
    (range: { from: string; to: string }) => affiliateApi.getContentAnalytics(http, range),
    [http],
  )

  const applyToProgram = useCallback(async () => {
    setApplying(true)
    setApplyError(null)
    try {
      const res = await affiliateApi.applyContentProgram(http)
      if (res?.ok) {
        await load()
      } else {
        const code = res?.error?.code
        setApplyError(
          code === 'no_verified_account'
            ? 'Connect and verify at least one handle before applying.'
            : (res?.error?.message ?? 'Could not submit your application. Please try again.'),
        )
      }
    } catch (err: any) {
      const code = err?.body?.error?.code ?? err?.response?.body?.error?.code
      setApplyError(
        code === 'no_verified_account'
          ? 'Connect and verify at least one handle before applying.'
          : (err?.message ?? 'Could not submit your application. Please try again.'),
      )
    } finally {
      setApplying(false)
    }
  }, [http, load])

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
        ) : summary && summary.programStatus === 'pending' ? (
          <PendingReview summary={summary} />
        ) : summary ? (
          <>
            <ProgramStatusCard
              summary={summary}
              hasVerified={summary.accounts.some((a) => a.verificationStatus === 'verified')}
              applying={applying}
              applyError={applyError}
              onApply={applyToProgram}
            />
            <EarningsCard summary={summary} />
            {summary.programStatus === 'approved' ? (
              <ContentAnalyticsPanel fetcher={analyticsFetcher} />
            ) : null}
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
              The video-creator program is approval-only. Connect and verify a
              handle, then apply. Once an admin approves you and sets your CPM,
              new views are checked hourly and earnings are paid out manually
              with your other commissions.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

/**
 * Full-screen "under review" takeover shown while the creator's application is
 * pending. Replaces the earnings/handles/posts dashboard so it's unmistakable
 * that nothing earns yet — pull-to-refresh (owned by the parent ScrollView)
 * picks up an admin's decision.
 */
function PendingReview({ summary }: { summary: AffiliateContentSummary }) {
  const steps: { label: string; done: boolean }[] = [
    { label: 'Connect & verify a handle', done: true },
    { label: 'Submit your application', done: true },
    { label: 'Admin reviews your application', done: false },
    { label: 'Approved — start earning on new views', done: false },
  ]
  return (
    <View className="gap-5 pt-8">
      <View className="items-center gap-3">
        <View className="h-16 w-16 rounded-full bg-amber-500/10 items-center justify-center">
          <Clock size={30} className="text-amber-500" />
        </View>
        <Text className="text-xl font-semibold text-foreground text-center">Application under review</Text>
        <Text className="text-sm text-muted-foreground text-center max-w-sm leading-5">
          Thanks for applying to the video-creator program. An admin is reviewing
          your account{summary.appliedAt ? ` (applied ${new Date(summary.appliedAt).toLocaleDateString()})` : ''}.
          You'll start earning a CPM on new views as soon as you're approved.
        </Text>
        <Text className="text-xs text-muted-foreground text-center">Pull down to refresh.</Text>
      </View>

      <Card>
        <CardContent className="gap-3 p-4">
          <Text className="text-xs uppercase text-muted-foreground tracking-wide">What happens next</Text>
          {steps.map((s) => (
            <View key={s.label} className="flex-row items-center gap-2">
              {s.done ? (
                <CheckCircle2 size={16} className="text-emerald-500" />
              ) : (
                <Clock size={16} className="text-muted-foreground" />
              )}
              <Text className={s.done ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>
                {s.label}
              </Text>
            </View>
          ))}
        </CardContent>
      </Card>

      {summary.accounts.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs uppercase text-muted-foreground tracking-wide">Submitted handles</Text>
          {summary.accounts.map((a) => {
            const verified = a.verificationStatus === 'verified'
            return (
              <Card key={a.id}>
                <CardContent className="flex-row items-center gap-2 p-3">
                  <Text className="text-foreground font-medium capitalize">{a.platform}</Text>
                  <Text className="text-foreground">@{a.handle}</Text>
                  <View className="flex-1" />
                  <Badge variant={verified ? 'default' : 'secondary'}>
                    <View className="flex-row items-center gap-1">
                      {verified ? (
                        <CheckCircle2 size={12} className="text-primary-foreground" />
                      ) : (
                        <Clock size={12} className="text-foreground" />
                      )}
                      <Text className="text-xs">{verified ? 'Verified' : 'Pending'}</Text>
                    </View>
                  </Badge>
                </CardContent>
              </Card>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}

function ProgramStatusCard({
  summary, hasVerified, applying, applyError, onApply,
}: {
  summary: AffiliateContentSummary
  hasVerified: boolean
  applying: boolean
  applyError: string | null
  onApply: () => void
}) {
  const status = summary.programStatus ?? 'none'

  if (status === 'approved') {
    return (
      <Card>
        <CardContent className="flex-row items-center gap-3 p-4">
          <View className="h-9 w-9 rounded-full bg-emerald-500/10 items-center justify-center">
            <ShieldCheck size={18} className="text-emerald-500" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Approved creator</Text>
            <Text className="text-xs text-muted-foreground">
              Your handles are earning. Payouts are released manually by an admin.
            </Text>
          </View>
        </CardContent>
      </Card>
    )
  }

  if (status === 'pending') {
    return (
      <Card>
        <CardContent className="flex-row items-center gap-3 p-4">
          <View className="h-9 w-9 rounded-full bg-amber-500/10 items-center justify-center">
            <Clock size={18} className="text-amber-500" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">Application under review</Text>
            <Text className="text-xs text-muted-foreground">
              We're reviewing your creator application. You'll start earning on new
              views once an admin approves you{summary.appliedAt ? ` (applied ${new Date(summary.appliedAt).toLocaleDateString()})` : ''}.
            </Text>
          </View>
        </CardContent>
      </Card>
    )
  }

  // none | rejected → apply / re-apply CTA.
  const rejected = status === 'rejected'
  return (
    <Card>
      <CardContent className="gap-3 p-4">
        <View className="flex-row items-center gap-2">
          {rejected ? (
            <XCircle size={16} className="text-red-500" />
          ) : (
            <ShieldCheck size={16} className="text-primary" />
          )}
          <Text className="text-sm font-semibold text-foreground">
            {rejected ? 'Application not approved' : 'Apply to the video-creator program'}
          </Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          {rejected
            ? 'Your previous application was not approved. You can update your handles and re-apply.'
            : 'Earn a CPM on new views of content you post. Connect and verify at least one handle, then apply — an admin reviews every creator and sets your CPM before earning begins.'}
        </Text>
        {rejected && summary.rejectionReason ? (
          <View className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
            <Text className="text-[11px] text-red-600">Reason: {summary.rejectionReason}</Text>
          </View>
        ) : null}
        {!hasVerified ? (
          <View className="flex-row items-start gap-2">
            <AlertTriangle size={14} className="text-yellow-500 mt-0.5" />
            <Text className="text-xs text-muted-foreground flex-1">
              Connect and verify a handle below before you can apply.
            </Text>
          </View>
        ) : null}
        {applyError ? (
          <View className="flex-row items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5" />
            <Text className="text-xs text-foreground flex-1">{applyError}</Text>
          </View>
        ) : null}
        <Button onPress={onApply} disabled={applying || !hasVerified}>
          {applying ? (
            <ActivityIndicator />
          ) : (
            <View className="flex-row items-center gap-2">
              <Send size={14} className="text-primary-foreground" />
              <Text className="text-primary-foreground font-medium">
                {rejected ? 'Re-apply' : 'Apply to earn'}
              </Text>
            </View>
          )}
        </Button>
      </CardContent>
    </Card>
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
          {summary.perVideoCapCents != null ? (
            <Badge variant="secondary">
              <Text className="text-xs">
                ${(summary.perVideoCapCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}/video cap
              </Text>
            </Badge>
          ) : null}
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
