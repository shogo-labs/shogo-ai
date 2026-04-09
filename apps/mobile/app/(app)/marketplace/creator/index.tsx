// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  DollarSign,
  Download,
  Star,
  Clock,
  Plus,
  Shield,
  Award,
  ChevronRight,
  AlertCircle,
  Info,
} from 'lucide-react-native'
import { useAuth } from '../../../../contexts/auth'
import { useDomainHttp } from '../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'

interface CreatorProfile {
  id: string
  userId: string
  displayName: string
  creatorTier: string
  reputationScore: number
  payoutStatus: string
  totalEarningsInCents: number
  pendingPayoutInCents: number
  totalInstalls: number
  averageAgentRating: number
  createdAt: string
}

interface DashboardAPIResponse {
  profile: CreatorProfile
  totalReviews: number
  listings: DashboardListing[]
}

interface DashboardListing {
  id: string
  slug: string
  title: string
  status: string
  installCount: number
  averageRating: number
  reviewCount: number
  totalEarningsInCents: number
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

function payoutColor(status: string): string {
  if (status === 'verified') return 'bg-green-500'
  if (status === 'pending') return 'bg-yellow-500'
  return 'bg-gray-400'
}

function payoutLabel(status: string): string {
  if (status === 'verified') return 'Verified'
  if (status === 'pending') return 'Pending Verification'
  return 'Not Set Up'
}

export default observer(function CreatorDashboardScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()

  const [profile, setProfile] = useState<CreatorProfile | null>(null)
  const [dashboardListings, setDashboardListings] = useState<DashboardListing[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const profileRes = await http.get<{ profile: CreatorProfile }>(
        '/api/marketplace/creator/profile'
      )
      const prof = profileRes.data.profile
      setProfile(prof)
      setHasProfile(true)

      const dashboardRes = await http.get<DashboardAPIResponse>(
        '/api/marketplace/creator/dashboard'
      )
      setDashboardListings(dashboardRes.data.listings ?? [])
    } catch (err: any) {
      if (err?.status === 404 || err?.message?.includes('not found')) {
        setHasProfile(false)
      } else {
        setError('Failed to load creator dashboard')
      }
    } finally {
      setLoading(false)
    }
  }, [http])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleBecomeCreator = useCallback(async () => {
    if (!user?.name) return
    setCreating(true)
    setError(null)
    try {
      await http.post<{ profile: CreatorProfile }>(
        '/api/marketplace/creator/profile',
        { displayName: user.name }
      )
      await loadData()
    } catch {
      setError('Failed to create creator profile')
    } finally {
      setCreating(false)
    }
  }, [http, user?.name, loadData])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" className="text-muted-foreground" />
      </View>
    )
  }

  if (hasProfile === false) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-4 pt-6 pb-4">
          <Pressable onPress={() => router.back()}>
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <Text className="text-xl font-bold text-foreground">
            Creator Program
          </Text>
        </View>
        <View className="flex-1 items-center justify-center px-6">
          <Award size={56} className="text-primary mb-4" />
          <Text className="text-2xl font-bold text-foreground mb-2 text-center">
            Become a Creator
          </Text>
          <Text className="text-muted-foreground text-center mb-8 leading-6">
            Share your agents with the community and earn revenue from
            installations. Set up your creator profile to get started.
          </Text>
          {error && (
            <View className="flex-row items-center gap-2 mb-4 px-4 py-2 rounded-lg bg-destructive/10">
              <AlertCircle size={16} className="text-destructive" />
              <Text className="text-sm text-destructive">{error}</Text>
            </View>
          )}
          <Pressable
            onPress={handleBecomeCreator}
            disabled={creating}
            className={cn(
              'px-8 py-3 rounded-xl',
              creating ? 'bg-primary/60' : 'bg-primary'
            )}
          >
            {creating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text className="text-base font-semibold text-primary-foreground">
                Get Started
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable onPress={() => router.back()}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-xl font-bold text-foreground">
            Creator Dashboard
          </Text>
        </View>
      </View>

      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-lg bg-destructive/10">
          <AlertCircle size={16} className="text-destructive" />
          <Text className="text-sm text-destructive">{error}</Text>
        </View>
      )}

      {/* Tier & Reputation */}
      {profile && (
        <View className="flex-row items-center gap-3 mb-6 px-4 py-3 rounded-xl border border-border bg-card">
          <Shield size={20} className="text-primary" />
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {tierLabel(profile.creatorTier)} Creator
            </Text>
            <Text className="text-xs text-muted-foreground">
              Reputation: {profile.reputationScore}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <View
              className={cn('w-2 h-2 rounded-full', payoutColor(profile.payoutStatus))}
            />
            <Text className="text-xs text-muted-foreground">
              {payoutLabel(profile.payoutStatus)}
            </Text>
          </View>
        </View>
      )}

      {/* Payout setup CTA */}
      {profile?.payoutStatus === 'not_setup' && (
        <Pressable
          onPress={() =>
            router.push('/(app)/marketplace/creator/payout-setup')
          }
          className="flex-row items-center gap-3 mb-6 px-4 py-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5"
        >
          <AlertCircle size={18} className="text-yellow-600" />
          <View className="flex-1">
            <Text className="text-sm font-medium text-foreground">
              Set up payouts
            </Text>
            <Text className="text-xs text-muted-foreground">
              Add your bank details to receive earnings
            </Text>
          </View>
          <ChevronRight size={16} className="text-muted-foreground" />
        </Pressable>
      )}

      {/* Stats Grid */}
      {profile && (
        <View className="flex-row flex-wrap gap-3 mb-6">
          <StatCard
            icon={DollarSign}
            label="Total Earnings"
            value={formatCents(profile.totalEarningsInCents)}
            color="text-green-600"
            info="Total revenue earned across all your listings after platform fees."
          />
          <StatCard
            icon={Clock}
            label="Pending Payout"
            value={formatCents(profile.pendingPayoutInCents)}
            color="text-yellow-600"
            info="Earnings that have not yet been transferred to your bank account."
          />
          <StatCard
            icon={Download}
            label="Total Installs"
            value={String(profile.totalInstalls)}
            color="text-blue-600"
            info="Combined number of times your agents have been installed."
          />
          <StatCard
            icon={Star}
            label="Average Rating"
            value={
              profile.averageAgentRating > 0
                ? profile.averageAgentRating.toFixed(1)
                : '—'
            }
            color="text-orange-500"
            info="Average star rating across all your published agents."
          />
        </View>
      )}

      {/* My Listings */}
      <View className="mb-4 flex-row items-center justify-between">
        <Text className="text-lg font-bold text-foreground">My Listings</Text>
        <Pressable
          onPress={() =>
            router.push({
              pathname: '/(app)/marketplace/creator/listing/[id]',
              params: { id: 'new' },
            })
          }
          className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary"
        >
          <Plus size={14} color="#fff" />
          <Text className="text-xs font-semibold text-primary-foreground">
            New Listing
          </Text>
        </Pressable>
      </View>

      {dashboardListings.length > 0 ? (
        <View className="gap-3">
          {dashboardListings.map((listing) => (
            <Pressable
              key={listing.id}
              onPress={() =>
                router.push({
                  pathname: '/(app)/marketplace/creator/listing/[id]',
                  params: { id: listing.id },
                })
              }
              className="p-4 rounded-xl border border-border bg-card"
            >
              <View className="flex-row items-center justify-between mb-2">
                <Text
                  className="text-sm font-semibold text-foreground flex-1 mr-2"
                  numberOfLines={1}
                >
                  {listing.title}
                </Text>
                <View
                  className={cn(
                    'px-2 py-0.5 rounded-full',
                    listing.status === 'published'
                      ? 'bg-green-500/15'
                      : listing.status === 'draft'
                        ? 'bg-yellow-500/15'
                        : 'bg-red-500/15'
                  )}
                >
                  <Text
                    className={cn(
                      'text-[10px] font-semibold capitalize',
                      listing.status === 'published'
                        ? 'text-green-700'
                        : listing.status === 'draft'
                          ? 'text-yellow-700'
                          : 'text-red-700'
                    )}
                  >
                    {listing.status === 'archived' ? 'Unlisted' : listing.status}
                  </Text>
                </View>
              </View>
              <View className="flex-row items-center gap-4">
                <View className="flex-row items-center gap-1">
                  <Download size={12} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {listing.installCount}
                  </Text>
                </View>
                <View className="flex-row items-center gap-1">
                  <Star size={12} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">
                    {listing.averageRating > 0
                      ? listing.averageRating.toFixed(1)
                      : '—'}
                  </Text>
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View className="items-center py-12 rounded-xl border border-dashed border-border">
          <Plus size={32} className="text-muted-foreground mb-2 opacity-50" />
          <Text className="text-sm text-muted-foreground text-center">
            No listings yet. Create your first one!
          </Text>
        </View>
      )}
    </ScrollView>
  )
})

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  info,
}: {
  icon: any
  label: string
  value: string
  color: string
  info?: string
}) {
  return (
    <View className="flex-1 min-w-[140px] p-4 rounded-xl border border-border bg-card">
      <Icon size={18} className={color} />
      <Text className="text-xl font-bold text-foreground mt-2">{value}</Text>
      <Text className="text-xs text-muted-foreground mt-0.5">{label}</Text>
      {info && (
        <Text className="text-[10px] text-muted-foreground/70 mt-1 leading-3">{info}</Text>
      )}
    </View>
  )
}
