// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
  FlatList,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  ArrowLeft,
  Save,
  Send,
  AlertCircle,
  Check,
  Search,
  Bot,
  ChevronRight,
} from 'lucide-react-native'
import { useDomainHttp } from '../../../../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'

const CATEGORIES = [
  { value: 'personal', label: 'Personal' },
  { value: 'development', label: 'Development' },
  { value: 'business', label: 'Business' },
  { value: 'research', label: 'Research' },
  { value: 'operations', label: 'Operations' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'sales', label: 'Sales' },
] as const

const PRICING_MODELS = [
  { value: 'free', label: 'Free' },
  { value: 'one_time', label: 'One-time Purchase' },
  { value: 'subscription', label: 'Subscription' },
] as const

const INSTALL_MODELS = [
  { value: 'fork', label: 'Fork (independent copy)' },
  { value: 'linked', label: 'Linked (receives updates)' },
] as const

interface ListingForm {
  title: string
  shortDescription: string
  longDescription: string
  category: string
  tags: string
  pricingModel: string
  priceInCents: string
  monthlyPriceInCents: string
  installModel: string
}

interface ListingData {
  id: string
  title: string
  shortDescription: string
  longDescription: string
  category: string
  tags: string[]
  pricingModel: string
  priceInCents: number
  monthlyPriceInCents: number
  installModel: string
  status: string
  projectId: string
}

interface ProjectItem {
  id: string
  name: string
  description?: string | null
}

const INITIAL_FORM: ListingForm = {
  title: '',
  shortDescription: '',
  longDescription: '',
  category: 'personal',
  tags: '',
  pricingModel: 'free',
  priceInCents: '',
  monthlyPriceInCents: '',
  installModel: 'fork',
}

function centsToDisplay(cents: number): string {
  return cents > 0 ? (cents / 100).toFixed(2) : ''
}

function displayToCents(display: string): number {
  const n = parseFloat(display)
  return isNaN(n) ? 0 : Math.round(n * 100)
}

export default observer(function EditListingScreen() {
  const router = useRouter()
  const { id, projectId: initialProjectId } = useLocalSearchParams<{
    id: string
    projectId?: string
  }>()
  const http = useDomainHttp()

  const isNew = id === 'new'

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId ?? null,
  )
  const [showProjectPicker, setShowProjectPicker] = useState(
    isNew && !initialProjectId,
  )

  const [form, setForm] = useState<ListingForm>(INITIAL_FORM)
  const [existingStatus, setExistingStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const res = await http.get<{ items: ProjectItem[] }>('/api/projects')
      const raw = res.data
      const items = Array.isArray(raw) ? raw : (raw as any)?.items ?? []
      setProjects(items)
    } catch (err) {
      console.error('[ListingEditor] Failed to load projects:', err)
      setProjects([])
    } finally {
      setProjectsLoading(false)
    }
  }, [http])

  useEffect(() => {
    if (showProjectPicker) {
      loadProjects()
    }
  }, [showProjectPicker, loadProjects])

  const filteredProjects = projectSearch.trim()
    ? projects.filter(
        (p) =>
          p.name?.toLowerCase().includes(projectSearch.toLowerCase()) ||
          p.description?.toLowerCase().includes(projectSearch.toLowerCase()),
      )
    : projects

  const loadListing = useCallback(async () => {
    if (isNew) return
    setLoading(true)
    try {
      const res = await http.get<{ listings: ListingData[] }>(
        '/api/marketplace/creator/listings',
      )
      const items = res.data?.listings ?? res.data
      const list = Array.isArray(items) ? items : []
      const listing = list.find((l) => l.id === id)
      if (!listing) {
        setError('Listing not found')
        return
      }
      setExistingStatus(listing.status)
      setSelectedProjectId(listing.projectId)
      setForm({
        title: listing.title,
        shortDescription: listing.shortDescription || '',
        longDescription: listing.longDescription || '',
        category: listing.category || 'personal',
        tags: (listing.tags || []).join(', '),
        pricingModel: listing.pricingModel || 'free',
        priceInCents: centsToDisplay(listing.priceInCents),
        monthlyPriceInCents: centsToDisplay(listing.monthlyPriceInCents),
        installModel: listing.installModel || 'fork',
      })
    } catch {
      setError('Failed to load listing')
    } finally {
      setLoading(false)
    }
  }, [http, id, isNew])

  useEffect(() => {
    loadListing()
  }, [loadListing])

  const updateField = useCallback(
    (field: keyof ListingForm, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }))
      setError(null)
      setSuccess(null)
    },
    [],
  )

  const validate = useCallback((): string | null => {
    if (!form.title.trim()) return 'Title is required'
    if (!form.shortDescription.trim()) return 'Short description is required'
    if (form.shortDescription.length > 160)
      return 'Short description must be 160 characters or less'
    if (form.pricingModel === 'one_time' && !form.priceInCents)
      return 'Price is required for one-time purchases'
    if (form.pricingModel === 'subscription' && !form.monthlyPriceInCents)
      return 'Monthly price is required for subscriptions'
    if (isNew && !selectedProjectId)
      return 'Please select an agent to list'
    return null
  }, [form, isNew, selectedProjectId])

  const buildPayload = useCallback(() => {
    return {
      title: form.title.trim(),
      shortDescription: form.shortDescription.trim(),
      longDescription: form.longDescription.trim(),
      category: form.category,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      pricingModel: form.pricingModel,
      priceInCents:
        form.pricingModel === 'one_time'
          ? displayToCents(form.priceInCents)
          : 0,
      monthlyPriceInCents:
        form.pricingModel === 'subscription'
          ? displayToCents(form.monthlyPriceInCents)
          : 0,
      installModel: form.installModel,
      ...(isNew && selectedProjectId ? { projectId: selectedProjectId } : {}),
    }
  }, [form, isNew, selectedProjectId])

  const handleSave = useCallback(async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const payload = buildPayload()
      if (isNew) {
        const res = await http.post<{ listing: ListingData }>(
          '/api/marketplace/creator/listings',
          payload,
        )
        const created = res.data?.listing ?? res.data
        setSuccess('Listing created!')
        router.replace({
          pathname: '/(app)/marketplace/creator/listing/[id]',
          params: { id: (created as any).id },
        })
      } else {
        await http.patch(`/api/marketplace/creator/listings/${id}`, payload)
        setSuccess('Changes saved!')
      }
    } catch {
      setError('Failed to save listing')
    } finally {
      setSaving(false)
    }
  }, [validate, buildPayload, isNew, http, id, router])

  const handlePublish = useCallback(async () => {
    if (isNew || existingStatus !== 'draft') return
    setPublishing(true)
    setError(null)
    try {
      await http.post(`/api/marketplace/creator/listings/${id}/publish`, {})
      setExistingStatus('published')
      setSuccess('Listing published!')
    } catch {
      setError('Failed to publish listing')
    } finally {
      setPublishing(false)
    }
  }, [isNew, existingStatus, http, id])

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" className="text-muted-foreground" />
      </View>
    )
  }

  if (showProjectPicker) {
    return (
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 px-4 pt-3 pb-2">
          <Pressable onPress={() => router.back()} className="p-1">
            <ArrowLeft size={20} className="text-foreground" />
          </Pressable>
          <Text className="text-lg font-semibold text-foreground flex-1">
            Select an Agent
          </Text>
        </View>

        <Text className="px-4 text-sm text-muted-foreground mb-3">
          Choose which agent you want to publish on the marketplace.
        </Text>

        <View className="px-4 pb-3">
          <View className="flex-row items-center bg-card border border-input rounded-xl px-3 h-10">
            <Search size={16} className="text-muted-foreground" />
            <TextInput
              className="flex-1 ml-2 text-sm text-foreground web:outline-none"
              placeholder="Search your agents..."
              placeholderTextColor="#71717a"
              value={projectSearch}
              onChangeText={setProjectSearch}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </View>

        {projectsLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
            <Text className="text-muted-foreground mt-3 text-sm">
              Loading agents...
            </Text>
          </View>
        ) : filteredProjects.length === 0 ? (
          <View className="flex-1 items-center justify-center px-6">
            <Bot size={40} className="text-muted-foreground/40 mb-3" />
            <Text className="text-foreground font-medium mb-1">
              {projectSearch ? 'No matching agents' : 'No agents found'}
            </Text>
            <Text className="text-muted-foreground text-sm text-center">
              {projectSearch
                ? `No agents match "${projectSearch}"`
                : 'Create an agent first before publishing to the marketplace.'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredProjects}
            keyExtractor={(item) => item.id}
            contentContainerClassName="px-4 pb-8"
            ItemSeparatorComponent={() => <View className="h-2" />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  setSelectedProjectId(item.id)
                  setShowProjectPicker(false)
                  if (!form.title.trim()) {
                    setForm((prev) => ({
                      ...prev,
                      title: item.name || '',
                      shortDescription: item.description || '',
                    }))
                  }
                }}
                className="p-4 rounded-xl border border-border bg-card active:bg-muted flex-row items-center gap-3"
              >
                <View className="w-10 h-10 rounded-lg bg-primary/10 items-center justify-center">
                  <Bot size={20} className="text-primary" />
                </View>
                <View className="flex-1">
                  <Text
                    className="text-sm font-semibold text-foreground"
                    numberOfLines={1}
                  >
                    {item.name || 'Untitled Agent'}
                  </Text>
                  {item.description ? (
                    <Text
                      className="text-xs text-muted-foreground mt-0.5"
                      numberOfLines={2}
                    >
                      {item.description}
                    </Text>
                  ) : null}
                </View>
                <ChevronRight size={16} className="text-muted-foreground" />
              </Pressable>
            )}
          />
        )}
      </View>
    )
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View className="flex-row items-center gap-3 mb-6">
        <Pressable onPress={() => router.back()}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <Text className="text-xl font-bold text-foreground flex-1">
          {isNew ? 'New Listing' : 'Edit Listing'}
        </Text>
        {existingStatus && (
          <View
            className={cn(
              'px-2.5 py-1 rounded-full',
              existingStatus === 'published'
                ? 'bg-green-500/15'
                : 'bg-yellow-500/15',
            )}
          >
            <Text
              className={cn(
                'text-xs font-semibold capitalize',
                existingStatus === 'published'
                  ? 'text-green-700'
                  : 'text-yellow-700',
              )}
            >
              {existingStatus}
            </Text>
          </View>
        )}
      </View>

      {/* Feedback */}
      {error && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-lg bg-destructive/10">
          <AlertCircle size={16} className="text-destructive" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
      )}
      {success && (
        <View className="flex-row items-center gap-2 mb-4 px-4 py-3 rounded-lg bg-green-500/10">
          <Check size={16} className="text-green-700" />
          <Text className="text-sm text-green-700 flex-1">{success}</Text>
        </View>
      )}

      {/* Selected Agent (for new listings) */}
      {isNew && selectedProjectId && (
        <View className="mb-5">
          <FormField label="Agent">
            <Pressable
              onPress={() => setShowProjectPicker(true)}
              className="flex-row items-center gap-3 p-3 rounded-lg border border-primary/30 bg-primary/5"
            >
              <View className="w-8 h-8 rounded-md bg-primary/10 items-center justify-center">
                <Bot size={16} className="text-primary" />
              </View>
              <Text className="flex-1 text-sm font-medium text-foreground">
                {selectedProject?.name || selectedProjectId}
              </Text>
              <Text className="text-xs text-primary font-medium">Change</Text>
            </Pressable>
          </FormField>
        </View>
      )}

      {/* Title */}
      <FormField label="Title">
        <TextInput
          value={form.title}
          onChangeText={(v) => updateField('title', v)}
          placeholder="My Awesome Agent"
          placeholderTextColor="#9ca3af"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </FormField>

      {/* Short Description */}
      <FormField
        label="Short Description"
        hint={`${form.shortDescription.length}/160`}
      >
        <TextInput
          value={form.shortDescription}
          onChangeText={(v) => updateField('shortDescription', v)}
          placeholder="A brief summary of what this agent does"
          placeholderTextColor="#9ca3af"
          maxLength={160}
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </FormField>

      {/* Long Description */}
      <FormField label="Long Description">
        <TextInput
          value={form.longDescription}
          onChangeText={(v) => updateField('longDescription', v)}
          placeholder="Detailed description of your agent's capabilities, use cases, and setup instructions..."
          placeholderTextColor="#9ca3af"
          multiline
          numberOfLines={6}
          textAlignVertical="top"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm min-h-[120px]"
        />
      </FormField>

      {/* Category */}
      <FormField label="Category">
        <View className="flex-row flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <Pressable
              key={cat.value}
              onPress={() => updateField('category', cat.value)}
              className={cn(
                'px-3 py-2 rounded-lg border',
                form.category === cat.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  form.category === cat.value
                    ? 'text-primary'
                    : 'text-foreground',
                )}
              >
                {cat.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </FormField>

      {/* Tags */}
      <FormField label="Tags" hint="Comma-separated">
        <TextInput
          value={form.tags}
          onChangeText={(v) => updateField('tags', v)}
          placeholder="automation, productivity, sales"
          placeholderTextColor="#9ca3af"
          className="px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
        />
      </FormField>

      {/* Pricing Model */}
      <FormField label="Pricing">
        <View className="flex-row flex-wrap gap-2">
          {PRICING_MODELS.map((pm) => (
            <Pressable
              key={pm.value}
              onPress={() => updateField('pricingModel', pm.value)}
              className={cn(
                'px-3 py-2 rounded-lg border',
                form.pricingModel === pm.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card',
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  form.pricingModel === pm.value
                    ? 'text-primary'
                    : 'text-foreground',
                )}
              >
                {pm.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </FormField>

      {/* Price (one-time) */}
      {form.pricingModel === 'one_time' && (
        <FormField label="Price (USD)">
          <View className="flex-row items-center">
            <Text className="text-foreground text-sm font-medium mr-2">$</Text>
            <TextInput
              value={form.priceInCents}
              onChangeText={(v) => updateField('priceInCents', v)}
              placeholder="9.99"
              placeholderTextColor="#9ca3af"
              keyboardType="decimal-pad"
              className="flex-1 px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
            />
          </View>
        </FormField>
      )}

      {/* Monthly Price (subscription) */}
      {form.pricingModel === 'subscription' && (
        <FormField label="Monthly Price (USD)">
          <View className="flex-row items-center">
            <Text className="text-foreground text-sm font-medium mr-2">$</Text>
            <TextInput
              value={form.monthlyPriceInCents}
              onChangeText={(v) => updateField('monthlyPriceInCents', v)}
              placeholder="4.99"
              placeholderTextColor="#9ca3af"
              keyboardType="decimal-pad"
              className="flex-1 px-4 py-3 rounded-lg border border-border bg-card text-foreground text-sm"
            />
          </View>
        </FormField>
      )}

      {/* Install Model */}
      <FormField label="Install Model">
        <View className="gap-2">
          {INSTALL_MODELS.map((im) => (
            <Pressable
              key={im.value}
              onPress={() => updateField('installModel', im.value)}
              className={cn(
                'px-4 py-3 rounded-lg border flex-row items-center gap-3',
                form.installModel === im.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card',
              )}
            >
              <View
                className={cn(
                  'w-4 h-4 rounded-full border-2',
                  form.installModel === im.value
                    ? 'border-primary bg-primary'
                    : 'border-muted-foreground',
                )}
              />
              <Text
                className={cn(
                  'text-sm',
                  form.installModel === im.value
                    ? 'text-primary font-medium'
                    : 'text-foreground',
                )}
              >
                {im.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </FormField>

      {/* Action Buttons */}
      <View className="flex-row gap-3 mt-6">
        <Pressable
          onPress={handleSave}
          disabled={saving}
          className={cn(
            'flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl',
            saving ? 'bg-primary/60' : 'bg-primary',
          )}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Save size={16} color="#fff" />
              <Text className="text-sm font-semibold text-primary-foreground">
                {isNew ? 'Create' : 'Save'}
              </Text>
            </>
          )}
        </Pressable>

        {!isNew && existingStatus === 'draft' && (
          <Pressable
            onPress={handlePublish}
            disabled={publishing}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-2 py-3 rounded-xl border',
              publishing
                ? 'border-green-500/40 bg-green-500/5'
                : 'border-green-600 bg-green-600/10',
            )}
          >
            {publishing ? (
              <ActivityIndicator size="small" color="#16a34a" />
            ) : (
              <>
                <Send size={16} className="text-green-700" />
                <Text className="text-sm font-semibold text-green-700">
                  Publish
                </Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    </ScrollView>
  )
})

function FormField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <View className="mb-5">
      <View className="flex-row items-center justify-between mb-1.5">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        {hint && (
          <Text className="text-xs text-muted-foreground">{hint}</Text>
        )}
      </View>
      {children}
    </View>
  )
}
